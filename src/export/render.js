// Runs the local HyperFrames renderer on a composition folder and verifies the MP4 with ffprobe.
import { spawn, execFileSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./composition.js";

const HF_BIN = join(ROOT, "node_modules", ".bin", "hyperframes");

export function renderComposition({ dir, output, fps, quality = "looks", onLog = () => {} }) {
  return new Promise((resolve, reject) => {
    const args = ["render", dir, "-o", output, "--fps", String(fps), "--quality", quality, "--strict"];
    onLog(`$ hyperframes ${args.join(" ")}\n`);
    const child = spawn(HF_BIN, args, { cwd: ROOT, env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: "1", FORCE_COLOR: "0" } });
    let tail = "";
    const take = (b) => {
      const s = b.toString();
      tail = (tail + s).slice(-4000);
      onLog(s);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`hyperframes render exited ${code}\n${tail}`))));
  });
}

/** ffprobe summary of the first video stream. */
export function probeVideo(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,pix_fmt:format=duration,size",
    "-of", "json", file,
  ]).toString();
  const j = JSON.parse(out);
  const st = j.streams[0];
  const [n, d] = st.r_frame_rate.split("/").map(Number);
  return {
    codec: st.codec_name,
    profile: st.profile,
    pixFmt: st.pix_fmt,
    width: st.width,
    height: st.height,
    fps: n / d,
    frames: Number(st.nb_frames),
    duration: Number(j.format.duration),
    bytes: Number(j.format.size),
  };
}

/** Compare a probe against the requested settings; returns a list of mismatches (empty = pass). */
export function checkVideo(probe, { duration, fps, width, height }) {
  const problems = [];
  if (probe.codec !== "h264") problems.push(`codec ${probe.codec} ≠ h264`);
  if (probe.width !== width || probe.height !== height) problems.push(`size ${probe.width}×${probe.height} ≠ ${width}×${height}`);
  if (Math.abs(probe.fps - fps) > 0.01) problems.push(`fps ${probe.fps} ≠ ${fps}`);
  if (Math.abs(probe.duration - duration) > 1 / fps + 0.01) problems.push(`duration ${probe.duration.toFixed(3)} s ≠ ${duration} s`);
  const expectedFrames = Math.round(duration * fps);
  if (Number.isFinite(probe.frames) && Math.abs(probe.frames - expectedFrames) > 1) problems.push(`frames ${probe.frames} ≠ ${expectedFrames}`);
  return problems;
}

/**
 * Keep the source credit with the file when it is not drawn in the frame: written to the MP4's
 * comment tag (stream copy, picture untouched) and to a `<name>.credits.txt` next to it.
 */
export function tagCredits(file, text) {
  if (!text) return;
  const tmp = file.replace(/\.mp4$/, ".tagged.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-c", "copy", "-movflags", "+faststart", "-metadata", `comment=${text}`, tmp]);
  renameSync(tmp, file);
  writeFileSync(file.replace(/\.mp4$/, ".credits.txt"), `${text}\n`);
}
