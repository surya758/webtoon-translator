"""
Detect text + bubbles in a webtoon strip and erase the text.

  python scrub.py detect  <in.png> <boxes.json> [--threshold 0.45]
  python scrub.py inpaint <in.png> <out.png> <boxes.json> [--mask mask.png]
  python scrub.py serve   [--threads 4]     # persistent worker, JSON lines on stdin

`serve` keeps both models loaded and handles one job per line:
  {"id":1,"op":"detect","input":..,"boxes_json":..,"threshold":0.3}
  {"id":2,"op":"inpaint","input":..,"output":..,"boxes_json":..,"mask":null}
answering {"id":1,"ok":true} or {"id":1,"error":"..."} on stdout. Loading the
detector and LaMa costs several seconds per process, which was paid twice for
EVERY page when each step was its own subprocess — and several such processes
at once oversubscribed the CPU and could crash torch. One worker per core
group, kept alive, is what makes batch translation fast.

`inpaint` erases only the boxes listed in boxes.json, so the caller can
first confirm with OCR which detections actually contain text (the detector
occasionally fires on window grids, patterns, etc.).

Detection:  RT-DETR-v2 (ogkalu/comic-text-and-bubble-detector), ONNX.
            Classes: 0 bubble, 1 text_bubble, 2 text_free.
            Tall strips are cut into ~square overlapping windows so the
            640x640 resize doesn't crush the aspect ratio; detections are
            merged with NMS.
Inpainting: anime-manga-big-lama.pt (TorchScript LaMa fine-tuned on
            manga/anime), run per mask component on a padded crop.
Output:     scrubbed PNG + JSON list of text boxes with the bubble that
            contains each one (used downstream for typesetting).
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

MODELS = Path(__file__).parent / "models"
DETECTOR = MODELS / "detector.onnx"
LAMA = MODELS / "anime-manga-big-lama.pt"

BUBBLE, TEXT_BUBBLE, TEXT_FREE = 0, 1, 2


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- detection

def nms(boxes, scores, iou_thr=0.5):
    if not len(boxes):
        return []
    b = np.asarray(boxes, dtype=np.float32)
    x1, y1, x2, y2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = np.argsort(scores)[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[1:][iou < iou_thr]
    return keep


_sess = None
_threads = None


def detector_session():
    """One ONNX session per process. `_threads` caps intra-op parallelism so
    several workers can share the machine instead of each grabbing every core."""
    global _sess
    if _sess is None:
        opts = ort.SessionOptions()
        if _threads:
            opts.intra_op_num_threads = _threads
            opts.inter_op_num_threads = 1
        _sess = ort.InferenceSession(str(DETECTOR), sess_options=opts, providers=["CPUExecutionProvider"])
    return _sess


def detect(img_rgb, threshold=0.3):
    sess = detector_session()
    H, W = img_rgb.shape[:2]
    # square-ish windows, 20% overlap
    win = W
    step = int(win * 0.8)
    tops = list(range(0, max(1, H - win + 1), step))
    if not tops or tops[-1] + win < H:
        tops.append(max(0, H - win))
    dets = []  # (label, score, x1, y1, x2, y2)
    for top in tops:
        crop = img_rgb[top : top + win]
        ch, cw = crop.shape[:2]
        inp = cv2.resize(crop, (640, 640), interpolation=cv2.INTER_LINEAR)
        inp = inp.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        labels, boxes, scores = sess.run(
            None, {"images": inp, "orig_target_sizes": np.array([[cw, ch]], dtype=np.int64)}
        )
        labels, boxes, scores = labels.reshape(-1), boxes.reshape(-1, 4), scores.reshape(-1)
        for lab, box, sc in zip(labels, boxes, scores):
            if sc < threshold:
                continue
            x1, y1, x2, y2 = box
            dets.append((int(lab), float(sc), float(x1), float(y1) + top, float(x2), float(y2) + top))
    bubbles = [d for d in dets if d[0] == BUBBLE]
    bubbles = [bubbles[i] for i in nms([d[2:] for d in bubbles], [d[1] for d in bubbles])]
    # text: class-agnostic NMS (the model often fires both text classes on one
    # region); a survivor inherits TEXT_BUBBLE if any suppressed twin had it.
    texts = [d for d in dets if d[0] != BUBBLE]
    keep = nms([d[2:] for d in texts], [d[1] for d in texts], iou_thr=0.4)
    merged = []
    for i in keep:
        cls, sc, x1, y1, x2, y2 = texts[i]
        for j, t in enumerate(texts):
            if j != i and t[0] == TEXT_BUBBLE and _iou(t[2:], (x1, y1, x2, y2)) >= 0.4:
                cls = TEXT_BUBBLE
        merged.append((cls, sc, x1, y1, x2, y2))
    # drop boxes that sit mostly inside a larger text box (a single line the
    # model also fired on separately) — IoU NMS doesn't catch those
    final = []
    for a in merged:
        if any(b is not a and _area(b) > _area(a) and _contained(a[2:], b[2:]) >= 0.7 for b in merged):
            continue
        final.append(a)
    return bubbles + final


def _area(d):
    return (d[4] - d[2]) * (d[5] - d[3])


def _contained(a, b):
    """fraction of a's area inside b"""
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + 1e-6)


def _iou(a, b):
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-6)


# ---------------------------------------------------------------- inpainting

_lama = None


def lama_model():
    global _lama
    if _lama is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        _lama = torch.jit.load(str(LAMA), map_location="cpu").eval().to(device)
        _lama.device = device
    return _lama


def pad_mod(arr, mod=8):
    h, w = arr.shape[:2]
    ph, pw = (mod - h % mod) % mod, (mod - w % mod) % mod
    if arr.ndim == 3:
        return np.pad(arr, ((0, ph), (0, pw), (0, 0)), mode="reflect")
    return np.pad(arr, ((0, ph), (0, pw)), mode="reflect")


def lama_inpaint(img_rgb, mask):
    """img_rgb uint8 HxWx3, mask uint8 HxW (255 = fill). Returns uint8 HxWx3."""
    model = lama_model()
    h, w = mask.shape
    img = pad_mod(img_rgb.astype(np.float32) / 255.0)
    m = pad_mod((mask > 127).astype(np.float32))
    it = torch.from_numpy(img.transpose(2, 0, 1))[None].to(model.device)
    mt = torch.from_numpy(m)[None, None].to(model.device)
    with torch.inference_mode():
        out = model(it, mt)[0].permute(1, 2, 0).cpu().numpy()
    out = np.clip(out * 255, 0, 255).astype(np.uint8)[:h, :w]
    # composite: only masked pixels change
    m3 = (mask > 127)[..., None]
    return np.where(m3, out, img_rgb)


def inpaint_components(img_rgb, mask, margin=64):
    """Run LaMa on a crop around each connected mask component (fast, and the
    model sees enough context to reconstruct shading)."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 127).astype(np.uint8), connectivity=8)
    out = img_rgb.copy()
    H, W = mask.shape
    for i in range(1, n):
        x, y, w, h, _ = stats[i]
        x1, y1 = max(0, x - margin), max(0, y - margin)
        x2, y2 = min(W, x + w + margin), min(H, y + h + margin)
        sub_mask = np.where(labels[y1:y2, x1:x2] == i, 255, 0).astype(np.uint8)
        out[y1:y2, x1:x2] = lama_inpaint(out[y1:y2, x1:x2], sub_mask)
    return out


# ---------------------------------------------------------------- mask

def stroke_mask(rgb_region, dilate_px=4):
    """Letter pixels only: anything that departs from a median-filtered
    background in ANY colour channel (a translucent red watermark on grey is
    invisible in luminance but obvious in the red channel). Closing fills
    letter interiors that the median smooths over."""
    k = 31
    diff = np.zeros(rgb_region.shape[:2], np.uint8)
    for c in range(3):
        ch = rgb_region[..., c]
        diff = np.maximum(diff, cv2.absdiff(ch, cv2.medianBlur(ch, k)))
    m = (diff > 16).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    return cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilate_px * 2 + 1,) * 2))


def bubble_mask(rgb_region, box_h):
    """Text inside a bubble: pixels that contrast with the bubble's fill
    (median of the region's border ring), dilated by about a third of the
    line height so anti-alias halos and JPEG ringing go too. Unlike a full
    rectangle this never reaches a panel border or the bubble outline, which
    LaMa would otherwise 'continue' straight through the bubble."""
    gray = cv2.cvtColor(rgb_region, cv2.COLOR_RGB2GRAY)
    ring = np.concatenate([gray[0], gray[-1], gray[:, 0], gray[:, -1]])
    bg = np.median(ring)
    m = (np.abs(gray.astype(np.int16) - bg) > 40).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    k = int(max(13, min(box_h * 0.35, 41))) | 1
    return cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))


def text_mask(img_rgb, boxes, pad_frac=0.15, min_pad=6):
    """Bubble text: dilated letter strokes inside the padded box.
    Free text over artwork: tighter stroke mask (colour-aware) so the art
    under and around the letters survives."""
    H, W = img_rgb.shape[:2]
    mask = np.zeros((H, W), np.uint8)
    for b in boxes:
        free = b.get("kind") == "free"
        pf = 0.06 if free else pad_frac
        pw, ph = max(min_pad, b["w"] * pf), max(min_pad, b["h"] * pf)
        x1, y1 = int(max(0, b["x"] - pw)), int(max(0, b["y"] - ph))
        x2, y2 = int(min(W, b["x"] + b["w"] + pw)), int(min(H, b["y"] + b["h"] + ph))
        if x2 <= x1 or y2 <= y1:
            continue
        region = img_rgb[y1:y2, x1:x2]
        local = stroke_mask(region) if free else bubble_mask(region, b["h"])
        mask[y1:y2, x1:x2] = np.maximum(mask[y1:y2, x1:x2], local)
    return mask


# ---------------------------------------------------------------- main

def containing_bubble(tb, bubbles):
    x1, y1, x2, y2 = tb
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    best, best_area = None, None
    for _, _, bx1, by1, bx2, by2 in bubbles:
        if bx1 <= cx <= bx2 and by1 <= cy <= by2:
            area = (bx2 - bx1) * (by2 - by1)
            if best is None or area < best_area:
                best, best_area = (bx1, by1, bx2, by2), area
    return best


def rect(x1, y1, x2, y2):
    return {"x": int(round(x1)), "y": int(round(y1)), "w": int(round(x2 - x1)), "h": int(round(y2 - y1))}


def cmd_detect(args):
    img = np.array(Image.open(args.input).convert("RGB"))
    H, W = img.shape[:2]
    dets = detect(img, args.threshold)
    bubbles = [d for d in dets if d[0] == BUBBLE]
    texts = [d for d in dets if d[0] in (TEXT_BUBBLE, TEXT_FREE)]
    log(f"detected {len(bubbles)} bubble(s), {len(texts)} text region(s)")
    out_boxes = []
    for cls, sc, x1, y1, x2, y2 in sorted(texts, key=lambda d: (d[3], d[2])):
        bub = containing_bubble((x1, y1, x2, y2), bubbles)
        out_boxes.append({**rect(x1, y1, x2, y2), "kind": "bubble" if (cls == TEXT_BUBBLE or bub) else "free",
                          "score": round(sc, 3), "container": rect(*bub) if bub else None})
    Path(args.boxes_json).write_text(json.dumps({"width": W, "height": H, "boxes": out_boxes}, indent=2))


def cmd_inpaint(args):
    img = np.array(Image.open(args.input).convert("RGB"))
    boxes = json.loads(Path(args.boxes_json).read_text())
    boxes = boxes["boxes"] if isinstance(boxes, dict) else boxes
    mask = text_mask(img, boxes)
    if args.mask:
        Image.fromarray(mask).save(args.mask)
    log(f"inpainting {len(boxes)} region(s)…")
    Image.fromarray(inpaint_components(img, mask)).save(args.output)
    log(f"wrote {args.output}")


class _Job:
    """argparse-shaped view over a JSON job, so the cmd_* functions serve both modes."""
    def __init__(self, d):
        self.input = d.get("input"); self.output = d.get("output"); self.boxes_json = d.get("boxes_json")
        self.threshold = float(d.get("threshold", 0.3)); self.mask = d.get("mask")


def cmd_serve(args):
    global _threads
    _threads = args.threads
    if args.threads:
        torch.set_num_threads(args.threads)
    # Warm both models up front — and run each once on dummy input, because the first
    # inference of a session is the slow one (kernel selection, MPS graph compile) and
    # otherwise the first page on every worker pays for it.
    sess = detector_session()
    sess.run(None, {"images": np.zeros((1, 3, 640, 640), np.float32),
                    "orig_target_sizes": np.array([[640, 640]], dtype=np.int64)})
    lama_inpaint(np.zeros((64, 64, 3), np.uint8), np.full((64, 64), 255, np.uint8))
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            op = job.get("op")
            if op == "detect":
                cmd_detect(_Job(job))
            elif op == "inpaint":
                cmd_inpaint(_Job(job))
            else:
                raise ValueError(f"unknown op {op!r}")
            print(json.dumps({"id": job.get("id"), "ok": True}), flush=True)
        except Exception as e:  # one bad page must not take the worker down
            log(f"job failed: {e!r}")
            print(json.dumps({"id": job.get("id") if isinstance(job, dict) else None, "error": str(e)}), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("detect"); d.add_argument("input"); d.add_argument("boxes_json")
    d.add_argument("--threshold", type=float, default=0.3); d.set_defaults(fn=cmd_detect)
    i = sub.add_parser("inpaint"); i.add_argument("input"); i.add_argument("output"); i.add_argument("boxes_json")
    i.add_argument("--mask"); i.set_defaults(fn=cmd_inpaint)
    s = sub.add_parser("serve"); s.add_argument("--threads", type=int, default=0); s.set_defaults(fn=cmd_serve)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
