// Scheduling shared by the live preview and offline renders: a strike at video time t sounds at
// `offset + t` on the audio clock (plus the small musical timing pull, which Geographic Mapping never uses).
import { timingDelay } from "./music.js";
import { Performer } from "./performer.js";
import { makeNoise, playVoice } from "./synth.js";

/** Audio-clock time at which event `ev` should sound, for a pass whose video time 0 is at `offset`. */
export const noteTime = (ev, music, offset) => offset + ev.t + timingDelay(ev, music);

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
 * Renders the sound of a whole replay into an AudioBuffer: sample 0 is video time 0, and the buffer is exactly
 * `duration` seconds long (the video's length). Works with the browser's OfflineAudioContext or any
 * implementation of it (tests use node-web-audio-api).
 * @returns {Promise<{buffer: AudioBuffer, notes: import("./performer.js").PlayedNote[], performer: Performer}>}
 */
export async function renderSound({ OfflineAudioContext, events, music, seed, bounds, duration, sampleRate = 48000, channels = 2 }) {
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.round(duration * sampleRate)), sampleRate);
  const performer = new Performer(ctx);
  performer.out.connect(ctx.destination);
  const notes = scheduleAll(performer, events, music, seed, bounds, 0);
  const buffer = await ctx.startRendering();
  return { buffer, notes, performer };
}
