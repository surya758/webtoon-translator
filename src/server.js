import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { translateStrip } from "./pipeline.js";
import { warmScrubWorkers } from "./scrub-py.js";
import { storeZip } from "./zip.js";

/**
 * Local chapter GUI. One HTML page (gui/index.html) talks to this:
 *
 *   POST /jobs                       {lang, provider, model, review, series, inputDir?, outDir?}
 *                                    → {id, dir}  (a job folder under JOBS_DIR or inputDir's parent)
 *   PUT  /jobs/:id/upload/:name      raw image body → saved into the job's input folder
 *   POST /jobs/:id/start             begin translating; pages run in natural order so
 *                                    the series context flows through the chapter
 *   GET  /jobs/:id/events            SSE: {page, stage, msg} … {done}
 *   GET  /jobs/:id/in/:name  /out/:name   page images
 *   GET  /jobs/:id/zip               all translated pages, store-only zip
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = process.env.JOBS_DIR || path.join(os.homedir(), ".cache", "webtoon-translator", "jobs");
const IMAGE = /\.(png|jpe?g|webp)$/i;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

const jobs = new Map(); // id -> { id, dir, inDir, outDir, opts, pages: [{name, status, msg, out}], clients: Set<res>, running }

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); req.on("error", reject); });
const safeName = (n) => path.basename(n).replace(/[^\w.\-() ]+/g, "_");

const broadcast = (job, event) => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.clients) res.write(line);
};

const setPage = (job, name, patch) => {
  const p = job.pages.find((x) => x.name === name);
  if (p) Object.assign(p, patch);
  broadcast(job, { page: name, ...patch });
};

const runJob = async (job) => {
  if (job.running) return;
  job.running = true;
  try { await warmScrubWorkers(); } catch (e) { broadcast(job, { error: `scrub workers failed to start: ${e.message}` }); }
  const seriesFile = job.opts.series ? path.join(job.dir, "series.json") : undefined;
  for (const page of job.pages) {
    if (page.status === "done") continue;
    setPage(job, page.name, { status: "running", msg: "starting" });
    const out = path.join(job.outDir, page.name.replace(/\.[^.]+$/, "") + ".en.png");
    try {
      await translateStrip(path.join(job.inDir, page.name), out, {
        sourceLang: job.opts.lang || undefined,
        provider: job.opts.provider || undefined,
        model: job.opts.model || undefined,
        review: !!job.opts.review,
        series: seriesFile,
        log: (m) => { if (!/^\[py/.test(m)) setPage(job, page.name, { msg: String(m) }); },
      });
      setPage(job, page.name, { status: "done", msg: "done", out: path.basename(out) });
    } catch (e) {
      setPage(job, page.name, { status: "error", msg: e.message.split("\n")[0] });
    }
  }
  job.running = false;
  broadcast(job, { done: true });
};

const serveFile = async (res, file, type) => {
  try {
    const stat = await fs.stat(file);
    res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  } catch { json(res, 404, { error: "not found" }); }
};

export const startServer = async ({ port = 7860, host = "127.0.0.1" } = {}) => {
  const html = await fs.readFile(path.join(ROOT, "gui", "index.html"));
  await fs.mkdir(JOBS_DIR, { recursive: true });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && parts.length === 0) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }

      if (req.method === "POST" && parts[0] === "jobs" && parts.length === 1) {
        const opts = JSON.parse((await readBody(req)).toString() || "{}");
        const id = randomUUID().slice(0, 8);
        let inDir, outDir, dir;
        if (opts.inputDir) {
          inDir = path.resolve(opts.inputDir);
          dir = opts.outDir ? path.resolve(opts.outDir) : path.join(inDir, "translated");
          outDir = dir;
        } else {
          dir = path.join(JOBS_DIR, id); inDir = path.join(dir, "in"); outDir = path.join(dir, "out");
        }
        await fs.mkdir(inDir, { recursive: true }); await fs.mkdir(outDir, { recursive: true });
        const job = { id, dir, inDir, outDir, opts, pages: [], clients: new Set(), running: false };
        if (opts.inputDir) {
          const names = (await fs.readdir(inDir)).filter((n) => IMAGE.test(n)).sort(natural);
          job.pages = names.map((name) => ({ name, status: "queued", msg: "" }));
        }
        jobs.set(id, job);
        return json(res, 200, { id, dir, outDir, pages: job.pages });
      }

      const job = jobs.get(parts[1]);
      if (parts[0] !== "jobs" || !job) return json(res, 404, { error: "no such job" });

      if (req.method === "PUT" && parts[2] === "upload") {
        const name = safeName(decodeURIComponent(parts[3] ?? ""));
        if (!IMAGE.test(name)) return json(res, 400, { error: "not an image" });
        await fs.writeFile(path.join(job.inDir, name), await readBody(req));
        if (!job.pages.some((p) => p.name === name)) job.pages.push({ name, status: "queued", msg: "" });
        job.pages.sort((a, b) => natural(a.name, b.name));
        return json(res, 200, { pages: job.pages });
      }
      if (req.method === "POST" && parts[2] === "start") {
        const body = (await readBody(req)).toString();
        if (body) Object.assign(job.opts, JSON.parse(body)); // options chosen after upload
        runJob(job);
        return json(res, 200, { ok: true, pages: job.pages });
      }
      if (req.method === "GET" && parts[2] === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ snapshot: job.pages, running: job.running })}\n\n`);
        job.clients.add(res);
        req.on("close", () => job.clients.delete(res));
        return;
      }
      if (req.method === "GET" && (parts[2] === "in" || parts[2] === "out")) {
        const name = safeName(decodeURIComponent(parts[3] ?? ""));
        const file = path.join(parts[2] === "in" ? job.inDir : job.outDir, name);
        return serveFile(res, file, /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg");
      }
      if (req.method === "GET" && parts[2] === "zip") {
        const files = job.pages.filter((p) => p.out).map((p) => ({ name: p.out, path: path.join(job.outDir, p.out) }));
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="chapter-${job.id}-en.zip"` });
        return storeZip(files, res);
      }
      json(res, 404, { error: "unknown route" });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  await new Promise((r) => server.listen(port, host, r));
  return { server, url: `http://${host}:${port}` };
};
