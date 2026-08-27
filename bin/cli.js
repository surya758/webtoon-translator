#!/usr/bin/env node
import "dotenv/config";
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { translateStrip } from "../src/pipeline.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    lang: { type: "string", short: "l" },
    glossary: { type: "string", short: "g" },
    json: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    provider: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    series: { type: "string", short: "s" },
    "no-cache": { type: "boolean", default: false },
    review: { type: "boolean", default: false },
    cache: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !positionals.length) {
  console.log(`Usage: webtoon-translate <image> [--out out.png] [--lang ko] [--glossary terms.txt] [--json]

  --out       output path (default: out/<name>.en.png)
  --lang      source language hint (ko, ja, zh, ...)
  --glossary  text file of names/terms to keep consistent
  --json      also write detected regions to out/<name>.json
  --provider  vertex | gemini | openai   (default: auto-detect from credentials)
  --model     model id for the provider  (defaults: gemini-3.5-flash-lite / gpt-5-mini)
  --series    series memory JSON (glossary, character voices, recent lines) — created if missing,
              read before translating, updated after
  --review    second pass: the model inspects the typeset page and overflow/unreadable
              blocks are re-rendered smaller, clear mistranslations corrected (+1 call)
  --cache     cache dir (default ~/.cache/webtoon-translator or $CACHE_DIR); --no-cache to disable
  --keep      keep out/.work (scrubbed image, detector boxes, inpaint mask)`);
  process.exit(positionals.length ? 0 : 1);
}

const input = positionals[0];
const base = path.basename(input, path.extname(input));
const out = values.out ?? path.join("out", `${base}.en.png`);
await fs.mkdir(path.dirname(out), { recursive: true });
const glossary = values.glossary ? await fs.readFile(values.glossary, "utf8") : undefined;

const boxes = await translateStrip(input, out, {
  sourceLang: values.lang,
  glossary,
  keepWork: values.keep,
  provider: values.provider,
  model: values.model,
  series: values.series,
  review: values.review,
  cache: values["no-cache"] ? false : values.cache,
  debugJson: values.json ? path.join(path.dirname(out), `${base}.json`) : undefined,
});
for (const b of boxes) console.log(`[${b.kind}] ${b.original}  →  ${b.translation}`);
console.log(`\nwrote ${out}`);
// The scrub workers are long-lived by design; the CLI is not.
process.exit(0);
