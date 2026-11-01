#!/usr/bin/env node
// Command-line export: dataset file → MP4, using the same pipeline as the studio's Export button.
//
//   node scripts/render.js data/sample-ankara-storm.json -o demo.mp4 --duration 20
//
// Options: --duration <s> --fps <n> --trail <storm minutes> --scale <marker size>
//          --bounds west,south,east,north --start <ISO> --end <ISO> --title <text>
//          --width <px> --height <px> --quality draft|looks|delivery --keep (keep work dir)
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { buildComposition, ROOT } from "../src/export/composition.js";
import { renderComposition, probeVideo, checkVideo } from "../src/export/render.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o" },
    duration: { type: "string" },
    fps: { type: "string" },
    trail: { type: "string" },
    scale: { type: "string" },
    bounds: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    title: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    quality: { type: "string", default: "looks" },
    keep: { type: "boolean", default: false },
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
if (values.title) settings.title = values.title;
if (values.bounds) {
  const [west, south, east, north] = values.bounds.split(",").map(Number);
  settings.bounds = { west, south, east, north };
}
if (values.start || values.end) settings.timeRange = { start: values.start ?? null, end: values.end ?? null };

const output = resolve(values.output ?? join(ROOT, "exports", `${basename(input).replace(/\.[^.]+$/, "")}.mp4`));
mkdirSync(dirname(output), { recursive: true });
const workDir = join(ROOT, "work", `cli-${basename(output, ".mp4")}`);

const t0 = Date.now();
const { model, dataset } = buildComposition({ text: readFileSync(input, "utf8"), filename: basename(input), settings, outDir: workDir });
for (const w of dataset.warnings) console.warn(`warning: ${w}`);
if (dataset.errors.length) console.warn(`${dataset.errors.length} record(s) rejected, e.g. ${dataset.errors[0]}`);
const s = model.settings;
console.log(`${model.totalEvents} strikes, ${s.duration} s @ ${s.fps} fps, ${s.width}×${s.height} → ${output}`);

await renderComposition({ dir: workDir, output, fps: s.fps, quality: values.quality, onLog: (l) => process.stdout.write(l) });
const probe = probeVideo(output);
const problems = checkVideo(probe, s);
console.log(`\nffprobe: ${probe.codec} ${probe.width}×${probe.height} ${probe.fps} fps, ${probe.duration.toFixed(3)} s, ${probe.frames} frames, ${(probe.bytes / 1e6).toFixed(2)} MB`);
console.log(problems.length ? `VERIFY FAILED: ${problems.join("; ")}` : "verify: OK (codec, size, fps, duration, frame count)");
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (!values.keep) rmSync(workDir, { recursive: true, force: true });
process.exit(problems.length ? 1 : 0);
