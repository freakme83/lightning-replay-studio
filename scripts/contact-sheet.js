#!/usr/bin/env node
// Contact sheet of decoded frames from a rendered MP4 (4 × 3 grid, evenly spaced).
//   node scripts/contact-sheet.js demo.mp4 contact-sheet.png
import { execFileSync } from "node:child_process";
import { probeVideo } from "../src/export/render.js";

const [input = "demo.mp4", output = "contact-sheet.png"] = process.argv.slice(2);
const p = probeVideo(input);
const cols = 4, rows = 3, n = cols * rows;
// Frames from just after the opening fade to just before the end.
const frames = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * (p.frames - 1)));
const select = frames.map((f) => `eq(n\\,${f})`).join("+");
execFileSync("ffmpeg", [
  "-v", "error", "-y", "-i", input,
  "-vf", `select='${select}',scale=480:-2,tile=${cols}x${rows}:padding=4:margin=4:color=0x1c2630`,
  "-frames:v", "1", "-fps_mode", "passthrough", output,
]);
console.log(`${output}: frames ${frames.join(", ")} (t = ${frames.map((f) => (f / p.fps).toFixed(2)).join(", ")} s)`);
