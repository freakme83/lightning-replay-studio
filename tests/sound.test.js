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
import { flashStrength, inPicture, soundEvents, strikeVoicing } from "../src/sound/events.js";
import { endFade, fadeGain, measureChainDelay, renderSound } from "../src/sound/render.js";
import { SoundPlayer } from "../src/sound/player.js";
import { CHORD_LEN, CHORD_MAX, CHORD_VEL, SHADOW_GAP, SHADOW_LEN, SHADOW_VEL } from "../src/sound/performer.js";
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
  return { model, voicing: v, events: soundEvents(model, v, settings.frame ?? null) };
}
const music = (over = {}) => ({ ...STUDIO_A, ...over });
/** A frame zoomed by k around the centre of another (k > 1 = closer in). */
const zoom = (f, k, dx = 0) => {
  const cx = (f.west + f.east) / 2 + dx, cy = (f.south + f.north) / 2, hw = (f.east - f.west) / 2 / k, hh = (f.north - f.south) / 2 / k;
  return { west: cx - hw, east: cx + hw, south: cy - hh, north: cy + hh };
};
/** Is a model strike drawn inside the picture? (its projected position, the renderer's own rule) */
const drawnInPicture = (m, e) => e.x >= 0 && e.x <= m.settings.width && e.y >= 0 && e.y <= m.settings.height;
/** Video frames on which at least one new strike appears inside the picture. */
const flashFrames = (m) => new Set(m.events.filter((e) => drawnInPicture(m, e)).map((e) => m.timeMap.frameOf(e.v, m.settings.fps)));

/** A dense, clustered storm like real detections: many strikes per flash and many on the same millisecond. */
function clusteredDataset() {
  let a = 7;
  const rnd = () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
  const t0 = Date.UTC(2026, 10, 4, 15, 0, 0), events = [];
  for (let k = 0; k < 160; k++) {
    const ms = t0 + Math.floor(rnd() * 2 * 3600 * 1000), lat = 40 + (rnd() - 0.5) * 0.8, lon = 10 + (rnd() - 0.5) * 1.1;
    const n = 1 + Math.floor(rnd() * 9);
    for (let j = 0; j < n; j++) {
      const same = rnd() < 0.4;
      events.push({ timestamp: new Date(ms + (same ? 0 : Math.floor(rnd() * 900))).toISOString(), lat: lat + (rnd() - 0.5) * 0.3, lon: lon + (rnd() - 0.5) * 0.3 });
    }
  }
  return parseDataset(JSON.stringify({ meta: { centerLat: 40, centerLon: 10, sideKm: 100 }, events }), "clustered.json");
}
const clustered = clusteredDataset();

async function render(events, cfg, { bounds = area, duration = 20, seed = voicing.seed, fade = null } = {}) {
  const r = await renderSound({ OfflineAudioContext, events, music: cfg, seed, bounds, duration, fade, sampleRate: RATE });
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

test("SL1. every flash sounds on the first video frame that shows it", async () => {
  const { model, events } = setup({ duration: 20 });
  const fps = model.settings.fps;
  const strikesSeen = new Set();
  for (const [i, ev] of events.entries()) {
    assert.ok(Number.isInteger(ev.frame) && Math.abs(ev.t * fps - ev.frame) < 1e-9, "note time is on the frame grid");
    assert.ok(i === 0 || ev.frame > events[i - 1].frame, "one event per frame, in time order");
    for (const k of ev.strikes) {
      const e = model.events.find((x) => x.index === k);
      assert.equal(model.timeMap.frameOf(e.v, fps), ev.frame, "every strike of the flash appears on that frame");
      strikesSeen.add(k);
    }
    // Drawn on that frame and not on the one before.
    const before = model.countAt((ev.frame - 1) / fps), on = model.countAt(ev.t);
    assert.equal(on - before, ev.strikes.length);
  }
  assert.equal(strikesSeen.size, model.events.length, "Fit to Data: every strike belongs to exactly one flash");
  // Every note of every mode is played at exactly its flash's time (no timing pull in the studio).
  for (const cfg of [music(), music({ mode: "raw" }), { ...STUDIO_B }, { ...STUDIO_B, mode: "raw" }, music({ variation: "rich" })]) {
    const { notes } = await render(events, cfg);
    assert.equal(notes.length, events.length, `${cfg.noteMode}/${cfg.mode}: every flash is heard`);
    for (const n of notes) assert.equal(n.time, events[n.eventIndex].t, `${cfg.noteMode}/${cfg.mode}`);
    assert.ok(events.every((ev) => timingDelay(ev, cfg) === 0));
  }
  // The audio itself: silence before the first flash's frame, sound right after it. The output chain (the safety
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

test("SL2. flash timing follows the replay's time map; each strike keeps its own voicing", () => {
  const a = setup({ duration: 20 }), b = setup({ duration: 45 });
  for (const { model, events } of [a, b]) {
    for (const ev of events) {
      const lead = model.events.find((e) => e.index === ev.strike);
      assert.ok(Math.abs(ev.t - model.timeMap.frameOf(lead.v, 24) / 24) < 1e-12);
      // The lead strike's own voicing, louder only by the crowd on its frame.
      const own = voicing.byIndex.get(ev.strike);
      for (const k of ["pitchRand", "velRand", "pan"]) assert.equal(ev[k], own[k], k);
      assert.equal(ev.strength, flashStrength(ev.strikes.map((i) => voicing.byIndex.get(i).strength)));
      assert.ok(ev.strikes.every((i) => voicing.byIndex.get(i).strength <= own.strength), "the strongest strike leads");
      assert.deepEqual(ev.members.map((m) => m.strike), ev.strikes.slice(1));
    }
  }
  assert.equal(flashStrength([0.4]), 0.4);
  assert.ok(flashStrength([0.4, 0.3]) > 0.4 && flashStrength(Array(64).fill(0.9)) === 1);
  // A longer video separates frames: never fewer flashes, same strikes.
  assert.ok(b.events.length >= a.events.length);
  assert.equal(b.events.reduce((n, e) => n + e.strikes.length, 0), a.events.reduce((n, e) => n + e.strikes.length, 0));
  // A narrower time range: strikes outside it are not in the replay, so they do not sound either.
  const startMs = sample.events[50].t, endMs = sample.events[120].t;
  const r = setup({ duration: 20, timeRange: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() } });
  const inRange = new Set(r.model.events.map((e) => e.index));
  assert.ok(r.model.excluded > 0 && r.events.every((ev) => ev.strikes.every((i) => inRange.has(i))));
  assert.equal(r.events.reduce((n, e) => n + e.strikes.length, 0), r.model.events.length);
  // Same dataset, same seed, anywhere.
  assert.equal(strikeVoicing(sample).seed, voicing.seed);
  assert.ok(Object.isFrozen(a.events) && Object.isFrozen(a.events[0]) && Object.isFrozen(a.events[0].members));
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
        // Chord notes: other strikes of the same flash, at their own latitude's note and longitude's pan.
        for (const c of n.chord) {
          const m = ev.members.find((x) => x.strike === c.strike);
          assert.ok(m, "a chord note belongs to a strike on the same frame");
          assert.equal(c.midi, pool[geoNoteIndex(m.lat, bounds, pool.length)].midi);
          assert.equal(c.pan, geoPan(m.lon, bounds));
        }
      }
    }
  }
  // A different area gives different notes for the same strikes (the choice matters).
  const pool = buildPool(music());
  const idx = (b) => events.map((e) => geoNoteIndex(e.lat, b, pool.length)).join();
  assert.notEqual(idx(area), idx(listeningArea("frame", sample, frame).bounds));
  assert.ok(model.events.length >= events.length);
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
  // Shadow notes only use spare voices; every flash is heard, so they need room: a longer video and more voices.
  const roomy = setup({ duration: 60 }).events;
  const rich = await render(roomy, music({ variation: "rich", polyphony: 24 }), { duration: 60 });
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
    const { model, events } = setup({ duration: 20 });
    const played = [];
    const cfg = music({ mode: "raw", polyphony: 24 });
    const player = new SoundPlayer({ getMusic: () => cfg, onNote: (n) => played.push(n) });
    const fade = endFade(model.timeMap);
    player.setEvents(events, voicing.seed, area, fade);
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
    player.stop({ ringOut: true });
    assert.equal(player.running, false);
    // The live sound fades out exactly like an export: full level before the fade, silence after the video's end.
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    const peakIn = (a, b) => { let p = 0; for (let i = Math.max(0, Math.round(a * RATE)); i < Math.min(d.length, Math.round(b * RATE)); i++) p = Math.max(p, Math.abs(d[i])); return p; };
    assert.ok(peakIn(player.base + from, player.base + fade.start) > 0.05, "sound before the fade");
    assert.ok(peakIn(player.base + fade.end + 0.02, player.base + fade.end + 3) < 1e-4, "silence after the end of the video");
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

test("SL10. only strikes inside the video frame are heard", async () => {
  const fit = buildReplay(sample, { duration: 20 }).extent;
  const frames = [fit, zoom(fit, 2), zoom(fit, 4), zoom(fit, 4, 0.3), zoom(fit, 8, -0.2)];
  for (const frame of frames) {
    for (const format of ["landscape", "portrait"]) {
      const m = buildReplay(sample, { duration: 20, frame, format });
      // The geographic rule the sound uses is the renderer's own pixel rule.
      for (const e of m.events) assert.equal(inPicture(e, m.extent), drawnInPicture(m, e), `${e.id} ${format}`);
      const events = soundEvents(m, voicing, m.extent);
      const heard = events.flatMap((ev) => ev.strikes);
      const visible = m.events.filter((e) => drawnInPicture(m, e)).map((e) => e.index);
      assert.deepEqual([...heard].sort((a, b) => a - b), [...visible].sort((a, b) => a - b), "exactly the strikes in the picture");
      const { notes } = await render(events, music({ mode: "raw" }), { bounds: listeningArea("frame", sample, m.extent).bounds });
      for (const n of notes) for (const k of [events[n.eventIndex].strike, ...n.chord.map((c) => c.strike)])
        assert.ok(drawnInPicture(m, m.events.find((e) => e.index === k)), "no note for a strike outside the picture");
    }
  }
  // Zooming in hears fewer strikes; the sound tab follows a moving frame.
  const close = buildReplay(sample, { duration: 20, frame: zoom(fit, 4) });
  assert.ok(soundEvents(close, voicing, close.extent).flatMap((e) => e.strikes).length < sample.events.length);
});

test("SL11. every frame that shows a new flash is heard, also in a dense clustered storm", async () => {
  const v = strikeVoicing(clustered);
  const carea = dataArea(clustered).bounds;
  const cfit = buildReplay(clustered, { duration: 20 }).extent;
  const cases = [
    [sample, voicing, area, buildReplay(sample, { duration: 20 }).extent, 20],
    [sample, voicing, area, zoom(buildReplay(sample, { duration: 20 }).extent, 4), 20],
    [clustered, v, carea, cfit, 20],
    [clustered, v, carea, cfit, 60],
    [clustered, v, carea, zoom(cfit, 3), 60],
  ];
  const configs = [music(), music({ mode: "raw" }), { ...STUDIO_B }, { ...STUDIO_B, mode: "raw" }, music({ variation: "rich" }), music({ polyphony: 1 }), music({ polyphony: 3, mode: "raw" })];
  let chordsSeen = 0;
  for (const [ds, vo, bounds, frame, duration] of cases) {
    const m = buildReplay(ds, { duration, frame });
    const events = soundEvents(m, vo, m.extent);
    const expected = flashFrames(m);
    assert.deepEqual(events.map((e) => e.frame), [...expected].sort((a, b) => a - b));
    for (const cfg of configs) {
      const r = await render(events, cfg, { bounds, duration, seed: vo.seed, fade: endFade(m.timeMap) });
      const heard = new Set(r.notes.map((n) => events[n.eventIndex].frame));
      assert.equal(heard.size, expected.size, `${ds === sample ? "sample" : "clustered"} ${duration}s ${cfg.noteMode}/${cfg.mode}/p${cfg.polyphony}: every flash frame heard`);
      assert.equal(r.performer.thinned, 0, "nothing held back by the density guard at 24 fps");
      assert.ok(r.performer.maxVoices <= cfg.polyphony, `voice limit ${cfg.polyphony}: max ${r.performer.maxVoices}`);
      assert.ok(r.bad === 0 && r.peak <= 1);
      const pool = buildPool(cfg);
      for (const n of r.notes) {
        assert.ok(n.chord.length <= CHORD_MAX);
        if (cfg.noteMode !== "geographic") assert.equal(n.chord.length, 0, "Random Notes: one note per flash");
        const bands = [n.midi, ...n.chord.map((c) => c.midi)];
        assert.equal(new Set(bands).size, bands.length, "a chord uses different note bands");
        for (const c of n.chord) {
          assert.ok(pool.some((p) => p.midi === c.midi));
          assert.ok(Math.abs(c.vel - Math.min(1, n.vel * CHORD_VEL)) < 1e-12 && Math.abs(c.length - n.length * CHORD_LEN) < 1e-12, "chord notes are quieter and shorter");
        }
        chordsSeen += n.chord.length;
      }
    }
  }
  assert.ok(chordsSeen > 0, "same-frame strikes in other note bands do form chords");
});

test("SL12. the sound fades out over the closing hold and ends with the video", async () => {
  for (const duration of [4, 20, 60]) {
    const tm = buildReplay(sample, { duration }).timeMap;
    const f = endFade(tm);
    assert.ok(Math.abs(f.start - (duration - tm.tail)) < 1e-12 && f.end === duration, "from the last possible strike to the end");
    assert.equal(fadeGain(f.start - 1, f), 1);
    assert.equal(fadeGain(f.end, f), 0);
    assert.equal(fadeGain(f.end + 1, f), 0);
    let prev = 1;
    for (let k = 0; k <= 50; k++) { const g = fadeGain(f.start + ((f.end - f.start) * k) / 50, f); assert.ok(g <= prev + 1e-12 && g >= 0); prev = g; }
    assert.ok(Math.abs(fadeGain((f.start + f.end) / 2, f) - Math.SQRT1_2) < 1e-9, "equal-power curve");
  }
  const { model, events } = setup({ duration: 20 });
  const fade = endFade(model.timeMap);
  for (const cfg of [music({ length: 3, reverb: 1 }), { ...STUDIO_B, instrument: "warm", length: 3 }]) {
    const plain = await render(events, cfg);
    const faded = await render(events, cfg, { fade });
    const a = plain.buffer.getChannelData(0), b = faded.buffer.getChannelData(0);
    const s0 = Math.floor(fade.start * RATE);
    let diff = 0;
    for (let i = 0; i < s0; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    assert.ok(diff < 1e-4, `nothing audible changes before the fade (max difference ${diff.toExponential(1)}, below -80 dBFS)`);
    const peak = (d, from, to) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(d[i])); return p; };
    const lastMs = (ms) => [b.length - Math.round((ms / 1000) * RATE), b.length];
    assert.ok(peak(a, ...lastMs(50)) > 0.01, "without the fade the notes would still be ringing at the end");
    assert.ok(peak(b, ...lastMs(10)) < 2e-3, `with it the last 10 ms are practically silent (${peak(b, ...lastMs(10))})`);
    assert.ok(Math.abs(b[b.length - 1]) < 2e-4, "the very last sample is silent");
    assert.equal(faded.buffer.length, 20 * RATE, "the video keeps its length");
  }
});
