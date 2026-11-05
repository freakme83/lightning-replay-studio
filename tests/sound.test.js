// Sound tab: the Lightning Sound Lab engine on the replay's strikes (node --test tests/sound.test.js).
// Audio is rendered offline with node-web-audio-api, the same Web Audio API the browser uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OfflineAudioContext } from "node-web-audio-api";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay } from "../src/core/replay.js";
import { ROOT } from "../src/export/composition.js";
import { INSTRUMENTS, buildPool, timingDelay, SCALES } from "../src/sound/music.js";
import { GEO_PAN_MAX, geoNoteIndex, geoPan, suggestBounds } from "../src/sound/geo.js";
import { dataArea, listeningArea, metaArea } from "../src/sound/area.js";
import { flashTime, soundEvents, strikeVoicing } from "../src/sound/events.js";
import { measureChainDelay, renderSound } from "../src/sound/render.js";
import { SoundPlayer } from "../src/sound/player.js";
import { SHADOW_GAP, SHADOW_LEN, SHADOW_VEL } from "../src/sound/performer.js";
import {
  STUDIO_A, STUDIO_B, defaultSoundSettings, loadSoundSettings, sanitizeSoundSettings, saveSoundSettings,
} from "../src/sound/settings.js";

const RATE = 48000;
const sample = parseDataset(readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8"), "sample-ankara-storm.json");
const voicing = strikeVoicing(sample);
const area = dataArea(sample).bounds;

function setup(settings = { duration: 20 }, ds = sample) {
  const model = buildReplay(ds, settings);
  const v = ds === sample ? voicing : strikeVoicing(ds);
  return { model, voicing: v, events: soundEvents(model, v) };
}
const music = (over = {}) => ({ ...STUDIO_A, ...over });

async function render(events, cfg, { bounds = area, duration = 20, seed = voicing.seed } = {}) {
  const r = await renderSound({ OfflineAudioContext, events, music: cfg, seed, bounds, duration, sampleRate: RATE });
  let peak = 0, bad = 0, hash = 0, sumSq = 0, n = 0;
  for (let ch = 0; ch < r.buffer.numberOfChannels; ch++) {
    const d = r.buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (!Number.isFinite(x)) { bad++; continue; }
      peak = Math.max(peak, Math.abs(x));
      sumSq += x * x; n++;
      if (i % 97 === 0) hash = (Math.imul(hash, 31) + Math.round(x * 1e5)) | 0;
    }
  }
  return { ...r, peak, bad, hash, rms: Math.sqrt(sumSq / n) };
}

test("SL1. every note starts on the first video frame that shows its strike", async () => {
  const { model, events } = setup({ duration: 20 });
  const fps = model.settings.fps;
  assert.equal(events.length, model.events.length);
  for (const [i, ev] of events.entries()) {
    const e = model.events[i];
    assert.equal(ev.strike, e.index);
    const frame = Math.round(ev.t * fps);
    assert.ok(Math.abs(ev.t * fps - frame) < 1e-9, "note time is on the frame grid");
    assert.equal(frame, model.timeMap.frameOf(e.v, fps), "same frame rule as the preview and the export");
    // Drawn on that frame and not on the one before.
    assert.ok(model.countAt(ev.t) > i);
    assert.ok(frame === 0 || model.countAt((frame - 1) / fps) <= i);
  }
  // Every note of every mode is played at exactly its event's time (no timing pull in the studio).
  for (const cfg of [music(), music({ mode: "raw" }), { ...STUDIO_B }, { ...STUDIO_B, mode: "raw" }, music({ variation: "rich" })]) {
    const { notes } = await render(events, cfg);
    assert.ok(notes.length > 50);
    for (const n of notes) assert.equal(n.time, events[n.eventIndex].t, `${cfg.noteMode}/${cfg.mode}`);
    assert.ok(events.every((ev) => timingDelay(ev, cfg) === 0));
  }
  // The audio itself: silence before the first strike's frame, sound right after it. The output chain (the safety
  // limiter's look-ahead) adds a small constant delay; it is measured, far below one frame, and the live preview
  // compensates for it.
  const delay = await measureChainDelay(OfflineAudioContext, RATE);
  assert.ok(delay > 0 && delay < 0.5 / fps, `output chain delay ${(delay * 1000).toFixed(1)} ms is under half a frame`);
  const { buffer } = await render(events, music({ mode: "raw" }));
  const first = Math.round(events[0].t * RATE);
  const d = buffer.getChannelData(0);
  let before = 0, after = 0;
  for (let i = 0; i < first; i++) before = Math.max(before, Math.abs(d[i]));
  for (let i = first; i < first + Math.round((delay + 0.004) * RATE); i++) after = Math.max(after, Math.abs(d[i]));
  assert.equal(before, 0, "nothing sounds before the first flash");
  assert.ok(after > 1e-3, `the first note is audible within the chain delay + 4 ms of its frame (${after})`);
  assert.equal(buffer.length, 20 * RATE, "the sound is exactly as long as the video");
});

test("SL2. strike timing follows the replay's time map; each strike keeps its own voicing", () => {
  const a = setup({ duration: 20 }), b = setup({ duration: 45 });
  assert.equal(a.events.length, b.events.length);
  for (let i = 0; i < a.events.length; i++) {
    assert.ok(Math.abs(b.events[i].t - flashTime(b.model.timeMap, b.model.events[i].v, 24)) < 1e-12);
    for (const k of ["strength", "pitchRand", "velRand", "pan", "lat", "lon", "strike"]) assert.equal(a.events[i][k], b.events[i][k], k);
  }
  // A narrower time range: strikes outside it are not in the replay, so they do not sound either.
  const startMs = sample.events[50].t, endMs = sample.events[120].t;
  const r = setup({ duration: 20, timeRange: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() } });
  assert.equal(r.events.length, r.model.events.length);
  assert.ok(r.events.length < a.events.length && r.model.excluded > 0);
  const byStrike = new Map(a.events.map((e) => [e.strike, e]));
  for (const e of r.events) assert.equal(e.strength, byStrike.get(e.strike).strength, "a strike sounds the same in any time range");
  // Same dataset, same seed, anywhere.
  assert.equal(strikeVoicing(sample).seed, voicing.seed);
  assert.ok(Object.isFrozen(a.events) && Object.isFrozen(a.events[0]));
});

test("SL3. the listening area: dataset metadata, a suggestion, or the video's map frame", () => {
  // Blitzortung-style capture: centre + side length.
  const square = metaArea({ centerLat: 40.05, centerLon: 10.28, sideKm: 100 });
  assert.ok(Math.abs((square.north - square.south) * 111.2 - 100) < 1e-6 && square.west < 10.28 && square.east > 10.28);
  // Bounds object, GeoJSON bbox, radius, CSV-style strings.
  assert.deepEqual(metaArea({ bounds: { south: 1, north: 2, west: 3, east: 4 } }), { south: 1, north: 2, west: 3, east: 4 });
  assert.deepEqual(metaArea({ bbox: [3, 1, 4, 2] }), { south: 1, north: 2, west: 3, east: 4 });
  assert.ok(metaArea({ area: { center: { lat: 40, lon: 30 }, radiusKm: 25 } }).north > 40.2);
  assert.ok(metaArea({ centerLat: "40", centerLon: "30", radiusKm: "10" }));
  assert.equal(metaArea({ bounds: { south: 2, north: 1, west: 3, east: 4 } }), null, "an invalid area is not used");
  assert.equal(metaArea({}), null);
  // No area in the file: suggested once from all valid strikes.
  const d = dataArea(sample);
  assert.equal(d.origin, "suggested");
  assert.deepEqual(d.bounds, suggestBounds(sample.events));
  const withArea = parseDataset(JSON.stringify({ meta: { centerLat: 39.9, centerLon: 32.8, sideKm: 60 }, events: [{ timestamp: "2026-11-01T12:00:00Z", lat: 39.9, lon: 32.8 }] }), "a.json");
  assert.equal(dataArea(withArea).origin, "file");
  // Map frame, and the fallback while there is none.
  const frame = { west: 32, south: 39.5, east: 33.5, north: 40.4 };
  assert.deepEqual(listeningArea("frame", sample, frame), { bounds: { south: 39.5, north: 40.4, west: 32, east: 33.5 }, origin: "frame", choice: "frame", fallback: false });
  const fb = listeningArea("frame", sample, null);
  assert.equal(fb.fallback, true);
  assert.deepEqual(fb.bounds, d.bounds);
  assert.equal(listeningArea("data", sample, frame).origin, "suggested");
});

test("SL4. Geographic Mapping: latitude chooses the note, longitude the pan, in the chosen area", async () => {
  const { model, events } = setup({ duration: 20 });
  const frame = buildReplay(sample, { duration: 20 }).extent;
  for (const bounds of [area, listeningArea("frame", sample, frame).bounds]) {
    for (const variation of ["strict", "natural", "rich"]) {
      const cfg = music({ variation });
      const pool = buildPool(cfg);
      const { notes } = await render(events, cfg, { bounds });
      assert.ok(notes.length > 50);
      for (const n of notes) {
        const ev = events[n.eventIndex];
        assert.ok(n.geographic);
        assert.equal(n.midi, pool[geoNoteIndex(ev.lat, bounds, pool.length)].midi);
        assert.equal(n.pan, geoPan(ev.lon, bounds));
        assert.ok(Math.abs(n.pan) <= GEO_PAN_MAX);
      }
    }
  }
  // A different area gives different notes for the same strikes (the choice matters).
  const pool = buildPool(music());
  const idx = (b) => events.map((e) => geoNoteIndex(e.lat, b, pool.length)).join();
  assert.notEqual(idx(area), idx(listeningArea("frame", sample, frame).bounds));
  assert.equal(model.events.length, events.length);
});

test("SL5. clean, controlled audio for every instrument; the voice limit holds", async () => {
  const { events } = setup({ duration: 20 });
  const rms = [];
  for (const instrument of Object.keys(INSTRUMENTS)) {
    for (const base of [STUDIO_A, STUDIO_B]) {
      const r = await render(events, { ...base, instrument });
      assert.equal(r.bad, 0, `${instrument}: no NaN`);
      assert.ok(r.peak > 0.05 && r.peak <= 1, `${instrument}: peak ${r.peak}`);
      if (base === STUDIO_A) rms.push(20 * Math.log10(r.rms));
    }
    const loud = await render(events, { ...STUDIO_A, instrument, polyphony: 24, volume: 1, reverb: 1, length: 3, mode: "raw" });
    assert.ok(loud.bad === 0 && loud.peak <= 1, `${instrument} worst case peak ${loud.peak}`);
  }
  assert.ok(Math.max(...rms) - Math.min(...rms) < 4.5, `instruments stay within a few dB of each other (${rms.map((x) => x.toFixed(1))})`);
  for (const polyphony of [1, 3, 8]) {
    const r = await render(events, music({ polyphony, mode: "raw" }));
    assert.ok(r.performer.maxVoices <= polyphony, `limit ${polyphony}: max ${r.performer.maxVoices}`);
  }
  // Every note is in the selected scale.
  const r = await render(events, { ...STUDIO_B, scale: "dorian", root: 7 });
  const steps = SCALES.dorian.steps;
  assert.ok(r.notes.every((n) => steps.includes((((n.midi - 7) % 12) + 12) % 12)));
});

test("SL6. Variation: Natural never adds notes, Rich adds quiet spaced shadows, Raw and Random Notes are untouched", async () => {
  const { events } = setup({ duration: 12 }); // squeezed: plenty of repeats
  const strict = await render(events, music(), { duration: 12 });
  const natural = await render(events, music({ variation: "natural" }), { duration: 12 });
  const rich = await render(events, music({ variation: "rich" }), { duration: 12 });
  assert.ok(natural.notes.every((n) => n.shadow === null));
  assert.deepEqual(natural.notes.map((n) => [n.eventIndex, n.midi]), strict.notes.map((n) => [n.eventIndex, n.midi]), "same notes, only loudness/length vary");
  assert.ok(natural.notes.some((n, i) => n.vel !== strict.notes[i].vel || n.length !== strict.notes[i].length));
  const shadows = rich.notes.filter((n) => n.shadow);
  assert.ok(shadows.length > 0, "Rich plays shadow notes");
  let last = -Infinity;
  for (const n of shadows) {
    assert.ok(n.shadow.midi < n.midi && n.repeat > 0);
    assert.ok(Math.abs(n.shadow.vel - Math.min(1, n.vel * SHADOW_VEL)) < 1e-12 && Math.abs(n.shadow.length - n.length * SHADOW_LEN) < 1e-12);
    assert.ok(n.simT - last >= SHADOW_GAP - 1e-9);
    last = n.simT;
  }
  for (const base of [music({ mode: "raw" }), { ...STUDIO_B }]) {
    const s = await render(events, { ...base, variation: "strict" }, { duration: 12 });
    const r = await render(events, { ...base, variation: "rich" }, { duration: 12 });
    assert.equal(s.hash, r.hash, `${base.noteMode}/${base.mode}: Rich sounds exactly like Strict`);
  }
});

test("SL7. deterministic: same strikes and settings give the same audio; A and B hear the same strikes", async () => {
  const { events } = setup({ duration: 20 });
  const again = setup({ duration: 20 }).events;
  assert.deepEqual(again, events);
  const a1 = await render(events, music()), a2 = await render(again, music());
  assert.equal(a1.hash, a2.hash);
  const b = await render(events, { ...STUDIO_B });
  assert.notEqual(a1.hash, b.hash);
  assert.deepEqual(b.notes.map((n) => n.time), b.notes.map((n) => events[n.eventIndex].t), "B plays the very same strike times");
});

test("SL8. live player: schedules from the start point at the replay's times and reports the heard position", async () => {
  // A stand-in AudioContext whose clock the test moves by hand.
  class ManualContext extends OfflineAudioContext {
    constructor() { super(2, RATE * 25, RATE); this.clock = 0; this.outputLatency = 0.04; }
    get currentTime() { return this.clock; }
    async resume() {}
  }
  const saved = globalThis.AudioContext;
  globalThis.AudioContext = ManualContext;
  try {
    const { events } = setup({ duration: 20 });
    const played = [];
    const cfg = music({ mode: "raw", polyphony: 24 });
    const player = new SoundPlayer({ getMusic: () => cfg, onNote: (n) => played.push(n) });
    player.setEvents(events, voicing.seed, area);
    const from = 9.5;
    await player.start(from);
    const ctx = player.audioContext;
    assert.equal(player.position(), from, "holds at the start point until the first note is heard");
    for (let k = 0; k < 600; k++) { ctx.clock += 0.025; player.tick(); }
    const expected = events.filter((e) => e.t >= from - 1e-6);
    assert.equal(played.length, expected.length, "every strike from the start point on is played");
    assert.ok(played.every((n) => events[n.eventIndex].t >= from - 1e-6));
    for (const n of played) assert.ok(Math.abs(n.time - (player.base + events[n.eventIndex].t)) < 1e-9, "audio time = start offset + strike's frame time");
    ctx.clock = player.base + 12 + 0.04; // 12 s of video, heard after the output latency
    assert.ok(Math.abs(player.position() - 12) < 1e-9);
    player.chainDelay = 0.0107; // the limiter's look-ahead counts too
    ctx.clock += 0.0107;
    assert.ok(Math.abs(player.position() - 12) < 1e-9);
    player.stop();
    assert.equal(player.running, false);
  } finally {
    globalThis.AudioContext = saved;
  }
});

test("SL9. sound settings: defaults, validation and storage", () => {
  const d = defaultSoundSettings();
  assert.equal(d.enabled, false, "sound is off until you switch it on: existing videos stay silent");
  assert.equal(d.slots.A.noteMode, "geographic");
  assert.equal(d.area, "data");
  const messy = sanitizeSoundSettings({ enabled: "yes", active: "C", area: "moon", slots: { A: { volume: 9, polyphony: -3, scale: "nope", tightness: 1 }, B: null } });
  assert.equal(messy.enabled, false);
  assert.equal(messy.active, "A");
  assert.equal(messy.area, "data");
  assert.equal(messy.slots.A.volume, 1);
  assert.equal(messy.slots.A.polyphony, 1);
  assert.equal(messy.slots.A.scale, STUDIO_A.scale);
  assert.equal(messy.slots.A.tightness, 0, "timing pull is always off in the studio");
  assert.deepEqual(messy.slots.B, { ...STUDIO_B });
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const s = { ...d, enabled: true, active: "B", area: "frame", slots: { A: { ...d.slots.A }, B: { ...d.slots.B, instrument: "marimba", variation: "rich" } } };
  assert.equal(saveSoundSettings(store, s), true);
  assert.deepEqual(loadSoundSettings(store), s);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(loadSoundSettings(blocked), d);
  assert.equal(saveSoundSettings(blocked, s), false);
  assert.equal(saveSoundSettings(null, s), false);
});
