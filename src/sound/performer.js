import { geoNoteIndex, geoPan } from "./geo.js";
import { buildPool, clashes, harmonyDegree, isChordTone, midiToFreq, SCALES } from "./music.js";
import { makeNoise, playVoice, VOICE_TRIM } from "./synth.js";

// Turns one strike into (at most) one note: pitch, loudness, voice limit, reverb and the safety limiter.
// Ported from Lightning Sound Lab v1.3. It works on any BaseAudioContext, so the live preview
// (AudioContext) and an offline render (OfflineAudioContext) run exactly the same code.

/**
 * A strike as the Performer sees it (built by src/sound/events.js from the replay model).
 * @typedef {object} SoundEvent
 * @property {number} t          playback (video) seconds
 * @property {number} strength   0…1
 * @property {number} burstIndex 0 = first stroke of a flash
 * @property {number} burstSize
 * @property {number} pitchRand  0…1 reproducible random numbers (Random Notes)
 * @property {number} velRand
 * @property {number} pan        -1…1 (Random Notes; Geographic Mapping pans by longitude)
 * @property {number} [lat]
 * @property {number} [lon]
 *
 * Everything the listener can see about a note that was just played (for the visualizer and tests).
 * @typedef {object} PlayedNote
 * @property {number} eventIndex
 * @property {number} simT       playback seconds of the strike
 * @property {number} time       audio-clock time the note starts
 * @property {number} midi
 * @property {number} vel
 * @property {number} length
 * @property {number} voices     notes sounding right after this one started
 * @property {number} pan        stereo position actually used, -1…1
 * @property {boolean} geographic true when latitude / longitude chose the note and the pan
 * @property {number} repeat     how many times in a row this geographic note has just been struck (0 = first strike)
 * @property {{midi:number, vel:number, length:number}|null} shadow Rich only: the extra quiet chord-tone note
 */

/**
 * Density guard: at most this many notes may START within any rolling second. Squeezing a long recording into a short
 * video can ask for hundreds of notes per second; every note builds a small audio graph, so beyond this
 * the browser could stutter. Events held back are counted (`thinned`) and shown in the interface.
 */
export const MAX_STARTS_PER_SECOND = 60;

/* ---------- Geographic + Musical variation (see VariationMode in music.js) ---------- */

/** Strikes of the same note closer together than this, in PLAYBACK seconds, count as repeats of one another. */
export const RUN_GAP = 1.5;
const REPEAT_PATTERN = [
  [0.78, 0.7],
  [0.6, 0.5],
  [0.7, 0.6],
]; // [loudness, length] x first strike

/**
 * Natural: how the `repeat`-th repeat of the same geographic note is shaped, relative to its first strike.
 * A short fixed cycle keeps it controlled (no randomness); quick repeats also ring shorter, so fewer notes pile up.
 * Pitch, pan and timing are not touched here.
 */
export function repeatShape(repeat, gap) {
  if (repeat <= 0) return { vel: 1, len: 1 };
  const [vel, len] = REPEAT_PATTERN[(repeat - 1) % REPEAT_PATTERN.length];
  return { vel, len: Math.max(0.25, len * Math.min(1, Math.max(0.35, gap * 2))) };
}

/** Rich: a shadow note is quieter and shorter than its main note, and at most one per SHADOW_GAP playback seconds. */
export const SHADOW_VEL = 0.35;
export const SHADOW_LEN = 0.5;
export const SHADOW_GAP = 0.6;
/** Voices always kept free for main notes: a shadow only plays when it still leaves at least this many free. */
export const shadowReserve = (limit) => Math.max(2, Math.ceil(limit / 4));

/**
 * The audio chain:
 *   notes -> dry ----------------\
 *   notes -> reverb send -> reverb -> (mix) -> volume -> limiter -> speakers
 */
export class Performer {
  input; // all notes connect here
  out; // final node (connect to destination / analyser)
  limiter;
  softClip;
  dry;
  send;
  wet;
  master;
  noise;
  voices = [];
  poolKey = "";
  pool = [];

  // musical memory (reset on every pass so each pass is reproducible)
  lastIdx = -1;
  direction = 1;
  recent = [];
  lastPlayTime = -10;
  recentStarts = []; // start times of the notes within the last second (density guard)
  // repeat context for Geographic + Musical (reset on every pass, like the rest of the musical memory)
  runIdx = -1;
  runCount = 0;
  runT = -10;
  lastShadowT = -10;
  shadowSet = new Set(); // voices that are shadow notes: guests that never count against the main notes

  maxVoices = 0; // highest simultaneous count seen (for testing)
  thinned = 0; // events held back by the density guard in this pass
  shadowsPlayed = 0; // Rich: shadow notes played in this pass
  shadowsSkipped = 0; // Rich: shadow notes that were wanted but left out (no suitable note, or not enough free voices)

  ctx;
  /** @param {BaseAudioContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.noise = makeNoise(ctx);
    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.wet = ctx.createGain();
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    // safety limiter: catches rare peaks so nothing clips or gets harsh
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(ctx, 3.2);
    this.input.connect(this.dry);
    this.input.connect(this.send);
    this.send.connect(reverb);
    reverb.connect(this.wet);
    this.dry.connect(this.master);
    this.wet.connect(this.master);
    this.master.connect(this.limiter);
    // last line of defence: rounds off any peak that slips past the limiter so output can never exceed full scale
    this.softClip = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) curve[i] = (Math.tanh((i / 1024 - 1) * 1.6) / 1.6) * 1.0;
    this.softClip.curve = curve;
    this.softClip.oversample = "2x";
    this.limiter.connect(this.softClip);
    this.out = this.softClip;
  }

  /** Smoothly applies the settings that can change while sound is playing. */
  applyLive(c, immediate = false) {
    const now = this.ctx.currentTime;
    const tc = immediate ? 0.001 : 0.06;
    this.master.gain.setTargetAtTime(Math.pow(c.volume, 2) * 3.0, now, tc);
    this.send.gain.setTargetAtTime(c.reverb * 0.8, now, tc);
    this.wet.gain.setTargetAtTime(1, now, tc);
    this.dry.gain.setTargetAtTime(1 - 0.3 * c.reverb, now, tc);
  }

  resetMemory() {
    this.lastIdx = -1;
    this.direction = 1;
    this.recent = [];
    this.lastPlayTime = -10;
    this.recentStarts = [];
    this.thinned = 0;
    this.runIdx = -1;
    this.runCount = 0;
    this.runT = -10;
    this.lastShadowT = -10;
    this.shadowsPlayed = 0;
    this.shadowsSkipped = 0;
  }

  activeVoices(at) {
    this.voices = this.voices.filter((v) => !v.dead && v.end > at);
    for (const v of this.shadowSet) if (!this.voices.includes(v)) this.shadowSet.delete(v);
    return this.voices.length;
  }

  stopAll(fade = 0.08) {
    const now = this.ctx.currentTime;
    for (const v of this.voices) v.steal(now + 0.001 + fade * 0);
    this.voices = [];
  }

  getPool(c) {
    const key = `${c.scale}|${c.root}|${c.lowOctave}|${c.spread}`;
    if (key !== this.poolKey) {
      this.poolKey = key;
      this.pool = buildPool(c);
      this.lastIdx = -1;
      this.runIdx = -1;
    }
    return this.pool;
  }

  /**
   * Plays one lightning event as (at most) one note. `time` is when it should sound.
   * Nothing here ever modifies the event itself.
   * `geo` is the fixed listening area of the current data; Geographic Mapping needs it plus an event with lat/lon.
   */
  trigger(ev, eventIndex, time, c, seed, geo = null) {
    const pool = this.getPool(c);
    if (pool.length === 0) return null;
    while (this.recentStarts.length && this.recentStarts[0] < time - 1) this.recentStarts.shift();
    if (this.recentStarts.length >= MAX_STARTS_PER_SECOND) {
      this.thinned++;
      return null;
    }
    const musical = c.mode === "musical";
    const active = this.activeVoices(time);
    const activeMain = active - this.shadowSet.size; // main notes only: shadow notes never count against them
    const geographic = c.noteMode === "geographic" && geo !== null && ev.lat !== undefined && ev.lon !== undefined;

    /* --- decide the pitch --- */
    let idx;
    let quietener = 1;
    let repeat = 0,
      gap = Infinity;
    if (geographic) {
      // The latitude decides the note. Musical mode only organises *around* it: it may thin out tiny flams
      // (below) and play a note softer when it rubs against a ringing one, but it never swaps the note for another.
      idx = geoNoteIndex(ev.lat, geo, pool.length);
      if (musical) {
        if (time - this.lastPlayTime < 0.05 && ev.strength < 0.7) return null;
        const sounding = this.voices.filter((v) => v.end > time && !this.shadowSet.has(v)).map((v) => v.midi);
        if (sounding.some((m) => clashes(m, pool[idx].midi))) quietener = 0.6;
        if (idx === this.runIdx && ev.t - this.runT <= RUN_GAP) {
          repeat = this.runCount + 1;
          gap = ev.t - this.runT;
        }
      }
    } else if (!musical) {
      // Raw: any note of the scale, straight from the event's random number
      idx = Math.min(pool.length - 1, Math.floor(ev.pitchRand * pool.length));
    } else {
      // Musical: skip tiny flams, and stay near a gentle “home” chord that moves slowly
      if (time - this.lastPlayTime < 0.05 && ev.strength < 0.7) return null;
      const degrees = SCALES[c.scale].steps.length;
      const home = harmonyDegree(ev.t, seed, degrees);
      const sounding = this.voices.filter((v) => v.end > time).map((v) => v.midi);

      let candidates;
      if (ev.burstIndex > 0 && this.lastIdx >= 0) {
        // inside a burst: walk up or down the scale in small steps, like a little run
        if (ev.velRand < 0.2) this.direction *= -1;
        const step = (ev.pitchRand < 0.6 ? 1 : 2) * this.direction;
        let next = this.lastIdx + step;
        if (next < 0 || next >= pool.length) {
          this.direction *= -1;
          next = this.lastIdx - step;
        }
        next = Math.min(pool.length - 1, Math.max(0, next));
        candidates = [next, next + 1, next - 1, next + 2, next - 2];
      } else {
        // a new burst or isolated strike: prefer notes of the current chord, stay near the last note
        const weights = pool.map((n, i) => {
          let w = isChordTone(n.degree, home, degrees) ? 3 : 1;
          if (this.lastIdx >= 0) w *= Math.exp(-Math.pow((i - this.lastIdx) / (pool.length * 0.45), 2));
          if (this.recent.slice(-2).every((r) => r === i) && this.recent.length >= 2) w *= 0.05;
          return w;
        });
        const total = weights.reduce((a, b) => a + b, 0);
        let r = ev.pitchRand * total;
        let pick = 0;
        for (let i = 0; i < weights.length; i++) {
          r -= weights[i];
          if (r <= 0) {
            pick = i;
            break;
          }
          pick = i;
        }
        candidates = [pick, pick + 1, pick - 1, pick + 2, pick - 2];
      }
      const valid = candidates.filter((i) => i >= 0 && i < pool.length);
      const clear = valid.find((i) => !sounding.some((m) => clashes(m, pool[i].midi)));
      if (clear !== undefined) idx = clear;
      else {
        idx = valid[0] ?? 0;
        quietener = 0.6;
      }
    }
    const midi = pool[idx].midi;
    const pan = geographic ? geoPan(ev.lon, geo) : ev.pan;

    /* --- loudness --- */
    const shape = geographic && musical && c.variation !== "strict" ? repeatShape(repeat, gap) : null; // Natural / Rich
    let vel = 0.12 + 0.88 * Math.pow(ev.strength, 1.15);
    vel *= 0.85 + 0.3 * ev.velRand;
    if (musical) {
      vel = 0.3 + 0.7 * vel; // narrower dynamic range
      vel *= Math.pow(0.92, ev.burstIndex); // runs fade gently
      vel *= 1 / Math.sqrt(1 + 0.3 * activeMain); // many notes already ringing: be politer
      vel *= quietener;
      if (shape) vel *= shape.vel;
    }
    vel = Math.min(1, vel);

    /* --- voice limit --- */
    const limit = Math.max(1, Math.floor(c.polyphony));
    if (activeMain >= limit) {
      if (musical && ev.strength < 0.45) return null; // weak strikes simply wait out
      const alive = this.voices.filter((v) => v.end > time);
      // remove the oldest (Raw) or the quietest-oldest (Musical)
      const victim = alive.sort((a, b) => (musical ? a.vel * (a.end - time) - b.vel * (b.end - time) : a.start - b.start))[0];
      victim?.steal(time);
      this.voices = this.voices.filter((v) => v !== victim);
    } else if (active >= limit) {
      // only shadow notes are in the way: they give way to the main note, so main notes behave as if they were not there
      const guest = this.voices.filter((v) => v.end > time && this.shadowSet.has(v)).sort((a, b) => a.start - b.start)[0];
      guest?.steal(time);
      this.voices = this.voices.filter((v) => v !== guest);
    }

    /* --- sound --- */
    const info = VOICE_TRIM[c.instrument];
    const length = info.baseLength * c.length * (shape?.len ?? 1);
    // headroom shrinks a little when many voices are allowed, so the sum stays safe
    const headroom = 1 / Math.sqrt(Math.max(3, limit) / 3);
    const gain = info.trim * headroom;
    const voice = playVoice(this.ctx, this.input, c.instrument, { freq: midiToFreq(midi), time, vel, length, pan, gain }, this.noise, midi);
    this.voices.push(voice);
    this.recentStarts.push(time);
    const count = this.activeVoices(time);
    this.maxVoices = Math.max(this.maxVoices, count);

    this.lastIdx = idx;
    this.recent.push(idx);
    if (this.recent.length > 4) this.recent.shift();
    this.lastPlayTime = time;
    if (geographic) {
      this.runIdx = idx;
      this.runCount = repeat;
      this.runT = ev.t;
    }

    const shadow =
      geographic && musical && c.variation === "rich" && repeat > 0
        ? this.playShadow(ev, time, c, seed, pool, idx, vel, length, pan, gain, limit)
        : null;
    return { eventIndex, simT: ev.t, time, midi, vel, length, voices: count, pan, geographic, repeat, shadow };
  }

  /**
   * Rich: on a repeated strike, add one quiet, short note a few scale steps BELOW the main note. It must be a tone of the
   * current chord (the same harmony rule Random Notes uses), must not rub against anything sounding, and may only use
   * voices that still leave the main notes their reserve. It never replaces, delays or steals from a main note.
   */
  playShadow(ev, time, c, seed, pool, idx, mainVel, mainLength, pan, gain, limit) {
    if (ev.t - this.lastShadowT < SHADOW_GAP) return null; // spacing, not a refusal
    const degrees = SCALES[c.scale].steps.length;
    const home = harmonyDegree(ev.t, seed, degrees);
    const sounding = this.voices.filter((v) => v.end > time).map((v) => v.midi);
    const options = [2, 3, 4]
      .map((k) => idx - k)
      .filter((j) => j >= 0 && isChordTone(pool[j].degree, home, degrees) && !sounding.some((m) => clashes(m, pool[j].midi)));
    if (!options.length || this.activeVoices(time) + 1 > limit - shadowReserve(limit)) {
      this.shadowsSkipped++;
      return null;
    }
    const midi = pool[options[Math.min(options.length - 1, Math.floor(ev.pitchRand * options.length))]].midi;
    const vel = Math.min(1, mainVel * SHADOW_VEL),
      length = mainLength * SHADOW_LEN;
    const voice = playVoice(this.ctx, this.input, c.instrument, { freq: midiToFreq(midi), time, vel, length, pan, gain }, this.noise, midi);
    this.voices.push(voice);
    this.shadowSet.add(voice);
    this.lastShadowT = ev.t;
    this.shadowsPlayed++;
    this.maxVoices = Math.max(this.maxVoices, this.activeVoices(time));
    return { midi, vel, length };
  }
}

/** A generated reverb tail: decaying stereo noise that gets darker over time. */
function makeImpulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  let seed = 98765;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const cutoff = 0.55 * Math.pow(1 - x, 2) + 0.04; // darker as it fades
      lp += cutoff * (rnd() - lp);
      d[i] = lp * Math.pow(1 - x, 2.4) * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
    }
  }
  return buf;
}
