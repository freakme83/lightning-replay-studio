// Video overlays: defaults, independent switches, Hide all / Reset, validation, and a recording
// 2D context that shows exactly what the shared renderer draws (nothing is drawn that is switched off).
//   node --test tests/overlays.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay, fitFrame, normalizeSettings, DEFAULTS } from "../src/core/replay.js";
import { drawFrame } from "../src/core/draw.js";
import { buildComposition, basemapMismatch, ROOT } from "../src/export/composition.js";
import { OVERLAYS, defaultOverlays, noOverlays, normalizeOverlays, parseOverlaySpec, zoneVisible, attributionLines } from "../src/core/overlays.js";

const W = 960, H = 540;
const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json"); // synthetic, CG + IC
const frame = fitFrame(sample.events, W, H);
const MAP = { image: {}, attribution: "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors" };
const model = (overlays, extra = {}, ds = sample) => buildReplay(ds, { frame, overlays, ...extra }, { mapImage: MAP });

/** Everything drawFrame asks of the 2D context, in order. */
function record(m, t) {
  const log = { text: [], bands: 0, strokeRects: 0, arcs: [], images: 0, state: {} };
  const ctx = new Proxy({}, {
    get: (_, k) => {
      if (k === "measureText") return (s) => ({ width: String(s).length * 5 });
      if (k === "createLinearGradient") return () => { log.bands++; return { addColorStop() {} }; }; // the HUD backing bands
      if (k === "createRadialGradient") return () => ({ addColorStop() {} }); // strike glows
      if (k === "fillText") return (s) => log.text.push(String(s));
      if (k === "strokeRect") return () => log.strokeRects++;
      if (k === "arc") return (...a) => log.arcs.push(a.map((v) => +(+v).toFixed(6)));
      if (k === "drawImage") return () => log.images++;
      if (k in log.state) return log.state[k];
      return () => {};
    },
    set: (_, k, v) => { log.state[k] = v; return true; },
  });
  drawFrame(ctx, m, t);
  return log;
}
const T = 12; // a moment with strikes on screen
const has = (log, re) => log.text.some((s) => re.test(s));
const MARKS = {
  title: /^LIGHTNING REPLAY$|strikes · .* storm → /,
  clock: /^LOCAL TIME · |^\d\d:\d\d:\d\d$/,
  counter: /^STRIKES$|^LAST 10 MIN$/,
  activity: /^strikes \/ /,
  scaleBar: /^\d+ ?(km|m)$/,
  legend: /^cloud-to-ground$|^intracloud$|^trail \d+ min$/,
  syntheticNotice: /^SYNTHETIC DATA/,
  attribution: /OpenFreeMap/,
};

test("19. overlay defaults, Hide all, Reset, validation and CLI spec", () => {
  assert.deepEqual(OVERLAYS.map((o) => o.id), ["title", "clock", "counter", "activity", "scaleBar", "legend", "syntheticNotice", "attribution"]);
  for (const o of OVERLAYS) assert.ok(o.label && o.hint && ["top", "bottom"].includes(o.zone), o.id);
  const d = defaultOverlays();
  assert.ok(Object.values(d).every((v) => v === true), "defaults keep the current presentation");
  assert.ok(Object.values(noOverlays()).every((v) => v === false));
  assert.deepEqual(normalizeSettings({}).overlays, d);
  assert.deepEqual(DEFAULTS.overlays, d);
  // Independent: switching one off leaves the rest alone.
  for (const o of OVERLAYS) {
    const n = normalizeOverlays({ [o.id]: false });
    assert.equal(n[o.id], false);
    assert.equal(Object.values(n).filter((v) => !v).length, 1, o.id);
  }
  // Invalid values fall back to each overlay's default, unknown keys are dropped, never throws.
  assert.deepEqual(normalizeOverlays({ title: "no", clock: 0, counter: null, activity: "false", legend: "true", bogus: false }), { ...d, activity: false });
  for (const junk of [null, undefined, 3, "x", []]) assert.deepEqual(normalizeOverlays(junk), d);
  assert.deepEqual(normalizeSettings({ overlays: { title: false } }).overlays, { ...d, title: false });
  // Hide all → Reset round trip.
  assert.deepEqual(normalizeOverlays(normalizeOverlays(noOverlays())), noOverlays());
  assert.deepEqual(normalizeOverlays(defaultOverlays()), d);
  // Zones: a backing band exists only while an overlay in it is visible.
  assert.ok(zoneVisible(d, "top") && zoneVisible(d, "bottom"));
  assert.ok(!zoneVisible(noOverlays(), "top") && !zoneVisible(noOverlays(), "bottom"));
  assert.ok(zoneVisible({ ...noOverlays(), attribution: true }, "top") && !zoneVisible({ ...noOverlays(), attribution: true }, "bottom"));
  // CLI spec.
  assert.deepEqual(parseOverlaySpec(undefined), d);
  assert.deepEqual(parseOverlaySpec("all"), d);
  assert.deepEqual(parseOverlaySpec("none"), noOverlays());
  assert.deepEqual(parseOverlaySpec("Title, clock"), { ...noOverlays(), title: true, clock: true });
  assert.throws(() => parseOverlaySpec("title,banner"), /Unknown overlay "banner"/);
});

test("20. the renderer draws exactly the overlays that are on", () => {
  const all = record(model(defaultOverlays()), T);
  for (const [id, re] of Object.entries(MARKS)) assert.ok(has(all, re), `${id} is drawn by default`);
  assert.equal(all.bands, 2, "both HUD bands by default");
  assert.equal(all.strokeRects, 1, "synthetic badge frame");
  // Each switch removes only its own elements.
  for (const o of OVERLAYS) {
    const log = record(model({ ...defaultOverlays(), [o.id]: false }), T);
    for (const [id, re] of Object.entries(MARKS)) assert.equal(has(log, re), id !== o.id, `${o.id} off → ${id} ${id === o.id ? "gone" : "kept"}`);
  }
  // Hide all: no text at all, no bands, no badge frame; the map image and the strikes remain.
  const none = record(model(noOverlays()), T);
  assert.deepEqual(none.text, [], "no text in a clean frame");
  assert.equal(none.bands, 0);
  assert.equal(none.strokeRects, 0);
  assert.equal(none.images, 1, "the basemap is still drawn");
  assert.ok(none.arcs.length > 0, "strikes are still drawn");
  // Bands follow the zones: top-only and bottom-only overlays.
  assert.equal(record(model({ ...noOverlays(), clock: true }), T).bands, 1);
  assert.equal(record(model({ ...noOverlays(), counter: true }), T).bands, 1);
  assert.equal(record(model({ ...noOverlays(), attribution: true }), T).bands, 1);
  // Attribution ON vs OFF: only the credit line differs.
  const on = record(model({ ...defaultOverlays(), attribution: true }), T), off = record(model({ ...defaultOverlays(), attribution: false }), T);
  assert.deepEqual(on.text.filter((s) => !/OpenFreeMap/.test(s)), off.text);
  assert.deepEqual(on.text.filter((s) => /OpenFreeMap/.test(s)), [MAP.attribution]);
  // The outline fallback's own credit line is the attribution overlay too.
  const outline = (ov) => record(buildReplay(sample, { frame, overlays: ov }, { basemap: { land: [], borders: [] }, places: [] }), T);
  assert.ok(has(outline(defaultOverlays()), /Web Mercator/));
  assert.ok(!has(outline({ ...defaultOverlays(), attribution: false }), /Web Mercator/));
  // Restoring the defaults gives the identical frame as never having changed anything.
  assert.deepEqual(record(model(normalizeOverlays(defaultOverlays())), T), record(model(undefined), T));
  assert.deepEqual(record(model(normalizeOverlays({ ...noOverlays(), ...defaultOverlays() })), T), all);
  // A non-synthetic dataset never shows the badge, whatever the switch says.
  const real = parseDataset(JSON.stringify({ meta: { name: "Real" }, events: sample.events.slice(0, 20).map((e) => e.raw) }), "r.json");
  assert.ok(!has(record(model(defaultOverlays(), {}, real), T), MARKS.syntheticNotice));
});

test("21. overlays never change strike coordinates, counts, timing or animation", () => {
  const base = model(defaultOverlays()), clean = model(noOverlays());
  assert.deepEqual(clean.events.map((e) => [e.id, e.x, e.y, e.v, e.w]), base.events.map((e) => [e.id, e.x, e.y, e.v, e.w]));
  assert.deepEqual(clean.camera, base.camera);
  for (const key of ["startMs", "endMs", "leadIn", "span", "tail", "rate"]) assert.equal(clean.timeMap[key], base.timeMap[key], key);
  assert.deepEqual(clean.bins, base.bins);
  for (const t of [0, 3, 7.5, 12, 19.9]) assert.equal(clean.countAt(t), base.countAt(t));
  // The animation primitives (every strike flash / ring / marker) are identical with and without overlays;
  // only the legend's own sample dots differ, so compare against a frame with just the legend off.
  for (const t of [4, 9, 15]) {
    const a = record(model({ ...defaultOverlays(), legend: false }), t), b = record(clean, t);
    assert.deepEqual(b.arcs, a.arcs, `strike drawing at t=${t}`);
  }
  // Toggling the overlays of an existing model (what the studio does) leaves the timeline model alone.
  const m = model(defaultOverlays());
  const before = JSON.stringify(m.events);
  m.settings.overlays = noOverlays();
  assert.equal(JSON.stringify(m.events), before);
  assert.deepEqual(record(m, T).text, []);
  m.settings.overlays = defaultOverlays();
  assert.deepEqual(record(m, T), record(model(defaultOverlays()), T), "turning them back on restores the frame exactly");
});

test("22. preview and export receive identical overlay settings; the map image is untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-ovl-"));
  try {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4300000000049454e44ae426082", "hex");
    const m0 = buildReplay(sample, { frame });
    const meta = { width: W, height: H, camera: m0.camera, attribution: MAP.attribution, layersKey: "k" };
    for (const overlays of [defaultOverlays(), noOverlays(), { ...defaultOverlays(), clock: false, attribution: false }]) {
      const out = join(dir, "c" + JSON.stringify(overlays).length);
      const { model: built } = buildComposition({ text: SAMPLE, filename: "s.json", settings: { frame, overlays }, outDir: out, mapImage: { png, meta } });
      const input = JSON.parse(readFileSync(join(out, "replay-input.js"), "utf8").replace(/^window\.__REPLAY_INPUT = /, "").replace(/;\s*$/, ""));
      assert.deepEqual(input.settings.overlays, normalizeOverlays(overlays), "the composition embeds the overlay settings the preview uses");
      assert.deepEqual(built.settings.overlays, buildReplay(sample, { frame, overlays }).settings.overlays);
      assert.deepEqual(readFileSync(join(out, "assets", "basemap.png")), png, "same prepared map image whatever the overlays");
      assert.equal(basemapMismatch(meta, built), null, "the prepared map still fits: overlays are not part of its identity");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("23. attribution lines come only from the sources actually used", () => {
  const map = "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors";
  assert.deepEqual(attributionLines({ mapAttribution: map, meta: { provider: "blitzortung" } }), [`Map: ${map}`, "Lightning data: blitzortung (as recorded in the dataset)"]);
  assert.deepEqual(attributionLines({ mapAttribution: map, meta: { synthetic: true } }), [`Map: ${map}`, "Lightning data: synthetic, fictional events (not real detections)"]);
  assert.deepEqual(attributionLines({ mapAttribution: map, meta: {} }), [`Map: ${map}`], "no recorded provider → no data line invented");
  assert.match(attributionLines({ outline: true, meta: {} })[0], /Natural Earth/);
  assert.deepEqual(attributionLines({}), []);
});
