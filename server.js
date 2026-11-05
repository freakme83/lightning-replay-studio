#!/usr/bin/env node
// Lightning Replay Studio: local web server (127.0.0.1 only, no external services).
// Serves the preview app, prepares map basemaps (headless MapLibre, one PNG per locked
// frame) and runs MP4 exports through the local HyperFrames renderer.
//
//   npm start            → http://127.0.0.1:4317
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, extname, normalize, sep } from "node:path";
import { buildComposition, layersMismatch, ROOT } from "./src/export/composition.js";
import { renderComposition, probeVideo, checkVideo, tagCredits } from "./src/export/render.js";
import { attributionLines } from "./src/core/overlays.js";
import { renderBasemap, MapPrepError } from "./src/map/render-basemap.js";
import { normalizeSettings } from "./src/core/replay.js";
import { QUALITIES, designViewport } from "./src/core/format.js";
import { DEFAULT_PROVIDER, getProvider } from "./src/map/providers.js";
import { normalizeLayers } from "./src/map/layers.js";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// URL prefix → directory. Nothing outside these folders is served.
const BASEMAP_DIR = join(ROOT, "work", "basemaps");
const MOUNTS = {
  "/src/core/": join(ROOT, "src", "core"),
  "/src/map/": join(ROOT, "src", "map"),
  "/src/editor/": join(ROOT, "src", "editor"),
  "/src/profiles/": join(ROOT, "src", "profiles"),
  "/src/sound/": join(ROOT, "src", "sound"),
  "/vendor/maplibre/": join(ROOT, "node_modules", "maplibre-gl", "dist"),
  "/basemaps/": BASEMAP_DIR,
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

/** Prepared basemap by id (from /api/basemap), or null. */
function loadBasemap(id) {
  if (!/^[0-9a-f]{20}$/.test(String(id))) return null;
  const png = join(BASEMAP_DIR, `${id}.png`), meta = join(BASEMAP_DIR, `${id}.json`);
  if (!existsSync(png) || !existsSync(meta)) return null;
  return { png: readFileSync(png), meta: JSON.parse(readFileSync(meta, "utf8")) };
}

/**
 * The map an export uses must be chosen explicitly: a prepared basemap, or the offline
 * Natural Earth outlines. A missing or failed map never silently becomes a blank background.
 */
function resolveExportMap(map) {
  if (map?.basemapId) {
    const b = loadBasemap(map.basemapId);
    if (!b) throw new Error("The prepared map is no longer available. Lock the frame again to re-prepare it.");
    // The video shows the layers baked into the PNG; refuse if the request expects different ones.
    const problem = layersMismatch(b.meta, map.layers);
    if (problem) throw new Error(problem);
    return b;
  }
  if (map?.fallback === "outline") return null;
  throw new Error("No map prepared for this frame. Lock the frame (needs internet for map tiles), or tick “Use offline outline map” to export with the Natural Earth fallback.");
}

async function startExport({ text, filename, settings, encode, map }) {
  if (running) throw new Error("An export is already running. Wait for it to finish.");
  const mapImage = resolveExportMap(map);
  const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Validate the settings first: the file name and the encoder preset come from the normalised size.
  const planned = normalizeSettings(settings);
  const name = `${safeName(filename)}-${planned.format}-${planned.width}x${planned.height}-${planned.duration}s-${id}.mp4`;
  const job = { id, status: "building", log: "", output: `/exports/${name}`, startedAt: Date.now(), probe: null, problems: null, error: null };
  jobs.set(id, job);
  const workDir = join(ROOT, "work", `export-${id}`);
  const outFile = join(ROOT, "exports", name);
  await mkdir(join(ROOT, "exports"), { recursive: true });
  // Validate synchronously so bad settings fail the request instead of the job.
  const { model, dataset } = buildComposition({ text, filename, settings, outDir: workDir, mapImage });
  const credits = attributionLines({ mapAttribution: mapImage?.meta.attribution, outline: !mapImage, meta: dataset.meta }).join("\n");
  running = job;
  job.status = "rendering";
  job.settings = model.settings;
  renderComposition({
    dir: workDir,
    output: outFile,
    fps: model.settings.fps,
    // Draft uses the fast encoder preset; Full HD the CRF-based "looks" preset. `encode` overrides (CLI-style).
    quality: ["draft", "looks", "delivery"].includes(encode) ? encode : QUALITIES[model.settings.quality]?.encode ?? "looks",
    onLog: (l) => { job.log = (job.log + l).slice(-20000); },
  })
    .then(() => {
      tagCredits(outFile, credits);
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
    if (url.pathname === "/api/map-config" && req.method === "GET") {
      const p = getProvider(DEFAULT_PROVIDER);
      return json(res, 200, { provider: p.id, label: p.label, attribution: p.attribution, styleUrl: process.env.LR_MAP_STYLE_URL || p.styleUrl });
    }
    if (url.pathname === "/api/basemap" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 5e6));
      let s;
      try {
        s = normalizeSettings({ frame: body.frame, format: body.format, quality: body.quality });
        if (!s.frame) throw new Error("A map frame is required.");
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
      try {
        const probes = Array.isArray(body.probes) ? body.probes.filter((p) => Array.isArray(p) && p.every(Number.isFinite)) : [];
        // Baked at the output size: design viewport × pixelRatio = exactly s.width × s.height pixels.
        const vp = designViewport(s.width, s.height);
        const { meta, cached } = await renderBasemap({ frame: s.frame, width: vp.width, height: vp.height, pixelRatio: vp.k, provider: body.provider, layers: normalizeLayers(body.layers), probes, cacheDir: BASEMAP_DIR });
        return json(res, 200, { ...meta, url: `/basemaps/${meta.id}.png`, cached });
      } catch (e) {
        return json(res, e instanceof MapPrepError ? 502 : 500, { error: e.message });
      }
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
