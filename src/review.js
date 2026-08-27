import sharp from "sharp";

/**
 * Self-review: show the model each typeset bubble from the RENDERED page and
 * ask what's wrong. Overflow / unreadable → the block is re-rendered smaller;
 * a clear mistranslation with a suggested fix → the line is replaced.
 * One extra call per page; enabled with --review.
 */
const SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "integer" },
      issue: { type: "string", enum: ["overflow", "unreadable", "mistranslation", "ok"] },
      fix: { type: "string" },
    },
    required: ["id", "issue"],
  },
};

const PROMPT = (n) => `You are the QA letterer for an English webtoon release.
Each of the ${n} numbered crops shows one typeset English text block on the finished page. For each, report:
- "overflow"      — the text touches or crosses the bubble/box outline, or is clipped;
- "unreadable"    — too small, wrong colour against the background, or otherwise hard to read;
- "mistranslation" — the English is clearly wrong or unnatural for a published comic (give the corrected line in "fix", same length or shorter);
- "ok"            — nothing wrong.
Be strict about overflow and colour, lenient about style. Return one entry per crop, ids 1..${n}.`;

const reviewRegion = (box, width, height) => {
  const c = box.container && box.container.w * box.container.h <= box.w * box.h * 8 ? box.container : { x: box.x - box.w * 0.25, y: box.y - box.h * 0.4, w: box.w * 1.5, h: box.h * 1.8 };
  const pad = 12;
  const x = Math.max(0, Math.round(c.x - pad)), y = Math.max(0, Math.round(c.y - pad));
  return { x, y, w: Math.min(width - x, Math.round(c.w + pad * 2)), h: Math.min(height - y, Math.round(c.h + pad * 2)) };
};

/** Returns the boxes that need a second render (mutated in place with scale / translation). */
export const reviewRender = async (renderedBuffer, boxes, { provider, log = () => {} }) => {
  if (!boxes.length) return [];
  const image = sharp(renderedBuffer);
  const { width, height } = await image.metadata();
  const parts = [];
  for (const [i, box] of boxes.entries()) {
    const r = reviewRegion(box, width, height);
    if (r.w < 8 || r.h < 8) continue;
    parts.push({ text: `Crop ${i + 1} (English: "${box.translation.replace(/\s+/g, " ")}"):` });
    parts.push({ image: { mimeType: "image/png", data: await image.clone().extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png().toBuffer() } });
  }
  parts.push({ text: PROMPT(boxes.length) });
  const items = await provider.generateJSON({ parts, schema: SCHEMA, temperature: 0 });

  const changed = [];
  for (const it of items) {
    const box = boxes[it.id - 1];
    if (!box || it.issue === "ok") continue;
    if (it.issue === "overflow" || it.issue === "unreadable") {
      box.scale = (box.scale ?? 1) * 0.85;
      changed.push(box);
      log(`review: #${it.id} ${it.issue} → shrink to ${Math.round(box.scale * 100)}%`);
    } else if (it.issue === "mistranslation" && it.fix?.trim() && it.fix.trim() !== box.translation) {
      log(`review: #${it.id} "${box.translation}" → "${it.fix.trim()}"`);
      box.translation = it.fix.trim();
      changed.push(box);
    }
  }
  return changed;
};
