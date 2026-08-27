import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const PY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "py");
const PYTHON = process.env.SCRUB_PYTHON || path.join(PY_DIR, ".venv", "bin", "python");

/**
 * Persistent Python workers, each holding the detector and LaMa in memory.
 *
 * Previously every page spawned two fresh processes (detect, then inpaint), each paying
 * import + model load — several seconds, twice per page — and N pages at once meant 2N
 * processes all trying to use every core, which is what made 10-way concurrency slower
 * than 2-way and occasionally crashed torch. Now there are SCRUB_WORKERS long-lived
 * processes (default: enough to cover the cores at SCRUB_THREADS each), jobs queue on
 * the least-loaded one, and a worker that dies is replaced on the next job.
 */
const WORKERS = Number(process.env.SCRUB_WORKERS || Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3))));
const THREADS = Number(process.env.SCRUB_THREADS || Math.max(2, Math.floor(os.cpus().length / WORKERS)));

class Worker {
  constructor(index) {
    this.index = index;
    this.pending = new Map(); // id -> {resolve, reject, log}
    this.busy = 0;
    this.nextId = 1;
    this.child = null;
    this.ready = null;
  }

  start() {
    const child = spawn(PYTHON, [path.join(PY_DIR, "scrub.py"), "serve", "--threads", String(THREADS)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) { resolve(); return; }
        const job = this.pending.get(msg.id);
        if (!job) return;
        this.pending.delete(msg.id);
        this.busy -= 1;
        if (msg.ok) job.resolve(); else job.reject(new Error(msg.error ?? "scrub job failed"));
      });
      readline.createInterface({ input: child.stderr }).on("line", (line) => {
        // stderr is not tagged per job, so it goes to every in-flight caller on this
        // worker — usually exactly one, since a worker runs jobs one at a time.
        const logs = [...this.pending.values()].map((j) => j.log);
        for (const log of logs.length ? logs : [console.error]) log(`[py${this.index}] ${line}`);
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        const err = new Error(`scrub worker ${this.index} exited (${code ?? signal})`);
        reject(err);
        for (const job of this.pending.values()) job.reject(err);
        this.pending.clear();
        this.busy = 0;
        this.child = null;
      });
    });
    // Avoid an unhandled rejection if a worker dies while nobody is awaiting it.
    this.ready.catch(() => {});
    return this.ready;
  }

  async run(job, log) {
    if (!this.child) this.start();
    await this.ready;
    const id = this.nextId++;
    this.busy += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, log });
      this.child.stdin.write(JSON.stringify({ ...job, id }) + "\n");
    });
  }
}

const pool = Array.from({ length: WORKERS }, (_, i) => new Worker(i));

/** The worker with the least queued work; ties go to the lowest index. */
const pick = () => pool.reduce((best, w) => (w.busy < best.busy ? w : best), pool[0]);

const run = async (job, log, retried = false) => {
  try {
    return await pick().run(job, log);
  } catch (e) {
    // A worker that died mid-job restarts on the next run(); retry once so a single
    // crash costs the page a few seconds rather than a failure.
    if (/exited/.test(e.message) && !retried) return run(job, log, true);
    throw e;
  }
};

/** Start every worker now rather than on first use, so the first page is not the slow one. */
export const warmScrubWorkers = () => Promise.all(pool.map((w) => (w.child ? w.ready : w.start())));

export const scrubPoolInfo = () => ({ workers: WORKERS, threads: THREADS });

/** RT-DETR-v2: returns [{x,y,w,h,kind,score,container}] in reading order. */
export const detectBoxes = async (inputPath, boxesPath, { threshold = 0.3, log = () => {} } = {}) => {
  await run({ op: "detect", input: inputPath, boxes_json: boxesPath, threshold }, log);
  return JSON.parse(await fs.readFile(boxesPath, "utf8")).boxes;
};

/** Manga LaMa: erases exactly the given boxes; writes outputPath. */
export const inpaintBoxes = async (inputPath, outputPath, boxes, { maskPath, log = () => {} } = {}) => {
  const boxesPath = outputPath.replace(/\.png$/, ".erase.json");
  await fs.writeFile(boxesPath, JSON.stringify(boxes));
  await run({ op: "inpaint", input: inputPath, output: outputPath, boxes_json: boxesPath, mask: maskPath ?? null }, log);
};
