import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

/**
 * Content-addressed cache so the expensive halves are paid once per image:
 *   <hash>.boxes.json               detector output          (image)
 *   <hash>.<erase>.scrubbed.png     LaMa output              (image + which boxes were erased)
 *   <hash>.<tkey>.translate.json    OCR + translation        (image + provider/model/lang/context)
 * Re-running with a new model, prompt, font or target language only redoes
 * the part whose key changed.
 */
export const sha = (data) => createHash("sha256").update(data).digest("hex").slice(0, 20);

export class Cache {
  constructor(dir) {
    this.dir = dir;
  }
  static fromEnv(opt) {
    if (opt === false) return null;
    const dir = opt || process.env.CACHE_DIR || path.join(os.homedir(), ".cache", "webtoon-translator");
    return new Cache(dir);
  }
  file(key) {
    return path.join(this.dir, key);
  }
  async has(key) {
    try { await fs.access(this.file(key)); return true; } catch { return false; }
  }
  async getJSON(key) {
    try { return JSON.parse(await fs.readFile(this.file(key), "utf8")); } catch { return null; }
  }
  async putJSON(key, value) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(key), JSON.stringify(value));
  }
  async putFile(key, srcPath) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.copyFile(srcPath, this.file(key));
  }
}
