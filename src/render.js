import sharp from "sharp";
import fs from "node:fs";
import opentype from "opentype.js";

const FONT_CANDIDATES = [
  process.env.FONT_PATH,
  "/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
].filter(Boolean);
// glyphs the comic font lacks (♡ ★ …) come from these
const FALLBACK_CANDIDATES = [
  process.env.FALLBACK_FONT_PATH,
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Apple Symbols.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
].filter(Boolean);

const parseFont = (path) => {
  const b = fs.readFileSync(path);
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
let fonts;
const loadFonts = () => {
  if (fonts) return fonts;
  const main = FONT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!main) throw new Error("No font found; set FONT_PATH to a .ttf");
  const fb = FALLBACK_CANDIDATES.find((p) => fs.existsSync(p));
  fonts = { main: parseFont(main), fallback: fb ? parseFont(fb) : null };
  return fonts;
};

/** Split text into runs by which font can draw each char. */
const runs = (text) => {
  const { main, fallback } = loadFonts();
  const out = [];
  for (const ch of text) {
    const inMain = main.charToGlyphIndex(ch) > 0 || ch === " ";
    const font = inMain || !fallback ? main : fallback;
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += ch;
    else out.push({ font, text: ch });
  }
  return out;
};

const measure = (text, size) => runs(text).reduce((w, r) => w + r.font.getAdvanceWidth(r.text, size), 0);

const pathData = (text, x, y, size) => {
  let d = "", cx = x;
  for (const r of runs(text)) {
    d += r.font.getPath(r.text, cx, y, size).toPathData(2);
    cx += r.font.getAdvanceWidth(r.text, size);
  }
  return d;
};

/** Greedy word wrap using real advance widths. */
const wrap = (text, size, maxWidth) => {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, size) > maxWidth && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
};

/** Largest font size whose wrapped lines fit inside w×h. */
/**
 * `shape`: "rect" — block must fit in w×h; "ellipse" — w×h is the ellipse's
 * axes and the block fits when (bw/w)² + (bh/h)² ≤ 1 (with a little margin).
 */
const fit = (text, w, h, { maxSize, minSize = 9, lineHeight = 1.15, shape = "rect" }) => {
  const ok = (bw, bh) => (shape === "ellipse" ? (bw / w) ** 2 + (bh / h) ** 2 <= 0.88 : bw <= w && bh <= h);
  const fits = [];
  for (let size = maxSize; size >= minSize; size -= 1) {
    // wrap width: for an ellipse, the widest a block of this many lines can be
    let lines = wrap(text, size, w);
    if (shape === "ellipse") {
      const bh = lines.length * size * lineHeight;
      const maxW = w * Math.sqrt(Math.max(0, 0.88 - (bh / h) ** 2));
      lines = wrap(text, size, maxW);
    }
    const bw = Math.max(...lines.map((l) => measure(l, size)));
    if (ok(bw, lines.length * size * lineHeight)) fits.push({ size, lines });
  }
  if (!fits.length) return { size: minSize, lines: wrap(text, minSize, w) };
  // Letterers prefer fewer lines: take the fewest-line layout among those
  // that keep at least 82% of the largest size that fits.
  const floor = fits[0].size * 0.82;
  return fits.filter((f) => f.size >= floor).reduce((best, f) => (f.lines.length < best.lines.length ? f : best), fits[0]);
};

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The bubble's real interior: flood from the middle of the (now erased) text
 * over pixels close to the fill colour there, bounded by the container box.
 * Returns the flooded area's bounding box + centroid in image coordinates,
 * or null when the flood doesn't look like a bubble (too small / hit the
 * whole box, i.e. the seed wasn't on a fill colour).
 */
const bubbleInterior = async (image, container, box, width, height) => {
  const seedX = box.x + box.w / 2, seedY = box.y + box.h / 2;
  // Bound the flood to this text's neighbourhood inside the bubble box, so a
  // multi-lobed bubble centres each line in its own lobe.
  const local = { x: box.x - box.w * 0.9, y: box.y - box.h * 1.4, w: box.w * 2.8, h: box.h * 3.8 };
  const bx = Math.max(container.x, local.x), by = Math.max(container.y, local.y);
  const bx2 = Math.min(container.x + container.w, local.x + local.w), by2 = Math.min(container.y + container.h, local.y + local.h);
  const x0 = Math.max(0, Math.round(bx)), y0 = Math.max(0, Math.round(by));
  const w = Math.min(width - x0, Math.round(bx2 - bx)), h = Math.min(height - y0, Math.round(by2 - by));
  if (w < 4 || h < 4) return null;
  const { data, info } = await image.clone().extract({ left: x0, top: y0, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = luminance(data[i * ch], data[i * ch + 1], data[i * ch + 2]);
  const sx = Math.min(w - 1, Math.max(0, Math.round(seedX - x0))), sy = Math.min(h - 1, Math.max(0, Math.round(seedY - y0)));
  // seed value: median of a small patch (robust to a stray pixel)
  const patch = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = sx + dx, y = sy + dy;
    if (x >= 0 && x < w && y >= 0 && y < h) patch.push(L[y * w + x]);
  }
  patch.sort((a, b) => a - b);
  const seed = patch[patch.length >> 1];
  const tol = 28;
  const flood = (ok, startX, startY) => {
    const seen = new Uint8Array(w * h);
    const start = startY * w + startX;
    if (!ok(start)) return seen;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && ok(j)) { seen[j] = 1; stack.push(j); }
      }
    }
    return seen;
  };
  const fill = flood((i) => Math.abs(L[i] - seed) <= tol, sx, sy);
  // Erode by R so thin leaks (gaps between burst lines, hairline outline
  // breaks) detach, then re-flood from the seed to keep only the main body.
  const R = 5;
  const eroded = new Uint8Array(w * h);
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
    let all = 1;
    for (let dy = -R; dy <= R && all; dy++) for (let dx = -R; dx <= R; dx++) if (!fill[(y + dy) * w + x + dx]) { all = 0; break; }
    eroded[y * w + x] = all;
  }
  // seed may sit on the erased text where erosion holds; if not, find the nearest eroded pixel
  let ex = sx, ey = sy;
  if (!eroded[ey * w + ex]) {
    let best = Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (eroded[y * w + x]) {
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < best) { best = d; ex = x; ey = y; }
    }
    if (best === Infinity) return null;
  }
  const seen = flood((i) => eroded[i] === 1, ex, ey);
  let n = 0, sumX = 0, sumY = 0, minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (seen[y * w + x]) {
    n++; sumX += x; sumY += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  // restore the eroded margin for the reported extents
  minX = Math.max(0, minX - R); minY = Math.max(0, minY - R); maxX = Math.min(w - 1, maxX + R); maxY = Math.min(h - 1, maxY + R);
  const area = (maxX - minX + 1) * (maxY - minY + 1);
  if (n < 300 || n < area * 0.3) return null; // not bubble-shaped
  // widest span through the centroid row/column — better than the bbox for tailed bubbles
  const cy = Math.round(sumY / n), cx = Math.round(sumX / n);
  let left = cx, right = cx, top = cy, bottom = cy;
  while (left > 0 && fill[cy * w + left - 1]) left--;
  while (right < w - 1 && fill[cy * w + right + 1]) right++;
  while (top > 0 && fill[(top - 1) * w + cx]) top--;
  while (bottom < h - 1 && fill[(bottom + 1) * w + cx]) bottom++;
  // how much of its bounding box the (un-eroded) fill covers: ellipse ≈ 0.79, rectangle ≈ 1
  let filled = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (fill[y * w + x]) filled++;
  return {
    cx: x0 + cx, cy: y0 + cy,
    spanW: right - left + 1, spanH: bottom - top + 1,
    bbox: { x: x0 + minX, y: y0 + minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    rectLike: filled / area > 0.93,
    dark: seed < 128,
  };
};

/** Median luminance of a rect — decides text colour when there's no bubble. */
const regionLuminance = async (image, r) => {
  const { data, info } = await image.clone().extract({ left: r.x, top: r.y, width: r.w, height: r.h }).raw().toBuffer({ resolveWithObject: true });
  const ls = [];
  for (let i = 0; i < data.length; i += info.channels * 7) ls.push(luminance(data[i], data[i + 1], data[i + 2]));
  ls.sort((a, b) => a - b);
  return ls[ls.length >> 1] ?? 255;
};

const clampRect = (r, width, height) => {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  return { x, y, w: Math.max(1, Math.min(width - x, Math.round(r.w))), h: Math.max(1, Math.min(height - y, Math.round(r.h))) };
};

export const renderText = async (buffer, boxes, { pad = 4 } = {}) => {
  const { main } = loadFonts();
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  const composites = [];
  for (const box of boxes) {
    const text = box.translation.replace(/\s*\n\s*/g, " ").trim().toUpperCase();
    if (!text) continue;

    // Estimate the original font size from box area and character count
    // (chars ≈ (w / 0.55·size) · (h / 1.2·size)); never exceed it by much.
    const chars = Math.max(1, box.original.replace(/\s+/g, "").length);
    const sizeOrig = Math.sqrt((box.w * box.h) / (0.66 * chars));
    const maxSize = Math.max(10, Math.min(64, Math.round(Math.min(sizeOrig * 1.15, box.h))));

    // Where to put it: centred in the real bubble interior when we can find
    // one; otherwise centred on the original text, grown for English.
    const c = box.container;
    const plausible = c && c.w * c.h <= box.w * box.h * 8 && c.w >= box.w * 0.9 && c.h >= box.h * 0.9;
    const interior = plausible ? await bubbleInterior(image, c, box, width, height) : null;

    let cx, cy, availW, availH, dark, shape = "rect";
    if (interior) {
      cx = interior.cx; cy = interior.cy; dark = interior.dark;
      if (interior.rectLike) {
        availW = interior.bbox.w * 0.86; availH = interior.bbox.h * 0.8;
      } else {
        // treat the bubble as the ellipse spanned through its centroid
        shape = "ellipse";
        availW = Math.min(interior.spanW, interior.bbox.w); availH = Math.min(interior.spanH, interior.bbox.h);
      }
    } else {
      cx = box.x + box.w / 2; cy = box.y + box.h / 2;
      availW = box.w * 1.3; availH = box.h * 1.4;
      dark = (await regionLuminance(image, clampRect({ x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }, width, height))) < 128;
    }

    // emphasis: shouts get up to +20% size; box.scale lets a review pass shrink a block
    const scale = (box.scale ?? 1) * (box.emphasis === "shout" ? 1.2 : 1);
    const { size, lines } = fit(text, availW * Math.min(1, scale), availH * Math.min(1, scale), { maxSize: Math.round(maxSize * scale), shape });
    const lh = size * 1.15;
    const blockW = Math.max(...lines.map((l) => measure(l, size)));
    const blockH = lines.length * lh;
    const region = clampRect({ x: cx - blockW / 2 - pad, y: cy - blockH / 2 - pad, w: blockW + pad * 2, h: blockH + pad * 2 }, width, height);

    const color = dark ? "#ffffff" : "#111111";
    const ascent = (main.ascender / main.unitsPerEm) * size;
    const descent = (-main.descender / main.unitsPerEm) * size;
    const startY = pad + (lh - (ascent + descent)) / 2 + ascent;
    // bold/shout: thicken with a same-colour stroke; italic: skew the whole block
    const heavy = box.emphasis === "bold" || box.emphasis === "shout";
    const paths = lines
      .map((l, i) => pathData(l, (region.w - measure(l, size)) / 2, startY + i * lh, size))
      .map((d) => box.kind === "free"
        ? `<path d="${d}" fill="${color}" stroke="${dark ? "#111111" : "#ffffff"}" stroke-width="${Math.max(2, size * 0.12)}" stroke-linejoin="round" paint-order="stroke"/>`
        : heavy
          ? `<path d="${d}" fill="${color}" stroke="${color}" stroke-width="${(size * 0.055).toFixed(2)}" stroke-linejoin="round"/>`
          : `<path d="${d}" fill="${color}"/>`)
      .join("");
    const skew = box.emphasis === "italic" ? ` transform="translate(${(region.h * 0.11).toFixed(1)} 0) skewX(-12)"` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${region.w}" height="${region.h}"><g${skew}>${paths}</g></svg>`;
    composites.push({ input: Buffer.from(svg), left: region.x, top: region.y });
  }
  return composites.length ? image.composite(composites).png().toBuffer() : buffer;
};
