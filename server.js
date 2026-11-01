#!/usr/bin/env node
// Lightning Replay Studio: local web server (127.0.0.1 only, no external services).
// Serves the preview app and runs MP4 exports through the local HyperFrames renderer.
//
//   npm start            → http://127.0.0.1:4317
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { readdirSync, existsSync, rmSync } from "node:fs";
import { join, extname, normalize, sep } from "node:path";
import { buildComposition, ROOT } from "./src/export/composition.js";
import { renderComposition, probeVideo, checkVideo } from "./src/export/render.js";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// URL prefix → directory. Nothing outside these folders is served.
const MOUNTS = {
  "/src/core/": join(ROOT, "src", "core"),
  "/basemap/": join(ROOT, "basemap"),
  "/data/": join(ROOT, "data"),
  "/fonts/": join(ROOT, "assets", "fonts"),
  "/exports/": join(ROOT, "exports"),
  "/": join(ROOT, "app"),
};

async function serveStatic(req, res, pathname) {
  for (const [prefix, dir] of Object.entries(MOUNTS)) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir + sep) && file !== dir) break;
    try {
      const st = await stat(file);
      if (!st.isFile()) break;
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      if (type === "video/mp4" && req.headers.range) {
        // Range support so <video> can seek in exported files.
        const { createReadStream } = await import("node:fs");
        const [a, b] = req.headers.range.replace("bytes=", "").split("-");
        const start = Number(a), end = b ? Number(b) : st.size - 1;
        res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
        createReadStream(file, { start, end }).pipe(res);
        return true;
      }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      res.end(await readFile(file));
      return true;
    } catch {
      break;
    }
  }
  return false;
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 50e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("Request too large.");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- export jobs (one at a time; renders already use every core) ----
const jobs = new Map();
let running = null;

function safeName(s) {
  return String(s || "replay").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "replay";
}

async function startExport({ text, filename, settings, quality }) {
  if (running) throw new Error("An export is already running. Wait for it to finish.");
  const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `${safeName(filename)}-${settings?.duration ?? 20}s-${id}.mp4`;
  const job = { id, status: "building", log: "", output: `/exports/${name}`, startedAt: Date.now(), probe: null, problems: null, error: null };
  jobs.set(id, job);
  const workDir = join(ROOT, "work", `export-${id}`);
  const outFile = join(ROOT, "exports", name);
  await mkdir(join(ROOT, "exports"), { recursive: true });
  // Validate synchronously so bad settings fail the request instead of the job.
  const { model } = buildComposition({ text, filename, settings, outDir: workDir });
  running = job;
  job.status = "rendering";
  job.settings = model.settings;
  renderComposition({
    dir: workDir,
    output: outFile,
    fps: model.settings.fps,
    quality: ["draft", "looks", "delivery"].includes(quality) ? quality : "looks",
    onLog: (l) => { job.log = (job.log + l).slice(-20000); },
  })
    .then(() => {
      job.probe = probeVideo(outFile);
      job.problems = checkVideo(job.probe, model.settings);
      job.status = "done";
      rmSync(workDir, { recursive: true, force: true });
    })
    .catch((e) => { job.status = "failed"; job.error = e.message; })
    .finally(() => { job.elapsed = (Date.now() - job.startedAt) / 1000; running = null; });
  return job;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (url.pathname === "/api/samples" && req.method === "GET") {
      const files = existsSync(join(ROOT, "data")) ? readdirSync(join(ROOT, "data")).filter((f) => /\.(json|csv)$/i.test(f)) : [];
      return json(res, 200, { files });
    }
    if (url.pathname === "/api/export" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      try {
        const job = await startExport(body);
        return json(res, 202, { id: job.id });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    const m = url.pathname.match(/^\/api\/export\/([\w-]+)$/);
    if (m && req.method === "GET") {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, { error: "Unknown export." });
      return json(res, 200, { ...job, log: job.log.slice(-3000), elapsed: job.elapsed ?? (Date.now() - job.startedAt) / 1000 });
    }
    if (req.method === "GET" && (await serveStatic(req, res, url.pathname))) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Lightning Replay Studio → http://${HOST}:${PORT}`);
});
