import fs from "node:fs/promises";
import path from "node:path";
import { createProvider } from "./llm.js";
import { detectBoxes, inpaintBoxes } from "./scrub-py.js";
import { translateBoxes } from "./translate.js";
import { renderText } from "./render.js";

/**
 * 1. detect   — RT-DETR-v2 finds bubbles + text boxes (py/scrub.py detect)
 * 2. translate — Gemini OCRs + translates every box in one batched call
 * 3. inpaint  — manga LaMa erases only boxes that OCR confirmed hold text
 * 4. render   — typeset English into the bubble the detector found
 */
export const translateStrip = async (inputPath, outputPath, { sourceLang, glossary, provider: providerName, model, debugJson, keepWork = false, log = console.error } = {}) => {
  const provider = createProvider({ provider: providerName, model });
  log(`llm: ${provider.name} / ${provider.model}`);
  const base = path.basename(inputPath, path.extname(inputPath));
  const workDir = path.join(path.dirname(outputPath), ".work");
  await fs.mkdir(workDir, { recursive: true });

  const t0 = Date.now();
  const lap = (label, since) => log(`${label} ${((Date.now() - since) / 1000).toFixed(1)}s`);
  const boxes = await detectBoxes(inputPath, path.join(workDir, `${base}.boxes.json`), { log });
  lap("detect", t0);
  const t1 = Date.now();
  await translateBoxes(inputPath, boxes, { sourceLang, glossary, provider, log });
  lap("translate", t1);
  // An empty translation for real text means "unchanged" (names, logos): keep the original.
  for (const b of boxes) if (b.original && !b.translation && b.role !== "credit") b.translation = b.original;
  const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  // Text that translates to itself (logos, Latin names, brand signs) is left exactly as drawn.
  // Signs (shop names, plates, title logos) are in-world artwork: left as drawn.
  const withText = boxes.filter((b) => b.original && b.role !== "sign" && (b.role === "credit" || norm(b.original) !== norm(b.translation)));
  // The model over-applies "credit" (it tagged a character name label); only
  // trust it when the text actually looks like a site/credit line.
  const CREDIT = /https?:|www\.|\.(net|com|org|xyz|io|me|tv|kr|es|co)\b|@|scan|translat|typeset|raw provider/i;
  for (const b of withText) if (b.role === "credit" && !CREDIT.test(b.original)) b.role = "sign";
  const usable = withText.filter((b) => b.role !== "credit" && b.translation);
  log(`${withText.length}/${boxes.length} detection(s) contain text, ${withText.length - usable.length} credit/watermark(s) erased`);
  if (debugJson) await fs.writeFile(debugJson, JSON.stringify(boxes, null, 2));

  const scrubbedPath = path.join(workDir, `${base}.scrubbed.png`);
  const t2 = Date.now();
  await inpaintBoxes(inputPath, scrubbedPath, withText, { maskPath: keepWork ? path.join(workDir, `${base}.mask.png`) : undefined, log });
  lap("inpaint", t2);

  const t3 = Date.now();
  const rendered = await renderText(await fs.readFile(scrubbedPath), usable);
  lap("render", t3);
  await fs.writeFile(outputPath, rendered);
  if (!keepWork) await fs.rm(workDir, { recursive: true, force: true });
  return usable;
};
