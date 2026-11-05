#!/usr/bin/env node
// Command-line export: dataset file → MP4, using the same pipeline as the studio's Export button.
//
//   node scripts/render.js data/sample-ankara-storm.json -o demo.mp4 --duration 20
//
// Options: --duration <s> --fps <n> --trail <storm minutes> --scale <marker size>
//          --frame west,south,east,north   exact video frame (as locked in the Map Composer)
//          --bounds west,south,east,north  area to fit inside the HUD-free part of the frame
//          --layers roadsMinor=off,labels=40   map layers: on | off | opacity % (see src/map/layers.js)
//                   water appearance: --layers waterColor=blue|teal|#1e4d7b,waterBrightness=-50..50
//          --overlays all|none|title,clock,…   informational overlays to keep (default all; none = clean frame)
//          --layout layout.json   overlay positions / scales (src/core/hud.js), plain or keyed by format
//          --shading off|subtle|standard|0…1   HUD backing gradients (default standard)
//          --grid [--grid-opacity 0.5]   latitude/longitude grid (off by default)
//          --outline   offline Natural Earth outlines instead of the online dark map
//          --start <ISO> --end <ISO> --title <text>
//          --format landscape|portrait|square   aspect ratio (default landscape 16:9)
//          --quality hd|draft   resolution: hd = Full HD (1920×1080, 1080×1920, 1080×1080), draft = half (default hd)
//          --width <px> --height <px>   explicit size instead of --format/--quality (advanced)
//          --encode draft|looks|delivery   x264 preset override (default: draft for --quality draft, else looks, CRF-based)
//          --sound [settings.json]   add the Sound tab's music (AAC 256 kbit/s, 48 kHz stereo, up to 10 minutes):
//                   bare = default sound (slot A, Geographic, glass); a file = the Sound tab's settings as JSON, or a
//                   Studio profile export (its sound settings are used); sound is switched on either way
//          --sound-area data|frame   listening area for Geographic notes (overrides the settings)
//          --keep (keep work dir)
// Without --frame/--bounds the frame is fitted to the data (Fit to Data). The online map is
// prepared once (needs internet); if that fails the export stops, use --outline to proceed.
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { buildComposition, ROOT } from "../src/export/composition.js";
import { renderComposition, probeVideo, checkVideo, tagCredits } from "../src/export/render.js";
import { attributionLines, parseOverlaySpec } from "../src/core/overlays.js";
import { SHADING_PRESETS } from "../src/core/hud.js";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay } from "../src/core/replay.js";
import { renderBasemap } from "../src/map/render-basemap.js";
import { QUALITIES, designViewport } from "../src/core/format.js";
import { normalizeLayers, parseLayerSpec } from "../src/map/layers.js";
import { exportSound, muxSound, renderExportSound, soundProblem } from "../src/export/sound.js";
import { defaultSoundSettings } from "../src/sound/settings.js";
import { PROFILE_FILE_KIND, parseProfileText } from "../src/profiles/profile.js";

// `--sound` may stand alone or take a settings file: give a bare one an explicit value parseArgs understands.
const argv = process.argv.slice(2).map((a, i, all) => (a === "--sound" && (i + 1 >= all.length || all[i + 1].startsWith("-")) ? "--sound=default" : a));

const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o" },
    duration: { type: "string" },
    fps: { type: "string" },
    trail: { type: "string" },
    scale: { type: "string" },
    bounds: { type: "string" },
    frame: { type: "string" },
    layers: { type: "string" },
    overlays: { type: "string" },
    layout: { type: "string" },
    shading: { type: "string" },
    grid: { type: "boolean", default: false },
    "grid-opacity": { type: "string" },
    outline: { type: "boolean", default: false },
    start: { type: "string" },
    end: { type: "string" },
    title: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    format: { type: "string" },
    quality: { type: "string" },
    encode: { type: "string" },
    keep: { type: "boolean", default: false },
    sound: { type: "string" },
    "sound-area": { type: "string" },
  },
});

const input = positionals[0];
if (!input) {
  console.error("Usage: node scripts/render.js <dataset.json|csv> -o out.mp4 [--duration 20] [--trail 20] [--scale 1] ...");
  process.exit(2);
}
const settings = {};
if (values.duration) settings.duration = Number(values.duration);
if (values.fps) settings.fps = Number(values.fps);
if (values.trail) settings.trailMinutes = Number(values.trail);
if (values.scale) settings.markerScale = Number(values.scale);
if (values.width) settings.width = Number(values.width);
if (values.height) settings.height = Number(values.height);
if (values.format) settings.format = values.format;
if (values.quality) settings.quality = values.quality;
if (values.title) settings.title = values.title;
if (values.grid) settings.showGrid = true;
try {
  if (values.overlays !== undefined) settings.overlays = parseOverlaySpec(values.overlays);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (values["grid-opacity"]) settings.gridOpacity = Number(values["grid-opacity"]);
if (values.layout) settings.overlayLayout = JSON.parse(readFileSync(values.layout, "utf8")); // validated per format by normalizeSettings
if (values.shading) settings.hudShading = values.shading in SHADING_PRESETS ? SHADING_PRESETS[values.shading] : Number(values.shading);
let layers;
try {
  layers = normalizeLayers(parseLayerSpec(values.layers));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const box = (v) => {
  const [west, south, east, north] = v.split(",").map(Number);
  return { west, south, east, north };
};
if (values.bounds) settings.bounds = box(values.bounds);
if (values.frame) settings.frame = box(values.frame);
if (values.start || values.end) settings.timeRange = { start: values.start ?? null, end: values.end ?? null };
const text = readFileSync(input, "utf8");

/** The sound the command line asks for (see --sound), or null for a silent video. */
function cliSound() {
  if (values.sound === undefined) return null;
  let settings = defaultSoundSettings();
  if (values.sound !== "default") {
    const raw = readFileSync(values.sound, "utf8");
    const json = JSON.parse(raw);
    if (json?.kind === PROFILE_FILE_KIND) {
      const profile = parseProfileText(raw);
      if (!profile.settings.sound) throw new Error(`${values.sound} is a Studio profile without sound settings.`);
      settings = profile.settings.sound;
    } else settings = json;
  }
  if (values["sound-area"] !== undefined) {
    if (!["data", "frame"].includes(values["sound-area"])) throw new Error("--sound-area must be data or frame.");
    settings = { ...settings, area: values["sound-area"] };
  }
  return exportSound({ ...settings, enabled: true });
}
let sound;
try {
  sound = cliSound();
} catch (e) {
  console.error(`Sound settings: ${e.message}`);
  process.exit(2);
}

let mapImage = null;
if (!values.outline) {
  // Same frame the composer's Fit to Data / bounds would give: the v1 layout's full-canvas extent.
  const parsed = parseDataset(text, basename(input));
  if (parsed.ok && !settings.frame) settings.frame = buildReplay(parsed, settings).extent;
  if (parsed.ok) {
    const s0 = buildReplay(parsed, settings).settings;
    process.stdout.write("Preparing map… ");
    try {
      // Baked at the output size: design viewport × pixelRatio = exactly width × height pixels.
      const vp = designViewport(s0.width, s0.height);
      mapImage = await renderBasemap({ frame: s0.frame, width: vp.width, height: vp.height, pixelRatio: vp.k, layers, cacheDir: join(ROOT, "work", "basemaps") });
    } catch (e) {
      console.error(`\n${e.message}\nRe-run with --outline to export with the offline Natural Earth outlines instead.`);
      process.exit(1);
    }
    console.log(`${mapImage.cached ? "cached" : "done"} (alignment ${mapImage.meta.alignment.maxErrorPx.toExponential(1)} px)`);
  }
}

const output = resolve(values.output ?? join(ROOT, "exports", `${basename(input).replace(/\.[^.]+$/, "")}.mp4`));
mkdirSync(dirname(output), { recursive: true });
const workDir = join(ROOT, "work", `cli-${basename(output, ".mp4")}`);

const t0 = Date.now();
const { model, dataset } = buildComposition({ text, filename: basename(input), settings, outDir: workDir, mapImage });
const soundIssue = soundProblem(model.settings.duration, sound);
if (soundIssue) {
  console.error(soundIssue);
  process.exit(2);
}
for (const w of dataset.warnings) console.warn(`warning: ${w}`);
if (dataset.errors.length) console.warn(`${dataset.errors.length} record(s) rejected, e.g. ${dataset.errors[0]}`);
const s = model.settings;
const encode = values.encode ?? QUALITIES[s.quality]?.encode ?? "looks";
console.log(`${model.totalEvents} strikes, ${s.duration} s @ ${s.fps} fps, ${s.width}×${s.height} (${s.format}, ${s.quality}), encoder preset ${encode} → ${output}`);

const soundJob = sound ? renderExportSound({ model, dataset, sound }) : Promise.resolve(null);
soundJob.catch(() => {}); // awaited below
await renderComposition({ dir: workDir, output, fps: s.fps, quality: encode, onLog: (l) => process.stdout.write(l) });
const audio = await soundJob;
if (audio) {
  muxSound(output, audio, s.duration);
  const m = audio.summary;
  console.log(`\nsound: slot ${m.slot}, ${m.instrument}, ${m.noteMode} (${m.area} area), ${m.flashes} flashes, ${m.notes} notes + ${m.chordNotes} chord notes, aligned by ${m.alignedMs} ms`);
}
tagCredits(output, attributionLines({ mapAttribution: mapImage?.meta.attribution, outline: !mapImage, meta: dataset.meta }).join("\n"));
const probe = probeVideo(output);
const problems = checkVideo(probe, s, { sound: !!audio });
const a = probe.audio;
console.log(`\nffprobe: ${probe.codec} ${probe.width}×${probe.height} ${probe.fps} fps, ${probe.duration.toFixed(3)} s, ${probe.frames} frames, ${a ? `${a.codec} ${a.sampleRate} Hz ${a.channels} ch ${audio ? audio.summary.bitrate : "?"}bit/s (average ${Math.round(a.bitRate / 1000)}k), ` : "no audio, "}${(probe.bytes / 1e6).toFixed(2)} MB`);
console.log(problems.length ? `VERIFY FAILED: ${problems.join("; ")}` : `verify: OK (codec, size, fps, duration, frame count${audio ? ", audio" : ", silent"})`);
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (!values.keep) rmSync(workDir, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
