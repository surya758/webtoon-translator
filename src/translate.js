import sharp from "sharp";
import { createProvider } from "./llm.js";

const SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "integer" },
      original: { type: "string" },
      translation: { type: "string" },
      speaker: { type: "string" },
      role: { type: "string", enum: ["dialogue", "thought", "caption", "sfx", "sign", "credit"] },
    },
    required: ["id", "original", "translation", "role"],
  },
};

const PROMPT = (n, sourceLang, glossary) => `You are a professional webtoon localizer.
The first image is a full comic page for context. It is followed by ${n} numbered crops, each containing exactly one piece of text from that page, in reading order.
For EVERY crop return: id (the crop number), the exact original text${sourceLang ? ` (source language: ${sourceLang})` : ""}, and a natural English translation.
Translate like a published English webtoon: casual, punchy, matching tone and register (swearing stays swearing, formal stays formal). Keep honorifics only where they matter.
Keep each translation compact enough to fit in the original's bubble. Use the page image and neighbouring lines for context (who is speaking, gender, continuity).
role: "dialogue"/"thought" for speech, "caption" for narration boxes, "sfx" for sound effects (give the English onomatopoeia), "sign" for in-world text, "credit" for translator/scanlation watermarks, site URLs or upload credits (these will be erased, not translated).
If a crop truly contains no text, return an empty original and translation.
${glossary ? `Use these names/terms consistently:\n${glossary}\n` : ""}Return one entry per crop, ids 1..${n}.`;

/** Crop a box with some breathing room so glyphs aren't clipped. */
const cropBox = async (image, box, width, height) => {
  const px = Math.round(box.w * 0.1) + 4, py = Math.round(box.h * 0.15) + 4;
  const left = Math.max(0, box.x - px), top = Math.max(0, box.y - py);
  const w = Math.min(width - left, box.w + px * 2), h = Math.min(height - top, box.h + py * 2);
  return image.clone().extract({ left, top, width: w, height: h }).png().toBuffer();
};

/**
 * OCR + translate every detected box with one Gemini call per batch.
 * The full page (downscaled) is sent for context; each box is sent as its
 * own crop so the OCR is exact. Mutates boxes in place adding original /
 * translation / speaker.
 */
export const translateBoxes = async (imagePath, boxes, { sourceLang, glossary, provider = createProvider(), batchSize = 40, log = () => {} } = {}) => {
  if (!boxes.length) return boxes;
  const image = sharp(imagePath);
  const { width, height } = await image.metadata();
  const context = await image.clone().resize({ width: Math.min(width, 1024), height: 4096, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();

  for (let start = 0; start < boxes.length; start += batchSize) {
    const batch = boxes.slice(start, start + batchSize);
    const parts = [{ text: "Full page for context:" }, { image: { mimeType: "image/jpeg", data: context } }];
    for (const [i, box] of batch.entries()) {
      parts.push({ text: `Crop ${i + 1}:` });
      parts.push({ image: { mimeType: "image/png", data: await cropBox(image, box, width, height) } });
    }
    parts.push({ text: PROMPT(batch.length, sourceLang, glossary) });

    const items = await provider.generateJSON({ parts, schema: SCHEMA, temperature: 0 });
    for (const it of items) {
      const box = batch[it.id - 1];
      if (!box) continue;
      box.original = it.original?.trim() ?? "";
      box.translation = it.translation?.trim() ?? "";
      box.role = it.role;
      if (it.speaker) box.speaker = it.speaker;
    }
    log(`translated ${Math.min(start + batch.length, boxes.length)}/${boxes.length}`);
  }
  return boxes;
};
