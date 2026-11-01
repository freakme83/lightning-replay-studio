// Map Composer foundation: camera ↔ projection bridge, locked frames, basemap plumbing.
// Tests 10–11 drive real MapLibre in headless Chrome with an offline style (no network).
//   node --test tests/map.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseDataset } from "../src/core/parse.js";
import { cameraOf, frameFromCamera, frameProjection, mercX, mercY, TILE_SIZE } from "../src/core/projection.js";
import { buildReplay, fitFrame, mapRect } from "../src/core/replay.js";
import { buildComposition, basemapMismatch, ROOT } from "../src/export/composition.js";
import { renderBasemap, MapPrepError } from "../src/map/render-basemap.js";
import { tuneDark, offlineStyle } from "../src/map/providers.js";
import { decodeRgb, centroid, markerStyle, isMagenta } from "./helpers.js";

const W = 960, H = 540;
const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json");
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);

test("7. map camera and replay projection are the same transform", () => {
  const frame = fitFrame(sample.events, W, H);
  const proj = frameProjection(frame, W, H);
  const cam = cameraOf(proj, W, H);
  // A bearing-0 web map at this camera puts a point at W/2 + Δmerc · 512 · 2^zoom.
  const world = TILE_SIZE * Math.pow(2, cam.zoom);
  for (const e of sample.events) {
    const [x, y] = proj.project(e.lon, e.lat);
    close(x, W / 2 + (mercX(e.lon) - mercX(cam.lon)) * world, 1e-6, e.id);
    close(y, H / 2 + (mercY(e.lat) - mercY(cam.lat)) * world, 1e-6, e.id);
  }
  // Camera → frame → camera round-trips, and the frame fills the canvas edge to edge.
  const back = frameFromCamera(cam, W, H);
  for (const k of ["west", "south", "east", "north"]) close(back[k], frame[k], 1e-9, k);
  const [x0, y0] = proj.project(frame.west, frame.north), [x1, y1] = proj.project(frame.east, frame.south);
  close(x0, 0, 1e-6); close(y0, 0, 1e-6); close(x1, W, 1e-6); close(y1, H, 1e-6);
  // A frame of the wrong shape is widened to 16:9, never stretched.
  const narrow = { west: 32.5, east: 33.0, south: 39.5, north: 40.3 };
  const p2 = frameProjection(narrow, W, H);
  const ext = p2.extentOf({ x: 0, y: 0, w: W, h: H });
  close(ext.north, narrow.north, 1e-9); close(ext.south, narrow.south, 1e-9);
  assert.ok(ext.west < narrow.west && ext.east > narrow.east);
  close((mercX(ext.east) - mercX(ext.west)) / (mercY(ext.south) - mercY(ext.north)), W / H, 1e-9);
});

test("8. Fit to Data, pan, zoom and lock define the frame; timing is unchanged", () => {
  // Fit to Data keeps every strike inside the HUD-free map area of the full frame.
  const frame = fitFrame(sample.events, W, H);
  const locked = buildReplay(sample, { quality: "draft", frame });
  const r = mapRect(W, H);
  for (const e of locked.events) assert.ok(e.x >= r.x - 1e-6 && e.x <= r.x + r.w + 1e-6 && e.y >= r.y - 1e-6 && e.y <= r.y + r.h + 1e-6, e.id);
  for (const k of ["west", "south", "east", "north"]) close(locked.extent[k], frame[k], 1e-9, k);
  assert.equal(locked.autoFitted, false);
  // Locking the Fit-to-Data frame reproduces the v1 auto-fit layout exactly.
  const auto = buildReplay(sample, { quality: "draft" });
  locked.events.forEach((e, i) => { close(e.x, auto.events[i].x, 1e-6); close(e.y, auto.events[i].y, 1e-6); });
  // Time compression and ordering do not depend on the frame.
  assert.deepEqual(locked.events.map((e) => [e.id, e.v]), auto.events.map((e) => [e.id, e.v]));
  for (const k of ["startMs", "endMs", "leadIn", "span", "tail", "rate"]) assert.equal(locked.timeMap[k], auto.timeMap[k], k);

  // Pan: moving the camera by Δ pixels moves every strike by −Δ pixels.
  const cam = locked.camera;
  const world = TILE_SIZE * Math.pow(2, cam.zoom);
  const panned = { ...cam, lon: cam.lon + (120 / world) * 360 };
  const mp = buildReplay(sample, { quality: "draft", frame: frameFromCamera(panned, W, H) });
  mp.events.forEach((e, i) => { close(e.x, locked.events[i].x - 120, 1e-6); close(e.y, locked.events[i].y, 1e-6); });
  // Zoom +1 doubles every distance from the frame centre.
  const mz = buildReplay(sample, { quality: "draft", frame: frameFromCamera({ ...cam, zoom: cam.zoom + 1 }, W, H) });
  mz.events.forEach((e, i) => { close(e.x - W / 2, 2 * (locked.events[i].x - W / 2), 1e-6); close(e.y - H / 2, 2 * (locked.events[i].y - H / 2), 1e-6); });
  assert.deepEqual(mz.events.map((e) => e.v), locked.events.map((e) => e.v));

  // Lock is just the settings value: normalised, and rebuilt identically.
  const again = buildReplay(sample, { quality: "draft", frame: { ...frame } });
  assert.deepEqual(again.camera, locked.camera);
  assert.throws(() => buildReplay(sample, { quality: "draft", frame: { west: 33, east: 32, south: 39, north: 40 } }), /Map frame: West must be less than east/);

  // A different dataset (İstanbul CSV) frames on its own strikes, far from Ankara.
  const ist = parseDataset(readFileSync(join(ROOT, "data", "sample-istanbul-squall.csv"), "utf8"), "sample-istanbul-squall.csv");
  const fi = fitFrame(ist.events, W, H);
  assert.ok(fi.west > 27 && fi.east < 31 && fi.north > 40.5);
  const mi = buildReplay(ist, { quality: "draft", frame: fi });
  assert.equal(mi.events.length, ist.events.length);
});

test("9. a prepared basemap travels into the composition unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-map-"));
  try {
    const frame = fitFrame(sample.events, W, H);
    const model = buildReplay(sample, { quality: "draft", frame });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4300000000049454e44ae426082", "hex");
    const meta = { width: W, height: H, pixelRatio: 1, camera: model.camera, attribution: "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors" };
    const out = join(dir, "comp");
    const { model: built } = buildComposition({ text: SAMPLE, filename: "sample-ankara-storm.json", settings: { quality: "draft", frame }, outDir: out, mapImage: { png, meta } });
    assert.deepEqual(readFileSync(join(out, "assets", "basemap.png")), png);
    const ctx = { window: {} };
    vm.runInNewContext(readFileSync(join(out, "replay-input.js"), "utf8"), ctx);
    const input = JSON.parse(JSON.stringify(ctx.window.__REPLAY_INPUT)); // out of the vm realm
    assert.deepEqual(input.map, { src: "assets/basemap.png", attribution: meta.attribution });
    assert.deepEqual(input.settings.frame, model.settings.frame);
    const rebuilt = buildReplay(parseDataset(input.text, input.filename), input.settings, input.geo);
    assert.deepEqual(rebuilt.events.map((e) => [e.x, e.y, e.v]), built.events.map((e) => [e.x, e.y, e.v]));
    assert.match(readFileSync(join(out, "index.html"), "utf8"), /await image\.decode\(\)/);
    // A basemap baked for another frame (or size) is refused rather than misaligned.
    const moved = buildReplay(sample, { quality: "draft", frame: { ...frame, west: frame.west + 0.1, east: frame.east + 0.1 } });
    assert.match(basemapMismatch(meta, moved), /frame changed/);
    assert.match(basemapMismatch({ ...meta, width: 1280 }, model), /1280/);
    assert.throws(() => buildComposition({ text: SAMPLE, filename: "s.json", settings: { quality: "draft", frame: moved.settings.frame }, outDir: out, mapImage: { png, meta } }), /Lock the frame again/);
    // Map images replace the Natural Earth outlines and the place list.
    const withMap = buildReplay(sample, { quality: "draft", frame }, { places: [{ name: "Ankara", lat: 39.92, lon: 32.85, rank: 1 }], mapImage: { image: {}, attribution: "x" } });
    assert.equal(withMap.basemap, null);
    assert.deepEqual(withMap.places, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9b. dark style tuning and offline fallback style", () => {
  const stock = {
    version: 8, sources: {},
    layers: [
      { id: "background", type: "background", paint: { "background-color": "rgb(12,12,12)" } },
      { id: "highway_major_subtle", type: "line", "source-layer": "transportation", paint: { "line-color": "#2a2a2a" } },
      { id: "road_oneway", type: "symbol", "source-layer": "transportation" },
      { id: "place_city", type: "symbol", "source-layer": "place", paint: { "text-color": "rgb(101,101,101)" } },
      { id: "x", type: "line", "source-layer": "transportation", paint: { "line-color": ["interpolate", ["linear"], ["zoom"], 5, "hsla(0,0%,85%,0.53)", 6, "#000"] } },
    ],
  };
  const t = tuneDark(stock);
  assert.equal(t.layers.find((l) => l.id === "road_oneway"), undefined);
  assert.equal(t.layers[0].paint["background-color"], "#070a10");
  const [r, g, b] = t.layers[1].paint["line-color"].match(/[\d.]+/g).map(Number);
  assert.ok(b > r && b > g, "roads tinted navy");
  assert.ok(Array.isArray(t.layers.find((l) => l.id === "x").paint["line-color"]), "expressions keep their shape");
  assert.equal(stock.layers.length, 5, "input style not mutated");
  const ne = JSON.parse(readFileSync(join(ROOT, "basemap", "ne-50m.json"), "utf8"));
  const off = offlineStyle(ne);
  assert.ok(off.sources.land.data.features.length > 10);
  assert.ok(!JSON.stringify(off).includes("http"), "offline style needs no network");
});

test("10. MapLibre draws a coordinate on the exact pixel the replay uses", { timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lr-bake-"));
  try {
    const frame = fitFrame(sample.events, W, H);
    const proj = frameProjection(frame, W, H);
    const known = [[32.8541, 39.9208], [32.40, 39.70], [33.30, 40.15]]; // Ankara centre + two far apart
    const { png, meta } = await renderBasemap({ frame, width: W, height: H, style: markerStyle(known), probes: sample.events.map((e) => [e.lon, e.lat]) });
    assert.ok(meta.alignment.maxErrorPx < 1e-6, `bridge error ${meta.alignment.maxErrorPx}`);
    assert.equal(meta.alignment.probes, 25 + sample.events.length);
    const file = join(dir, "b.png");
    writeFileSync(file, png);
    const img = decodeRgb(file);
    assert.deepEqual([img.width, img.height], [W * 2, H * 2]);
    for (const [lon, lat] of known) {
      const [x, y] = proj.project(lon, lat);
      const c = centroid(img, x * 2, y * 2, 40, isMagenta);
      assert.ok(c && c[2] > 50, `ring found at ${lon},${lat}`);
      // Ring centre vs. replay position, in output (960 × 540) pixels.
      const off = Math.hypot(c[0] / 2 - x, c[1] / 2 - y);
      t.diagnostic(`${lon},${lat}: basemap ring centre ${off.toFixed(3)} px from the replay position`);
      assert.ok(off < 0.25, `${lon},${lat}: ring at ${c[0] / 2},${c[1] / 2}, replay at ${x},${y}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("11. map download failures are reported, never baked as a blank map", { timeout: 180000 }, async () => {
  const frame = fitFrame(sample.events, W, H);
  // Style unreachable (provider down / offline).
  await assert.rejects(renderBasemap({ frame, width: W, height: H, styleUrl: "http://127.0.0.1:9/style.json", timeoutMs: 15000 }), (e) => e instanceof MapPrepError && /Could not reach the map provider/.test(e.message));
  // Style loads but its tiles do not.
  const broken = { version: 8, sources: { v: { type: "vector", tiles: ["http://127.0.0.1:9/{z}/{x}/{y}.pbf"], maxzoom: 14 } }, layers: [{ id: "bg", type: "background", paint: { "background-color": "#000" } }, { id: "roads", type: "line", source: "v", "source-layer": "transportation" }] };
  await assert.rejects(renderBasemap({ frame, width: W, height: H, style: broken, timeoutMs: 15000 }), (e) => e instanceof MapPrepError && /failed to load|did not finish/.test(e.message));
});
