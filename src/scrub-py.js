import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "py");
const PYTHON = process.env.SCRUB_PYTHON || path.join(PY_DIR, ".venv", "bin", "python");

const run = (args, log) =>
  new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(PY_DIR, "scrub.py"), ...args], { stdio: ["ignore", "inherit", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; for (const line of String(d).trim().split("\n")) log(`[py] ${line}`); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`scrub.py exited ${code}\n${err.slice(-2000)}`))));
  });

/** RT-DETR-v2: returns [{x,y,w,h,kind,score,container}] in reading order. */
export const detectBoxes = async (inputPath, boxesPath, { threshold = 0.3, log = () => {} } = {}) => {
  await run(["detect", inputPath, boxesPath, "--threshold", String(threshold)], log);
  return JSON.parse(await fs.readFile(boxesPath, "utf8")).boxes;
};

/** Manga LaMa: erases exactly the given boxes; writes outputPath. */
export const inpaintBoxes = async (inputPath, outputPath, boxes, { maskPath, log = () => {} } = {}) => {
  const boxesPath = outputPath.replace(/\.png$/, ".erase.json");
  await fs.writeFile(boxesPath, JSON.stringify(boxes));
  const args = ["inpaint", inputPath, outputPath, boxesPath];
  if (maskPath) args.push("--mask", maskPath);
  await run(args, log);
};
