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

/** ffprobe summary of the first audio stream, or null when the file has none. */
export function probeAudio(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,profile,sample_rate,channels,bit_rate,duration,start_time",
    "-of", "json", file,
  ]).toString();
  const st = JSON.parse(out).streams?.[0];
  if (!st) return null;
  return {
    codec: st.codec_name,
    profile: st.profile,
    sampleRate: Number(st.sample_rate),
    channels: Number(st.channels),
    bitRate: Number(st.bit_rate),
    duration: Number(st.duration),
    start: Number(st.start_time),
  };
}

/** ffprobe summary of the first video stream (and of the audio stream in `audio`, null when silent). */
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
    audio: probeAudio(file),
  };
}

/**
 * Compare a probe against the requested settings; returns a list of mismatches (empty = pass).
 * `sound`: true = the file must carry the export's audio (AAC, 48 kHz stereo, as long as the video); false = it must be
 * silent (no audio stream); undefined = audio is not checked.
 */
export function checkVideo(probe, { duration, fps, width, height }, { sound } = {}) {
  const problems = [];
  if (probe.codec !== "h264") problems.push(`codec ${probe.codec} ≠ h264`);
  if (probe.width !== width || probe.height !== height) problems.push(`size ${probe.width}×${probe.height} ≠ ${width}×${height}`);
  if (Math.abs(probe.fps - fps) > 0.01) problems.push(`fps ${probe.fps} ≠ ${fps}`);
  if (Math.abs(probe.duration - duration) > 1 / fps + 0.01) problems.push(`duration ${probe.duration.toFixed(3)} s ≠ ${duration} s`);
  const expectedFrames = Math.round(duration * fps);
  if (Number.isFinite(probe.frames) && Math.abs(probe.frames - expectedFrames) > 1) problems.push(`frames ${probe.frames} ≠ ${expectedFrames}`);
  const a = probe.audio;
  if (sound === false && a) problems.push("an audio stream is present although sound was off");
  if (sound === true) {
    if (!a) problems.push("no audio stream");
    else {
      if (a.codec !== "aac") problems.push(`audio codec ${a.codec} ≠ aac`);
      if (a.sampleRate !== 48000) problems.push(`audio ${a.sampleRate} Hz ≠ 48000 Hz`);
      if (a.channels !== 2) problems.push(`audio ${a.channels} channels ≠ 2`);
      if (Math.abs(a.duration - duration) > 0.03) problems.push(`audio duration ${a.duration.toFixed(3)} s ≠ ${duration} s`);
      if (Math.abs(a.start) > 0.001) problems.push(`audio starts at ${a.start} s, not 0`);
    }
  }
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
