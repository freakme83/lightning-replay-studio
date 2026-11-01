// Prepares ("bakes") the basemap for one locked frame: renders the provider's MapLibre
// style once in headless Chrome at exactly the output size, and returns a PNG that the
// preview and the exported video both draw full-frame. Tiles are fetched once per frame
// (and cached on disk), never per video frame, and the render itself needs no network.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cameraOf, frameProjection } from "../core/projection.js";
import { DEFAULT_PROVIDER, getProvider } from "./providers.js";
import { normalizeLayers, layersKey } from "./layers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAPLIBRE_DIST = join(ROOT, "node_modules", "maplibre-gl", "dist");
const MAP_DIR = join(ROOT, "src", "map");
const USER_AGENT = "LightningReplayStudio/1.1 (+https://github.com/freakme83/lightning-replay-studio)";
// Basemap pixels must land within this distance of the replay projection (CSS px).
export const ALIGNMENT_TOLERANCE_PX = 0.05;
const RENDER_VERSION = 3; // bump when the render page or tuning changes (invalidates cache)

export class MapPrepError extends Error {
  constructor(message) {
    super(message);
    this.name = "MapPrepError";
  }
}

let chromePath = null;
/** Chrome used for the bake: $LR_CHROME_PATH, else the browser HyperFrames renders with, else system Chrome. */
export function findChrome() {
  if (chromePath) return chromePath;
  const candidates = [process.env.LR_CHROME_PATH];
  try {
    const out = execFileSync(join(ROOT, "node_modules", ".bin", "hyperframes"), ["browser", "path"], {
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
    });
    candidates.push(out.toString().trim().split("\n").pop());
  } catch {}
  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  chromePath = candidates.find((p) => p && existsSync(p)) ?? null;
  if (!chromePath) throw new MapPrepError("No Chrome found for map preparation. Run `npx hyperframes browser ensure` or set LR_CHROME_PATH.");
  return chromePath;
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}#map{position:absolute;left:0;top:0}</style></head>
<body><div id="map"></div>
<script type="module">
  import * as maplibregl from "/maplibre/maplibre-gl.mjs";
  import { loadProviderStyle } from "/map/providers.js";
  import { applyLayers, availableGroups } from "/map/layers.js";
  window.renderMap = async (o) => {
    const base = o.style ?? (await loadProviderStyle(o.provider, { styleUrl: o.styleUrl ?? undefined }));
    const style = applyLayers(base, o.layers);
    const el = document.getElementById("map");
    el.style.width = o.width + "px";
    el.style.height = o.height + "px";
    const map = new maplibregl.Map({
      container: el, style,
      center: [o.camera.lon, o.camera.lat], zoom: o.camera.zoom, bearing: 0, pitch: 0,
      minZoom: 0, maxZoom: 24, pixelRatio: o.pixelRatio, fadeDuration: 0,
      interactive: false, attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    const errors = [];
    map.on("error", (e) => errors.push(String(e?.error?.message ?? e?.error ?? "unknown map error")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for map tiles (" + Math.round(o.timeoutMs / 1000) + " s).")), o.timeoutMs);
      map.once("idle", () => { clearTimeout(timer); resolve(); });
    });
    const probes = o.probes.map(([lon, lat]) => { const p = map.project([lon, lat]); return [p.x, p.y]; });
    const c = map.getCenter();
    return {
      png: map.getCanvas().toDataURL("image/png"),
      canvas: [map.getCanvas().width, map.getCanvas().height],
      tilesLoaded: map.areTilesLoaded(),
      errors, probes, layerGroups: availableGroups(base),
      camera: { lon: c.lng, lat: c.lat, zoom: map.getZoom() },
    };
  };
  window.pageReady = true;
</script></body></html>`;

const MOUNTS = { "/maplibre/": MAPLIBRE_DIST, "/map/": MAP_DIR };

function startPageServer() {
  const server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    for (const [prefix, dir] of Object.entries(MOUNTS)) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(dir, decodeURIComponent(path.slice(prefix.length))));
      if (!file.startsWith(dir + sep)) break;
      try {
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": file.endsWith(".css") ? "text/css" : "text/javascript; charset=utf-8" });
        return res.end(body);
      } catch {
        break;
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Probe points spread over the frame: a 5 × 5 grid plus any caller-supplied coordinates. */
function probePoints(proj, width, height, extra = []) {
  const pts = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) pts.push(proj.unproject((width * i) / 4, (height * j) / 4));
  return pts.concat(extra.slice(0, 200));
}

/**
 * @param o.frame {west,south,east,north} the locked frame (whole output viewport)
 * @param o.width, o.height output size in CSS px (e.g. 960 × 540)
 * @param o.provider provider id (src/map/providers.js)
 * @param o.style optional ready MapLibre style object (tests / offline use), bypasses the provider fetch
 * @param o.styleUrl optional style URL override for the provider
 * @param o.layers map layer settings (src/map/layers.js); anything invalid falls back to defaults
 * @param o.probes extra [lon, lat] points to verify (e.g. the strikes)
 * @param o.cacheDir if set, identical requests are served from disk
 * @returns {{ png: Buffer, meta: object, cached: boolean }}
 */
export async function renderBasemap({
  frame, width, height, provider = DEFAULT_PROVIDER, style = null, styleUrl = null,
  layers = null, pixelRatio = 2, probes = [], cacheDir = null, timeoutMs = 45000,
}) {
  const p = getProvider(provider);
  layers = normalizeLayers(layers);
  styleUrl ??= process.env.LR_MAP_STYLE_URL || null; // override, e.g. a self-hosted style or an outage drill
  const proj = frameProjection(frame, width, height);
  const camera = cameraOf(proj, width, height);
  const key = createHash("sha256")
    .update(JSON.stringify({ RENDER_VERSION, provider, styleUrl, style, layers: layersKey(layers), camera, width, height, pixelRatio }))
    .digest("hex")
    .slice(0, 20);
  if (cacheDir && existsSync(join(cacheDir, `${key}.png`)) && existsSync(join(cacheDir, `${key}.json`))) {
    const meta = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8"));
    return { png: readFileSync(join(cacheDir, `${key}.png`)), meta, cached: true };
  }

  const { default: puppeteer } = await import("puppeteer-core");
  const server = await startPageServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", `--user-agent=${USER_AGENT}`],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction("window.pageReady === true", { timeout: 15000 });
    const pts = probePoints(proj, width, height, probes);
    let r;
    try {
      r = await page.evaluate((o) => window.renderMap(o), { provider, style, styleUrl, layers, camera, width, height, pixelRatio, probes: pts, timeoutMs });
    } catch (e) {
      throw new MapPrepError(`Map could not be prepared: ${String(e.message).replace(/^Error: /, "").split("\n")[0]}`);
    }
    if (r.errors.length) throw new MapPrepError(`Map could not be prepared: ${r.errors.length} map resource(s) failed to load (${r.errors[0]}).`);
    if (!r.tilesLoaded) throw new MapPrepError("Map could not be prepared: some map tiles did not finish loading.");
    if (r.canvas[0] !== Math.round(width * pixelRatio) || r.canvas[1] !== Math.round(height * pixelRatio))
      throw new MapPrepError(`Map canvas is ${r.canvas.join("×")}, expected ${width * pixelRatio}×${height * pixelRatio}.`);

    // Verify the bridge: where MapLibre put each probe vs. where the replay draws it.
    let maxErrorPx = 0;
    pts.forEach(([lon, lat], i) => {
      const [x, y] = proj.project(lon, lat);
      maxErrorPx = Math.max(maxErrorPx, Math.hypot(r.probes[i][0] - x, r.probes[i][1] - y));
    });
    if (!(maxErrorPx <= ALIGNMENT_TOLERANCE_PX))
      throw new MapPrepError(`Map alignment check failed: basemap is off by ${maxErrorPx.toFixed(3)} px (camera clamped? zoom ${camera.zoom.toFixed(2)}).`);

    const png = Buffer.from(r.png.split(",")[1], "base64");
    const meta = {
      id: key, provider, attribution: p.attribution, frame: proj.extentOf({ x: 0, y: 0, w: width, h: height }),
      camera, width, height, pixelRatio, alignment: { maxErrorPx, probes: pts.length },
      layers, layersKey: layersKey(layers), layerGroups: r.layerGroups,
    };
    if (cacheDir) {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, `${key}.png`), png);
      await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(meta, null, 2));
    }
    return { png, meta, cached: false };
  } finally {
    await browser?.close().catch(() => {});
    server.close();
  }
}
