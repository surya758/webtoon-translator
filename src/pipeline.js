import fs from "node:fs/promises";
import path from "node:path";
import { createProvider } from "./llm.js";
import { detectBoxes, inpaintBoxes } from "./scrub-py.js";
import { translateBoxes } from "./translate.js";
import { renderText } from "./render.js";
import { Cache, sha } from "./cache.js";
import { Series } from "./series.js";

const CREDIT = /https?:|www\.|\.(net|com|org|xyz|io|me|tv|kr|es|co)\b|@|scan|translat|typeset|raw provider/i;
const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 1. detect    — RT-DETR-v2 finds bubbles + text boxes         [cached by image]
 * 2. translate — LLM OCRs + translates every box, with series context
 *                                                              [cached by image + model + context]
 * 3. inpaint   — manga LaMa erases only boxes that hold text   [cached by image + erased boxes]
 * 4. render    — typeset English into the bubble the detector found
 * 5. learn     — (with --series) update glossary / character sheet / recent lines
 */
export const translateStrip = async (inputPath, outputPath, {
  sourceLang, glossary, provider: providerName, model, series: seriesFile, cache: cacheOpt,
  debugJson, keepWork = false, log = console.error,
} = {}) => {
  const provider = createProvider({ provider: providerName, model });
  const cache = Cache.fromEnv(cacheOpt);
  const series = await Series.load(seriesFile);
  log(`llm: ${provider.name} / ${provider.model}${series ? `  series: ${seriesFile}` : ""}${cache ? `  cache: ${cache.dir}` : ""}`);

  const base = path.basename(inputPath, path.extname(inputPath));
  const workDir = path.join(path.dirname(outputPath), ".work");
  await fs.mkdir(workDir, { recursive: true });
  const lap = (label, since, extra = "") => log(`${label} ${((Date.now() - since) / 1000).toFixed(1)}s${extra}`);

  const imageBytes = await fs.readFile(inputPath);
  const ihash = sha(imageBytes);

  // 1. detect
  let t = Date.now();
  const boxesKey = `${ihash}.boxes.json`;
  let boxes = cache ? await cache.getJSON(boxesKey) : null;
  if (boxes) lap("detect", t, " (cached)");
  else {
    boxes = await detectBoxes(inputPath, path.join(workDir, `${base}.boxes.json`), { log });
    if (cache) await cache.putJSON(boxesKey, boxes);
    lap("detect", t);
  }

  // 2. translate
  t = Date.now();
  const context = series?.contextBlock({ exclude: base }) || undefined;
  const tkey = `${ihash}.${sha(JSON.stringify({ p: provider.name, m: provider.model, l: sourceLang ?? "", g: glossary ?? "", c: series?.fingerprint({ exclude: base }) ?? "" }))}.translate.json`;
  const cachedT = cache ? await cache.getJSON(tkey) : null;
  if (cachedT && cachedT.length === boxes.length) {
    boxes.forEach((b, i) => Object.assign(b, cachedT[i]));
    lap("translate", t, " (cached)");
  } else {
    await translateBoxes(inputPath, boxes, { sourceLang, glossary, context, provider, log });
    if (cache) await cache.putJSON(tkey, boxes.map(({ original, translation, role, speaker }) => ({ original, translation, role, speaker })));
    lap("translate", t);
  }

  // decide what gets erased / rendered
  for (const b of boxes) if (b.original && !b.translation && b.role !== "credit") b.translation = b.original;
  const withText = boxes.filter((b) => b.original && b.role !== "sign" && (b.role === "credit" || norm(b.original) !== norm(b.translation)));
  for (const b of withText) if (b.role === "credit" && !CREDIT.test(b.original)) b.role = "sign";
  const usable = withText.filter((b) => b.role !== "credit" && b.translation);
  log(`${withText.length}/${boxes.length} detection(s) contain text, ${withText.length - usable.length} credit/watermark(s) erased`);
  if (debugJson) await fs.writeFile(debugJson, JSON.stringify(boxes, null, 2));

  // 3. inpaint
  t = Date.now();
  const scrubbedPath = path.join(workDir, `${base}.scrubbed.png`);
  const eraseKey = `${ihash}.${sha(JSON.stringify(withText.map((b) => [b.x, b.y, b.w, b.h, b.kind])))}.scrubbed.png`;
  if (cache && (await cache.has(eraseKey))) {
    await fs.copyFile(cache.file(eraseKey), scrubbedPath);
    lap("inpaint", t, " (cached)");
  } else {
    await inpaintBoxes(inputPath, scrubbedPath, withText, { maskPath: keepWork ? path.join(workDir, `${base}.mask.png`) : undefined, log });
    if (cache) await cache.putFile(eraseKey, scrubbedPath);
    lap("inpaint", t);
  }

  // 4. render
  t = Date.now();
  const rendered = await renderText(await fs.readFile(scrubbedPath), usable);
  await fs.writeFile(outputPath, rendered);
  lap("render", t);

  // 5. learn
  if (series) {
    t = Date.now();
    series.remember(base, boxes);
    const learned = await series.learn(provider, boxes, { sourceLang });
    await series.save();
    lap("learn", t, ` (+${learned.glossary} glossary, +${learned.characters} characters)`);
  }

  if (!keepWork) await fs.rm(workDir, { recursive: true, force: true });
  return usable;
};
