// Sound for an exported MP4: the Sound tab's engine (src/sound/) rendered offline with node-web-audio-api, aligned to
// the frames and muxed into the HyperFrames video as AAC. The picture is never re-encoded.
//
//   every frame that shows a new flash in the picture → its note starts exactly on that frame's time
//   the limiter's look-ahead is measured and removed, so the delay that remains is zero, not ~11 ms
//   the sound fades out over the closing hold and is exactly as long as the video
import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";
import { OfflineAudioContext } from "node-web-audio-api";
import { listeningArea } from "../sound/area.js";
import { soundEvents, strikeVoicing } from "../sound/events.js";
import { endFade, measureChainDelay, renderSound } from "../sound/render.js";
import { SOUND_MAX_SECONDS, sanitizeSoundSettings } from "../sound/settings.js";

/** Audio of an export: AAC-LC, 48 kHz stereo, 256 kbit/s. */
export const SOUND_EXPORT = Object.freeze({ sampleRate: 48000, channels: 2, codec: "aac", bitrate: "256k", maxDuration: SOUND_MAX_SECONDS });

/**
 * The sound an export request asks for, or null for a silent video. Accepts the Sound tab's settings (as stored in
 * the browser or in a profile); the heard slot is the active one. Everything is validated.
 * @returns {{music: import("../sound/music.js").MusicConfig, area: "data"|"frame", slot: "A"|"B"} | null}
 */
export function exportSound(input) {
  if (!input || typeof input !== "object") return null;
  const s = sanitizeSoundSettings(input);
  if (!s.enabled) return null;
  return { music: s.slots[s.active], area: s.area, slot: s.active };
}

/** A reason this video cannot get sound, or null. Checked before rendering, so a long job never fails at the end. */
export function soundProblem(duration, sound) {
  if (!sound) return null;
  if (duration > SOUND_EXPORT.maxDuration)
    return `Sound can be exported for videos up to ${SOUND_EXPORT.maxDuration / 60} minutes; that is ${SOUND_EXPORT.maxDuration} s and this one is ${Math.round(duration)} s. Shorten the video or switch sound off to export it silent.`;
  return null;
}

let chainDelay = null;
/** The output chain's delay at the export sample rate (measured once per process). */
async function exportChainDelay() {
  chainDelay ??= await measureChainDelay(OfflineAudioContext, SOUND_EXPORT.sampleRate);
  return chainDelay;
}

/**
 * Renders the sound of a replay model, frame-aligned and exactly as long as the video.
 * @param {{model: object, dataset: object, sound: NonNullable<ReturnType<typeof exportSound>>}} o
 * @returns {Promise<{channels: Float32Array[], sampleRate: number, summary: object}>}
 */
export async function renderExportSound({ model, dataset, sound }) {
  const voicing = strikeVoicing(dataset);
  const picture = model.extent; // the whole video frame: only strikes inside it are heard
  const events = soundEvents(model, voicing, picture);
  const area = listeningArea(sound.area, dataset, model.settings.frame ?? picture);
  const lead = await exportChainDelay();
  const { channels, notes } = await renderSound({
    OfflineAudioContext, events, music: sound.music, seed: voicing.seed, bounds: area.bounds,
    duration: model.settings.duration, fade: endFade(model.timeMap), lead,
    sampleRate: SOUND_EXPORT.sampleRate, channels: SOUND_EXPORT.channels,
  });
  return {
    channels,
    sampleRate: SOUND_EXPORT.sampleRate,
    summary: {
      slot: sound.slot, instrument: sound.music.instrument, noteMode: sound.music.noteMode, area: area.origin,
      flashes: events.length, notes: notes.length, chordNotes: notes.reduce((n, x) => n + x.chord.length, 0),
      alignedMs: +(lead * 1000).toFixed(2),
      bitrate: SOUND_EXPORT.bitrate,
    },
  };
}

/** Interleaved little-endian float32 PCM (what ffmpeg reads as `-f f32le`). */
export function interleave(channels) {
  const n = channels[0].length, c = channels.length;
  const out = new Float32Array(n * c);
  for (let ch = 0; ch < c; ch++) {
    const d = channels[ch];
    for (let i = 0; i < n; i++) out[i * c + ch] = d[i];
  }
  return Buffer.from(out.buffer);
}

/**
 * Adds the sound to an MP4 in place: the H.264 stream is copied untouched, the PCM becomes AAC 256 kbit/s, and the
 * audio is cut to the video's duration. ffmpeg's edit list removes the AAC encoder delay, so sample 0 plays at 0 s.
 */
export function muxSound(file, { channels, sampleRate }, duration) {
  const tmp = file.replace(/\.mp4$/, ".sound.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-i", file,
    "-f", "f32le", "-ar", String(sampleRate), "-ac", String(channels.length), "-i", "pipe:0",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", SOUND_EXPORT.codec, "-b:a", SOUND_EXPORT.bitrate,
    "-t", String(duration),
    "-movflags", "+faststart",
    tmp,
  ], { input: interleave(channels), maxBuffer: 16e6 });
  renameSync(tmp, file);
}
