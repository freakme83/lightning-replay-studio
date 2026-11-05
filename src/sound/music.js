// Sound settings, scales and the gentle harmony rules (ported from Lightning Sound Lab v1.3).
// Nothing here touches audio or the replay: the same settings always give the same notes.

/* ---------- Settings types ---------- */

/**
 * @typedef {"glass"|"warm"|"piano"|"marimba"} InstrumentId
 * @typedef {"raw"|"musical"} ListenMode
 * Where notes come from: a seeded random choice per strike, or the strike's latitude.
 * @typedef {"random"|"geographic"} NoteMode
 * How Geographic Mapping behaves in Musical mode (it changes nothing anywhere else):
 *  strict  - every strike plays its geographic note exactly
 *  natural - same notes; repeated notes vary in loudness and length, and ring shorter when strikes come fast
 *  rich    - natural, plus quiet, short chord-tone "shadow" notes below the main note on some repeats
 * @typedef {"strict"|"natural"|"rich"} VariationMode
 *
 * @typedef {object} MusicConfig
 * @property {ListenMode} mode
 * @property {NoteMode} noteMode
 * @property {VariationMode} variation
 * @property {string} scale        key of SCALES
 * @property {number} root         0 = C … 11 = B
 * @property {InstrumentId} instrument
 * @property {number} length       0.25…3 note length multiplier (1 = natural)
 * @property {number} lowOctave    lowest octave, 1…6
 * @property {number} spread       how many octaves are used, 1…4
 * @property {number} reverb       0…1
 * @property {number} polyphony    1…24
 * @property {number} volume       0…1
 * @property {number} tightness    0…1 (Musical mode, Random Notes only) gentle pull of timing towards a soft pulse
 */

export const VARIATION_MODES = ["strict", "natural", "rich"];

export const SCALES = {
  majorPent: { name: "Major pentatonic", hint: "Bright and open, hard to make sound wrong", steps: [0, 2, 4, 7, 9] },
  minorPent: { name: "Minor pentatonic", hint: "Calm, a little wistful", steps: [0, 3, 5, 7, 10] },
  naturalMinor: { name: "Natural minor", hint: "Darker, more dramatic", steps: [0, 2, 3, 5, 7, 8, 10] },
  major: { name: "Major", hint: "Classic, happy and clear", steps: [0, 2, 4, 5, 7, 9, 11] },
  dorian: { name: "Dorian", hint: "Minor, but with a hopeful glow", steps: [0, 2, 3, 5, 7, 9, 10] },
  lydian: { name: "Lydian", hint: "Dreamy and floating", steps: [0, 2, 4, 6, 7, 9, 11] },
  wholeTone: { name: "Whole tone", hint: "Weightless, no clear “home” note", steps: [0, 2, 4, 6, 8, 10] },
  hirajoshi: { name: "Hirajoshi", hint: "Japanese-style, sparse and serene", steps: [0, 2, 3, 7, 8] },
};

export const ROOT_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export const INSTRUMENTS = {
  glass: { name: "Glass / bell", blurb: "Shimmering, long ringing" },
  warm: { name: "Warm synth", blurb: "Soft, glowing pad-like notes" },
  piano: { name: "Soft piano", blurb: "Gentle keys with a quiet hammer" },
  marimba: { name: "Marimba / pluck", blurb: "Short, woody, percussive" },
};

export const DEFAULT_A = {
  mode: "musical",
  noteMode: "random",
  variation: "strict",
  scale: "majorPent",
  root: 0,
  instrument: "glass",
  length: 1,
  lowOctave: 4,
  spread: 2,
  reverb: 0.4,
  polyphony: 8,
  volume: 0.8,
  tightness: 0.3,
};
export const DEFAULT_B = {
  mode: "musical",
  noteMode: "random",
  variation: "strict",
  scale: "minorPent",
  root: 9,
  instrument: "warm",
  length: 1,
  lowOctave: 3,
  spread: 2,
  reverb: 0.5,
  polyphony: 8,
  volume: 0.8,
  tightness: 0.3,
};

/** Starting points: plain-language presets for the current slot. They are suggestions, not locks. */
export const SOUND_PRESETS = [
  {
    name: "Crystal rain",
    hint: "Glass, major pentatonic, airy",
    cfg: { instrument: "glass", scale: "majorPent", root: 0, lowOctave: 5, spread: 2, length: 1, reverb: 0.5 },
  },
  {
    name: "Night synth",
    hint: "Warm synth, minor pentatonic, low",
    cfg: { instrument: "warm", scale: "minorPent", root: 9, lowOctave: 3, spread: 2, length: 1.4, reverb: 0.55 },
  },
  {
    name: "Soft keys",
    hint: "Piano, natural minor",
    cfg: { instrument: "piano", scale: "naturalMinor", root: 2, lowOctave: 3, spread: 3, length: 1, reverb: 0.35 },
  },
  {
    name: "Wooden drops",
    hint: "Marimba, Dorian, close and dry",
    cfg: { instrument: "marimba", scale: "dorian", root: 7, lowOctave: 4, spread: 2, length: 1, reverb: 0.2 },
  },
  {
    name: "Floating",
    hint: "Glass, Lydian, long and spacious",
    cfg: { instrument: "glass", scale: "lydian", root: 5, lowOctave: 4, spread: 3, length: 1.8, reverb: 0.75 },
  },
  {
    name: "Distant storm",
    hint: "Warm synth, minor, deep and wide",
    cfg: { instrument: "warm", scale: "naturalMinor", root: 4, lowOctave: 2, spread: 2, length: 2, reverb: 0.8 },
  },
];

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Makes sure a (possibly hand-edited or old) config is valid. */
export function sanitizeMusic(c, fallback) {
  const f = fallback;
  const x = c ?? {};
  return {
    mode: x.mode === "raw" || x.mode === "musical" ? x.mode : f.mode,
    noteMode: x.noteMode === "random" || x.noteMode === "geographic" ? x.noteMode : f.noteMode,
    variation: x.variation && VARIATION_MODES.includes(x.variation) ? x.variation : f.variation,
    scale: x.scale && x.scale in SCALES ? x.scale : f.scale,
    root: Math.round(clamp(Number(x.root ?? f.root), 0, 11)),
    instrument: x.instrument && x.instrument in INSTRUMENTS ? x.instrument : f.instrument,
    length: clamp(Number(x.length ?? f.length), 0.25, 3),
    lowOctave: Math.round(clamp(Number(x.lowOctave ?? f.lowOctave), 1, 6)),
    spread: Math.round(clamp(Number(x.spread ?? f.spread), 1, 4)),
    reverb: clamp(Number(x.reverb ?? f.reverb), 0, 1),
    polyphony: Math.round(clamp(Number(x.polyphony ?? f.polyphony), 1, 24)),
    volume: clamp(Number(x.volume ?? f.volume), 0, 1),
    tightness: clamp(Number(x.tightness ?? f.tightness), 0, 1),
  };
}

export function randomMusic(rand = Math.random, keepMode) {
  const scales = Object.keys(SCALES);
  const insts = Object.keys(INSTRUMENTS);
  return {
    mode: keepMode ?? "musical",
    noteMode: "random", // callers that want to keep the current note source and variation copy them over
    variation: "strict",
    scale: scales[Math.floor(rand() * scales.length)],
    root: Math.floor(rand() * 12),
    instrument: insts[Math.floor(rand() * insts.length)],
    length: Math.round((0.6 + rand() * 1.8) * 20) / 20,
    lowOctave: 2 + Math.floor(rand() * 3),
    spread: 1 + Math.floor(rand() * 3),
    reverb: Math.round(rand() * 80) / 100,
    polyphony: 8,
    volume: 0.8,
    tightness: Math.round(rand() * 60) / 100,
  };
}

/* ---------- Note pool ---------- */

/** All scale notes between the lowest octave and (lowest octave + spread), sorted from low to high. */
export function buildPool(c) {
  const steps = SCALES[c.scale].steps;
  const low = 12 * (c.lowOctave + 1) + c.root; // C4 = 60
  const high = low + 12 * c.spread;
  const pool = [];
  for (let oct = 0; oct <= c.spread; oct++) {
    steps.forEach((s, degree) => {
      const midi = low + 12 * oct + s;
      if (midi >= low && midi <= high) pool.push({ midi, degree });
    });
  }
  return pool.sort((a, b) => a.midi - b.midi);
}

/** e.g. 60 -> "C4" */
export const noteName = (midi) => `${ROOT_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* ---------- Gentle harmony (Musical mode) ---------- */

/** Which scale degree acts as the “home” of the moment. Changes every 7.5 s, reproducibly from the seed. */
export function harmonyDegree(simT, seed, degrees) {
  const segment = Math.floor(simT / 7.5) % 4;
  if (segment === 0) return 0;
  const options = [Math.round((degrees * 3) / 7), Math.round((degrees * 4) / 7), Math.round((degrees * 5) / 7), 0];
  let h = (Math.floor(seed) + 1) * 2654435761 + segment * 40503;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return options[h % options.length] % degrees;
}

export function isChordTone(degree, harmony, degrees) {
  const d = (degree - harmony + degrees) % degrees;
  return d === 0 || d === 2 % degrees || d === 4 % degrees;
}

/* ---------- Timing ---------- */

/**
 * Musical mode: delay an event slightly so it lands closer to a soft pulse (every 0.25 s of simulation).
 * Not applied to located events in Geographic Mapping: their timestamps are the rhythm.
 * Never moves earlier, never more than 0.12 s, and only partly (tightness), so the timing stays organic.
 */
export function timingDelay(ev, c) {
  if (c.mode !== "musical" || c.tightness <= 0) return 0;
  if (c.noteMode === "geographic" && ev.lat !== undefined) return 0; // geographic events keep their real timing
  const grid = 0.25;
  const toNext = (grid - (ev.t % grid)) % grid;
  return Math.min(0.12, toNext * 0.6 * c.tightness);
}

/** Does this pair of pitches sound harshly “rubbing”? (a semitone apart, in any octave) */
export function clashes(a, b) {
  const d = Math.abs(a - b) % 12;
  return d === 1 || d === 11;
}
