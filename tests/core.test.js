// Focused correctness tests: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseDataset, parseTimestamp, formatLocal } from "../src/core/parse.js";
import { createTimeMap } from "../src/core/timeline.js";
import { createProjection, autoBounds } from "../src/core/projection.js";
import { buildReplay } from "../src/core/replay.js";
import { buildComposition, ROOT } from "../src/export/composition.js";

const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json");

test("1. every valid strike gets the linear timeline position", () => {
  const m = buildReplay(sample, { duration: 20 });
  const { startMs, endMs, leadIn, span } = m.timeMap;
  assert.equal(m.events.length, 200);
  for (const e of m.events) {
    const expected = leadIn + ((e.t - startMs) / (endMs - startMs)) * span;
    assert.ok(Math.abs(e.v - expected) < 1e-9, `${e.id}`);
    assert.ok(e.v >= leadIn && e.v <= 20 - m.timeMap.tail);
  }
  // Relative spacing is preserved: ratio of gaps in video time equals ratio in data time.
  const [a, b, c] = [m.events[10], m.events[50], m.events[150]];
  assert.ok(Math.abs((b.v - a.v) / (c.v - b.v) - (b.t - a.t) / (c.t - b.t)) < 1e-9);
  // Window ends map to the ends of the active span; toData inverts toVideo.
  assert.equal(m.timeMap.toVideo(startMs), leadIn);
  assert.ok(Math.abs(m.timeMap.toVideo(endMs) - (leadIn + span)) < 1e-9);
  assert.ok(Math.abs(m.timeMap.toData(m.events[77].v) - m.events[77].t) < 1);
  // A strike is visible from the first frame at or after its video time.
  const fps = 24;
  for (const e of m.events) {
    const f = m.timeMap.frameOf(e.v, fps);
    assert.ok(m.countAt(f / fps) > m.events.indexOf(e) && (f === 0 || m.countAt((f - 1) / fps) <= m.events.indexOf(e)));
  }
  // Changing duration rescales, still linear.
  const m60 = buildReplay(sample, { duration: 60 });
  assert.ok(Math.abs(m60.timeMap.toVideo(m.events[100].t) - (m60.timeMap.leadIn + ((m.events[100].t - startMs) / (endMs - startMs)) * m60.timeMap.span)) < 1e-9);
});

test("2. chronological ordering, original records preserved, validation", () => {
  const recs = [
    { id: "c", timestamp: "2026-11-01T15:00:00+03:00", lat: 39.9, lon: 32.8 },
    { id: "a", timestamp: "2026-11-01T11:00:00Z", lat: 39.9, lon: 32.8, extra: "keep-me" }, // 14:00+03
    { id: "b", timestamp: "2026-11-01T14:30:00+03:00", lat: 39.9, lon: 32.8 },
    { id: "bad-time", timestamp: "2026-02-30T10:00:00Z", lat: 39.9, lon: 32.8 },
    { id: "bad-lat", timestamp: "2026-11-01T14:00:00Z", lat: 95, lon: 32.8 },
    { id: "bad-lon", timestamp: "2026-11-01T14:00:00Z", lat: 39, lon: "east" },
  ];
  const ds = parseDataset(JSON.stringify(recs), "x.json");
  assert.deepEqual(ds.events.map((e) => e.id), ["a", "b", "c"]);
  assert.equal(ds.events[0].raw.extra, "keep-me");
  assert.equal(ds.events[0].index, 1);
  assert.equal(ds.errors.length, 3);
  assert.equal(ds.displayOffsetMin, 180); // the majority offset
  assert.equal(formatLocal(ds.events[0].t, 180).time, "14:00:00");
  // Sample file is already sorted, CSV and JSON parse to the same events.
  const csv = parseDataset(readFileSync(join(ROOT, "data", "sample-ankara-storm.csv"), "utf8"), "s.csv");
  assert.deepEqual(csv.events.map((e) => [e.id, e.t, e.lat, e.lon, e.type]), sample.events.map((e) => [e.id, e.t, e.lat, e.lon, e.type]));
  for (let i = 1; i < sample.events.length; i++) assert.ok(sample.events[i].t >= sample.events[i - 1].t);
  // Empty and fully invalid inputs are rejected with a message.
  assert.equal(parseDataset("", "e.csv").ok, false);
  assert.equal(parseDataset("[]", "e.json").ok, false);
  assert.equal(parseDataset("timestamp,lat,lon\n", "e.csv").ok, false);
  assert.match(parseDataset("timestamp,lat,lon\nnope,1,2\n", "e.csv").errors.join(" "), /No valid events/);
  assert.equal(parseTimestamp("2026-11-01T25:00:00Z"), null);
  assert.equal(parseTimestamp(1793530800).ms, 1793530800000);
});

test("3. coordinate-to-screen mapping is geographically consistent", () => {
  const bounds = { west: 32.2, south: 39.5, east: 33.5, north: 40.3 };
  const rect = { x: 40, y: 98, w: 880, h: 338 };
  const p = createProjection(bounds, rect);
  // North is up, east is right.
  assert.ok(p.project(32.8, 40.0)[1] < p.project(32.8, 39.9)[1]);
  assert.ok(p.project(32.9, 39.9)[0] > p.project(32.8, 39.9)[0]);
  // Bounds fit inside the rect, touching it on the limiting axis.
  const [x0, y0] = p.project(bounds.west, bounds.north), [x1, y1] = p.project(bounds.east, bounds.south);
  assert.ok(x0 >= rect.x - 1e-6 && x1 <= rect.x + rect.w + 1e-6 && y0 >= rect.y - 1e-6 && y1 <= rect.y + rect.h + 1e-6);
  assert.ok(Math.abs(y1 - y0 - rect.h) < 1e-6 || Math.abs(x1 - x0 - rect.w) < 1e-6);
  // Isotropic: 5 km east and 5 km north cover the same pixel distance (no aspect distortion).
  const lat = 39.92, lon = 32.85, km = 5;
  const dLat = km / 111.2, dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const [ax, ay] = p.project(lon, lat), [bx] = p.project(lon + dLon, lat), [, cy] = p.project(lon, lat + dLat);
  assert.ok(Math.abs((bx - ax) / (ay - cy) - 1) < 0.01);
  // Scale bar arithmetic matches: pixels × metres/pixel ≈ 5 km.
  assert.ok(Math.abs((bx - ax) * p.metersPerPixel(lat) - 5000) < 50);
  // Round trip.
  const [ulon, ulat] = p.unproject(ax, ay);
  assert.ok(Math.abs(ulon - lon) < 1e-9 && Math.abs(ulat - lat) < 1e-9);
  // Model positions come from input coordinates, and every event is inside the frame.
  const m = buildReplay(sample, {});
  for (const e of m.events) {
    const [x, y] = m.proj.project(e.lon, e.lat);
    assert.equal(e.x, x); assert.equal(e.y, y);
    assert.ok(x >= m.proj.rect.x && x <= m.proj.rect.x + m.proj.rect.w && y >= m.proj.rect.y && y <= m.proj.rect.y + m.proj.rect.h);
  }
  // Custom bounds are honoured.
  const mc = buildReplay(sample, { bounds });
  assert.deepEqual(mc.bounds, bounds);
  assert.ok(autoBounds([{ lat: 39.9, lon: 32.8 }]).north > 39.9); // single point still gets a map
});

test("4. events at the same timestamp share one video time and appear together", () => {
  const ties = [];
  for (let i = 1; i < sample.events.length; i++) if (sample.events[i].t === sample.events[i - 1].t) ties.push(i);
  assert.ok(ties.length >= 1, "sample contains a simultaneous pair");
  const m = buildReplay(sample, { duration: 20 });
  const i = ties[0];
  assert.equal(m.events[i].v, m.events[i - 1].v);
  const fps = 24, f = m.timeMap.frameOf(m.events[i].v, fps);
  assert.equal(m.countAt(f / fps) - m.countAt((f - 1) / fps) >= 2, true);
  // All strikes at one instant (zero-length range) still map inside the video.
  const one = parseDataset(JSON.stringify([
    { timestamp: "2026-11-01T12:00:00Z", lat: 1, lon: 1 },
    { timestamp: "2026-11-01T12:00:00Z", lat: 1.1, lon: 1.1 },
  ]), "t.json");
  const mo = buildReplay(one, { duration: 10 });
  assert.equal(mo.events[0].v, mo.events[1].v);
  assert.ok(mo.events[0].v > 0 && mo.events[0].v < 10);
  assert.equal(mo.countAt(10), 2);
});

test("5. preview and exported composition use the same event-time mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-test-"));
  try {
    const settings = { duration: 17, trailMinutes: 12, markerScale: 1.3, quality: "draft" };
    const { model } = buildComposition({ text: SAMPLE, filename: "sample-ankara-storm.json", settings, outDir: dir });
    // The composition runs byte-identical copies of the core modules the preview imports.
    const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
    for (const f of readdirSync(join(ROOT, "src", "core"))) {
      assert.equal(hash(join(dir, "lib", "core", f)), hash(join(ROOT, "src", "core", f)), f);
    }
    // It embeds the raw dataset and the normalised settings; rebuilding from them reproduces the preview's times.
    const ctx = { window: {} };
    vm.runInNewContext(readFileSync(join(dir, "replay-input.js"), "utf8"), ctx);
    const input = ctx.window.__REPLAY_INPUT;
    const fromExport = buildReplay(parseDataset(input.text, input.filename), input.settings);
    const fromPreview = buildReplay(parseDataset(SAMPLE, "sample-ankara-storm.json"), settings);
    assert.deepEqual(fromExport.events.map((e) => [e.id, e.v, e.x, e.y]), fromPreview.events.map((e) => [e.id, e.v, e.x, e.y]));
    assert.deepEqual(model.events.map((e) => e.v), fromPreview.events.map((e) => e.v));
    // The video length declared to HyperFrames is the requested duration.
    const html = readFileSync(join(dir, "index.html"), "utf8");
    assert.match(html, /data-duration="17"/);
    assert.match(html, /data-fps="24"/);
    assert.match(html, /data-width="960"[\s\S]*data-height="540"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
