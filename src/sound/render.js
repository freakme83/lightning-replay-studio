// Scheduling shared by the live preview and offline renders: a flash at video time t sounds at `offset + t` on the
// audio clock (plus the small musical timing pull, which the studio keeps at 0), and the sound fades out over the
// replay's closing hold so it ends with the video.
import { timingDelay } from "./music.js";
import { Performer } from "./performer.js";
import { makeNoise, playVoice } from "./synth.js";

/** Audio-clock time at which event `ev` should sound, for a pass whose video time 0 is at `offset`. */
export const noteTime = (ev, music, offset) => offset + ev.t + timingDelay(ev, music);

/** A Performer as the studio uses it: flash mode (every visible flash is heard; see performer.js). */
export const studioPerformer = (ctx) => new Performer(ctx, { flashes: true });

/* ---------- the end of the video ---------- */

/**
 * The fade-out at the end: over the replay's closing hold, from the end of the strikes' span (where the last strike
 * can appear) to the end of the video. Notes still ringing there fade smoothly instead of being cut; the video keeps
 * its length. Very short videos have a short hold and so a short fade (src/core/timeline.js).
 * @param {{duration:number, tail:number}} timeMap
 */
export const endFade = (timeMap) => ({ start: Math.max(0, timeMap.duration - timeMap.tail), end: timeMap.duration });

/** Gain of the fade at video time t: 1 before it, an equal-power curve down to exactly 0 at the end, 0 after. */
export function fadeGain(t, fade) {
  if (t <= fade.start) return 1;
  if (t >= fade.end) return 0;
  return Math.cos(((t - fade.start) / (fade.end - fade.start)) * (Math.PI / 2));
}

/**
 * Automates `param` (a gain) with the fade for a pass whose video time 0 is at audio time `offset`, starting at video
 * time `from` (a preview may start anywhere). `offset + from` must not be in the past.
 */
export function scheduleFade(param, fade, offset, from = 0) {
  param.cancelScheduledValues(0);
  param.setValueAtTime(fadeGain(from, fade), offset + from);
  const s = Math.max(fade.start, from);
  if (fade.end <= s) return;
  const n = 64, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fadeGain(s + ((fade.end - s) * i) / (n - 1), fade);
  param.setValueCurveAtTime(curve, offset + s, fade.end - s);
}

/* ---------- offline ---------- */

/**
 * Plays every event into a Performer at once (for an OfflineAudioContext, whose clock does not run until
 * `startRendering`). Returns the notes that were played.
 * @param {Performer} perf
 * @param {readonly import("./performer.js").SoundEvent[]} events
 * @param {import("./music.js").MusicConfig} music
 * @param {number} seed
 * @param {import("./geo.js").GeoBounds|null} bounds listening area
 */
export function scheduleAll(perf, events, music, seed, bounds, offset = 0) {
  perf.resetMemory();
  perf.applyLive(music, true);
  const notes = [];
  events.forEach((ev, i) => {
    const n = perf.trigger(ev, i, noteTime(ev, music, offset), music, seed, bounds);
    if (n) notes.push(n);
  });
  return notes;
}

/**
 * The constant delay of the Performer's output chain in seconds: the safety limiter looks a few milliseconds ahead
 * and the soft clipper oversamples, so a note scheduled at time t is heard slightly after t. Measured (not assumed)
 * by rendering the same note with and without the chain, because it depends on the Web Audio implementation.
 */
export async function measureChainDelay(OfflineAudioContext, sampleRate = 48000) {
  const onset = async (throughChain) => {
    const ctx = new OfflineAudioContext(1, Math.round(sampleRate * 0.15), sampleRate);
    const perf = new Performer(ctx);
    perf.applyLive({ volume: 0.8, reverb: 0 }, true);
    if (throughChain) perf.out.connect(ctx.destination);
    playVoice(ctx, throughChain ? perf.input : ctx.destination, "marimba", { freq: 440, time: 0.02, vel: 1, length: 0.2, pan: 0, gain: 0.3 }, makeNoise(ctx), 69);
    const d = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (const x of d) peak = Math.max(peak, Math.abs(x));
    let i = 0;
    while (i < d.length && Math.abs(d[i]) < peak * 0.01) i++;
    return i;
  };
  const [bare, chain] = [await onset(false), await onset(true)];
  return Math.max(0, chain - bare) / sampleRate;
}

/**
 * Renders the sound of a whole replay. `fade` (see endFade) fades it out at the end; null leaves it unfaded.
 * `lead` compensates the output chain's delay (see measureChainDelay): the render runs `lead` seconds longer and
 * `channels` drops them from the start, so in `channels` a note scheduled at video time t is heard exactly at t and the
 * fade lands on the video's own times. `channels` holds exactly `duration` seconds (the video's length) per channel;
 * sample 0 is video time 0. `buffer` is the raw render (with the delay, `lead` seconds longer).
 * Works with the browser's OfflineAudioContext or any implementation of it (tests and exports use node-web-audio-api).
 * @returns {Promise<{buffer: AudioBuffer, channels: Float32Array[], notes: import("./performer.js").PlayedNote[], performer: Performer}>}
 */
export async function renderSound({ OfflineAudioContext, events, music, seed, bounds, duration, fade = null, lead = 0, sampleRate = 48000, channels = 2 }) {
  const skip = Math.max(0, Math.round(lead * sampleRate));
  const length = Math.max(1, Math.round(duration * sampleRate));
  const ctx = new OfflineAudioContext(channels, length + skip, sampleRate);
  const performer = studioPerformer(ctx);
  const out = ctx.createGain();
  performer.out.connect(out);
  out.connect(ctx.destination);
  if (fade) scheduleFade(out.gain, fade, skip / sampleRate, 0);
  const notes = scheduleAll(performer, events, music, seed, bounds, 0);
  const buffer = await ctx.startRendering();
  const data = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) data.push(buffer.getChannelData(ch).slice(skip, skip + length));
  return { buffer, channels: data, notes, performer };
}
