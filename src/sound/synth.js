import { mulberry32 } from "./rng.js";

/**
 * Four small synthesizers built only from browser audio parts (oscillators, filters, envelopes).
 * Nothing is downloaded. Each note builds a tiny audio graph that deletes itself when it ends.
 */

// `trim` evens out loudness between instruments so A/B comparisons are fair.
// `baseLength` is the natural ring time in seconds at length = 1.
export const VOICE_TRIM = {
  glass: { trim: 0.45, baseLength: 3.0 },
  warm: { trim: 0.29, baseLength: 2.6 },
  piano: { trim: 0.5, baseLength: 2.8 },
  marimba: { trim: 0.7, baseLength: 0.9 },
};

/**
 * @typedef {object} VoiceParams
 * @property {number} freq
 * @property {number} time   when to start (audio-clock seconds)
 * @property {number} vel    0…1
 * @property {number} length seconds the note rings (already includes instrument and user length)
 * @property {number} pan    -1…1
 * @property {number} gain   overall loudness multiplier
 *
 * A sounding note. `steal(at)` fades it out quickly (used when too many notes sound at once).
 * @typedef {{midi:number, start:number, end:number, vel:number, dead:boolean, stolen:boolean, steal(at:number):void}} Voice
 */

export function makeNoise(ctx) {
  const len = Math.floor(ctx.sampleRate * 0.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = mulberry32(4242);
  for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
  return buf;
}

/** Quick fade-in, then a natural exponential fade to silence. */
function envelope(g, t, peak, attack, total) {
  const floor = 0.0001;
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(Math.max(peak, floor * 2), t + attack);
  g.exponentialRampToValueAtTime(floor, t + total);
}

export function playVoice(ctx, dest, inst, p, noise, midi) {
  const t = p.time;
  const L = Math.max(0.15, p.length);
  const oscs = [];
  const nodes = [];

  const out = ctx.createGain(); // voice-level volume (also used to fade a voice out)
  const base = p.vel * p.gain;
  out.gain.value = base;
  const pan = ctx.createStereoPanner();
  pan.pan.value = p.pan;
  out.connect(pan);
  pan.connect(dest);
  nodes.push(out, pan);

  const partial = (type, freq, amp, attack, decay, to = out, detune = 0) => {
    if (freq > 14000 || amp <= 0.0005) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    envelope(g.gain, t, amp, attack, attack + decay);
    o.connect(g);
    g.connect(to);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
    oscs.push(o);
    nodes.push(g);
  };

  const click = (freq, q, amp, dur) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = Math.min(freq, 12000);
    f.Q.value = q;
    const g = ctx.createGain();
    envelope(g.gain, t, amp, 0.001, dur);
    n.connect(f);
    f.connect(g);
    g.connect(out);
    n.start(t, 0, dur + 0.02);
    oscs.push(n);
    nodes.push(f, g);
  };

  const f0 = p.freq;
  switch (inst) {
    case "glass": {
      // inharmonic partials = the “ting” of glass and bells; the slightly detuned twin makes it shimmer
      partial("sine", f0, 1.0, 0.004, L);
      partial("sine", f0 * 1.004, 0.45, 0.004, L * 0.9);
      partial("sine", f0 * 2.76, 0.32, 0.003, L * 0.5);
      partial("sine", f0 * 5.4, 0.16, 0.002, L * 0.28);
      partial("sine", f0 * 8.93, 0.06, 0.002, L * 0.15);
      break;
    }
    case "warm": {
      // two slightly detuned saws + a sub, through a filter that opens softly then closes
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 0.8;
      const open = Math.min(9000, Math.max(500, f0 * (2.2 + 4 * p.vel)));
      lp.frequency.setValueAtTime(Math.max(200, f0 * 1.2), t);
      lp.frequency.linearRampToValueAtTime(open, t + 0.12);
      lp.frequency.exponentialRampToValueAtTime(Math.max(200, f0 * 1.5), t + L);
      lp.connect(out);
      nodes.push(lp);
      const attack = 0.05;
      const make = (type, freq, amp, detune) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(amp, t + attack);
        g.gain.linearRampToValueAtTime(amp * 0.7, t + L * 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t + L);
        o.connect(g);
        g.connect(lp);
        o.start(t);
        o.stop(t + L + 0.05);
        oscs.push(o);
        nodes.push(g);
      };
      make("sawtooth", f0, 0.5, -7);
      make("sawtooth", f0, 0.5, 7);
      make("sine", f0 / 2, 0.55, 0);
      break;
    }
    case "piano": {
      // a handful of harmonics with slight stretch, higher ones fading faster, plus a soft hammer thud
      const bright = 0.5 + 0.5 * p.vel;
      for (let n = 1; n <= 6; n++) {
        const fr = f0 * n * Math.sqrt(1 + 0.0004 * n * n);
        const amp = (1 / Math.pow(n, 1.25)) * (n === 1 ? 1 : bright);
        const decay = L / (1 + 0.9 * (n - 1));
        partial(n % 2 ? "sine" : "triangle", fr, amp, 0.003, decay);
      }
      partial("sine", f0 * 1.003, 0.35, 0.003, L * 0.6);
      click(f0 * 2.5, 0.8, 0.12 * p.vel, 0.04);
      break;
    }
    case "marimba": {
      // wooden bar: strong fundamental, a quickly fading overtone two octaves up, and a mallet tick
      partial("sine", f0, 1.0, 0.002, L);
      partial("sine", f0 * 3.99, 0.4, 0.002, L * 0.22);
      partial("sine", f0 * 9.9, 0.08, 0.002, L * 0.07);
      click(f0 * 3, 1.2, 0.18 * p.vel, 0.02);
      break;
    }
  }

  const approxEnd = t + L + 0.12;

  const voice = {
    midi,
    start: t,
    end: approxEnd,
    vel: p.vel,
    dead: false,
    stolen: false,
    steal(at) {
      if (voice.dead || voice.stolen) return;
      voice.stolen = true;
      // explicit start value + short straight-line fade: predictable on every browser, no click
      out.gain.cancelScheduledValues(at);
      out.gain.setValueAtTime(base, at);
      out.gain.linearRampToValueAtTime(0, at + 0.03);
      for (const o of oscs) {
        try {
          o.stop(at + 0.06);
        } catch {
          /* already stopped */
        }
      }
      voice.end = Math.min(voice.end, at + 0.08);
    },
  };

  // when the last sound source stops, take the whole note apart so nothing piles up in memory
  let remaining = oscs.length;
  const cleanup = () => {
    if (--remaining > 0) return;
    voice.dead = true;
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  };
  for (const o of oscs) o.onended = cleanup;
  return voice;
}
