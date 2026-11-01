// Writes a self-contained HyperFrames project for one replay.
// The composition embeds the *raw* dataset text and settings and runs the very same
// parseDataset → buildReplay → drawFrame pipeline as the preview, from byte-identical
// copies of src/core, so preview and export cannot drift apart. A prepared basemap (see
// src/map/render-basemap.js) travels as a single PNG that is drawn full-frame, exactly as
// in the preview; nothing is fetched from the network while rendering.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDataset } from "../core/parse.js";
import { buildReplay, filterBasemap } from "../core/replay.js";
import { layersKey } from "../map/layers.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_DIR = join(ROOT, "src", "core");
const FONT_DIR = join(ROOT, "assets", "fonts");

let basemapCache = null;
export function loadGeography() {
  if (!basemapCache) {
    basemapCache = {
      basemap: JSON.parse(readFileSync(join(ROOT, "basemap", "ne-50m.json"), "utf8")),
      places: JSON.parse(readFileSync(join(ROOT, "basemap", "places.json"), "utf8")).places,
    };
  }
  return basemapCache;
}

/**
 * A prepared basemap fits a model only if it was rendered for the same frame and size.
 * Returns a problem description, or null when it matches.
 */
export function basemapMismatch(meta, model) {
  const s = model.settings;
  if (!meta) return "No basemap metadata.";
  if (!s.frame) return "The replay has no locked map frame.";
  // meta.width/height are the design viewport (CSS px); the PNG has pixelRatio times as many pixels.
  const pw = Math.round(meta.width * (meta.pixelRatio ?? 1)), ph = Math.round(meta.height * (meta.pixelRatio ?? 1));
  if (pw !== s.width || ph !== s.height) return `Basemap is ${pw}×${ph}, video is ${s.width}×${s.height}. Prepare the map again for this format and quality.`;
  // Both cameras come from the same frame through cameraOf(); allow only float noise.
  const a = meta.camera, b = model.camera;
  if (Math.abs(a.zoom - b.zoom) > 1e-9 || Math.abs(a.lon - b.lon) > 1e-9 || Math.abs(a.lat - b.lat) > 1e-9)
    return "The map frame changed after the basemap was prepared. Lock the frame again.";
  return null;
}

/**
 * A prepared basemap shows the layers it was baked with. Returns a problem description when
 * the layer settings the user expects differ from them, or null when they match.
 */
export function layersMismatch(meta, layers) {
  if (!meta?.layersKey) return "The prepared map does not record its layer settings. Lock the frame again.";
  if (layers && layersKey(layers) !== meta.layersKey) return "The map layers changed after the map was prepared. Wait for the map to update, then export again.";
  return null;
}

/**
 * @param mapImage optional { png: Buffer, meta } from renderBasemap(); omitted = Natural Earth outlines.
 * @returns {{ model, dataset, outDir }} the model is what the composition will rebuild in Chrome.
 */
export function buildComposition({ text, filename, settings, outDir, mapImage = null }) {
  const dataset = parseDataset(text, filename);
  if (!dataset.ok) throw new Error(`Dataset rejected: ${dataset.errors.slice(0, 5).join(" ")}`);
  const geo = loadGeography();
  const model = buildReplay(dataset, settings, geo);
  const s = model.settings;
  if (mapImage) {
    const problem = basemapMismatch(mapImage.meta, model);
    if (problem) throw new Error(problem);
  }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "lib", "core"), { recursive: true });
  mkdirSync(join(outDir, "assets", "fonts"), { recursive: true });

  for (const f of readdirSync(CORE_DIR)) if (f.endsWith(".js")) copyFileSync(join(CORE_DIR, f), join(outDir, "lib", "core", f));
  copyFileSync(join(ROOT, "node_modules", "gsap", "dist", "gsap.min.js"), join(outDir, "lib", "gsap.min.js"));
  for (const f of readdirSync(FONT_DIR)) if (f.endsWith(".woff2")) copyFileSync(join(FONT_DIR, f), join(outDir, "assets", "fonts", f));
  const fontCss = readFileSync(join(FONT_DIR, "fonts.css"), "utf8").replace(/url\("/g, 'url("assets/fonts/');
  if (mapImage) writeFileSync(join(outDir, "assets", "basemap.png"), mapImage.png);

  // Only the basemap features near the view travel with the composition.
  const input = {
    text,
    filename,
    settings: s,
    geo: mapImage ? {} : { basemap: filterBasemap(geo.basemap, model.extent, 1), places: geo.places },
    map: mapImage ? { src: "assets/basemap.png", attribution: mapImage.meta.attribution } : null,
  };
  writeFileSync(join(outDir, "replay-input.js"), `window.__REPLAY_INPUT = ${JSON.stringify(input)};\n`);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${s.width}, height=${s.height}" />
    <title>Lightning Replay</title>
    <script src="lib/gsap.min.js"></script>
    <script src="replay-input.js"></script>
    <style>
${fontCss}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${s.width}px; height: ${s.height}px; overflow: hidden; background: #06080b; }
      #root { position: relative; width: 100%; height: 100%; background: #06080b; }
      #replay-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${s.duration}"
      data-width="${s.width}"
      data-height="${s.height}"
      data-fps="${s.fps}"
    >
      <canvas id="replay-canvas" width="${s.width}" height="${s.height}" data-layout-ignore></canvas>
    </div>
    <script type="module">
      import { parseDataset } from "./lib/core/parse.js";
      import { buildReplay } from "./lib/core/replay.js";
      import { drawFrame } from "./lib/core/draw.js";

      const input = window.__REPLAY_INPUT;
      const sample = "AÇĞİÖŞÜ çğıöşü 0123456789:·→";
      await Promise.all(
        ['400 12px "LR Inter"', '600 12px "LR Inter"', '400 12px "LR Mono"', '500 12px "LR Mono"'].map((f) => document.fonts.load(f, sample)),
      );
      let mapImage = null;
      if (input.map) {
        // Local asset baked before the render; decoded before the timeline is registered.
        const image = new Image();
        image.src = input.map.src;
        await image.decode();
        mapImage = { image, attribution: input.map.attribution };
      }
      const dataset = parseDataset(input.text, input.filename);
      const model = buildReplay(dataset, input.settings, { ...input.geo, mapImage });
      const ctx = document.getElementById("replay-canvas").getContext("2d");
      const draw = (t) => drawFrame(ctx, model, Math.max(0, Math.min(model.settings.duration, t)));

      // One linear tween from 0 to the duration; every frame is drawn from its time alone.
      const clock = { t: 0 };
      const tl = gsap.timeline({ paused: true });
      tl.to(clock, { t: ${s.duration}, duration: ${s.duration}, ease: "none", onUpdate: () => draw(clock.t) }, 0);
      window.addEventListener("hf-seek", (e) => draw(e.detail.time));
      draw(0);
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  writeFileSync(join(outDir, "index.html"), html);
  return { model, dataset, outDir };
}
