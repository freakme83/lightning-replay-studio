// Water appearance: colour presets, custom colour, brightness, opacity and Reset. Pure style patches on the
// provider's real layer list, real MapLibre bakes (offline style), and exported MP4 frames in all formats.
//   node --test tests/water.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay, fitFrame } from "../src/core/replay.js";
import { outputSize, designViewport } from "../src/core/format.js";
import { cameraOf, frameProjection } from "../src/core/projection.js";
import { basemapMismatch, buildComposition, layersMismatch, ROOT } from "../src/export/composition.js";
import { renderComposition, probeVideo, checkVideo } from "../src/export/render.js";
import { renderBasemap } from "../src/map/render-basemap.js";
import { tuneDark } from "../src/map/providers.js";
import { WATER_BRIGHTNESS, WATER_PRESETS, applyLayers, defaultLayers, layerPatches, layersKey, normalizeHex, normalizeLayers, parseLayerSpec } from "../src/map/layers.js";
import { decodeRgb, layerStyle, pixel } from "./helpers.js";

const fixture = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "openfreemap-dark-layers.json"), "utf8"));
const provider = tuneDark({ version: 8, sources: {}, layers: fixture.layers }); // the real OpenFreeMap Dark layers, tuned as the studio tunes them
const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json");
const WATER = ["water", "waterway"]; // OpenFreeMap: `water` fill (sea, ocean, lakes) and `waterway` line (rivers, canals)
const byId = (style, id) => style.layers.find((l) => l.id === id);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const colorOf = (style, id) => byId(style, id).paint[id === "water" ? "fill-color" : "line-color"];
const water = (w) => ({ water: w });

test("32. water appearance model: presets, custom colour, brightness bounds, identity, CLI", () => {
  const d = defaultLayers().water;
  assert.deepEqual([d.colorMode, d.brightness, d.visible, d.opacity], ["original", 0, true, 1]);
  assert.deepEqual(Object.keys(WATER_PRESETS), ["original", "blue", "teal", "custom"]);
  // Validation never throws; bad values fall back; brightness is clamped to ±50 and rounded.
  const n = normalizeLayers(water({ colorMode: "neon", customColor: "red", brightness: "x" })).water;
  assert.deepEqual([n.colorMode, n.customColor, n.brightness], ["original", d.customColor, 0]);
  assert.equal(normalizeLayers(water({ brightness: 999 })).water.brightness, WATER_BRIGHTNESS.max);
  assert.equal(normalizeLayers(water({ brightness: -999 })).water.brightness, WATER_BRIGHTNESS.min);
  assert.equal(normalizeLayers(water({ brightness: 12.6 })).water.brightness, 13);
  assert.equal(normalizeLayers(water({ customColor: "#ABC" })).water.customColor, "#aabbcc");
  assert.equal(normalizeHex("#12345"), null);
  assert.equal(normalizeLayers({ land: { colorMode: "blue", brightness: 30 } }).land.colorMode, undefined, "only water has appearance options");
  // Cache identity: the provider appearance keeps the pre-existing key; every real change is a new key; opacity and brightness are separate.
  assert.equal(layersKey(defaultLayers()), "roadsMajor:1@1|roadsMinor:1@0.6|labels:1@1/original|boundaries:1@0.6|water:1@1|land:1@1");
  assert.equal(layersKey(water({ colorMode: "original", customColor: "#ffffff" })), layersKey(defaultLayers()), "an unused custom colour is not part of Original");
  assert.equal(layersKey(water({ colorMode: "blue", customColor: "#ffffff" })), layersKey(water({ colorMode: "blue" })), "an unused custom colour is not part of a preset");
  const keys = [water({}), water({ colorMode: "blue" }), water({ colorMode: "teal" }), water({ colorMode: "custom" }), water({ colorMode: "custom", customColor: "#336699" }), water({ colorMode: "blue", brightness: 10 }), water({ brightness: 10 }), water({ colorMode: "blue", opacity: 0.5 })].map(layersKey);
  assert.equal(new Set(keys).size, keys.length);
  // CLI.
  assert.deepEqual(parseLayerSpec("waterColor=blue,waterBrightness=-20"), { water: { colorMode: "blue", brightness: -20 } });
  assert.deepEqual(parseLayerSpec("waterColor=#2A5A3A"), { water: { colorMode: "custom", customColor: "#2a5a3a" } });
  assert.deepEqual(parseLayerSpec("water=40,waterColor=teal"), { water: { visible: true, opacity: 0.4, colorMode: "teal" } });
  assert.throws(() => parseLayerSpec("waterColor=pink"), /waterColor must be/);
  assert.throws(() => parseLayerSpec("waterBrightness=80"), /waterBrightness must be/);
});

test("33. patches: only the water layers change colour; Original is the provider's own; presets separate sea from land; Reset restores", () => {
  const ids = provider.layers.filter((l) => WATER.includes(l.id)).map((l) => l.id);
  assert.deepEqual(ids, WATER, "the style has exactly the two water layers that carry colour");
  const def = applyLayers(provider, defaultLayers());
  const bg = hexRgb(byId(provider, "background").paint["background-color"]);
  const land = ["blue", "teal"].map((m) => applyLayers(provider, water({ colorMode: m })));
  for (const [i, mode] of ["blue", "teal"].entries()) {
    const out = land[i];
    // Everything but the two water layers is deep-equal to the default styling (land, roads, boundaries, labels).
    for (const l of provider.layers) if (!WATER.includes(l.id)) assert.deepEqual(byId(out, l.id), byId(def, l.id), `${mode}: ${l.id} untouched`);
    // Sea and rivers got the preset; opacity is untouched.
    assert.equal(colorOf(out, "water"), WATER_PRESETS[mode].color);
    assert.notEqual(colorOf(out, "waterway"), colorOf(def, "waterway"));
    assert.equal(byId(out, "water").paint["fill-opacity"], 1);
    // Separation from the land (the background colour): far better than the provider's colours.
    const sea = hexRgb(colorOf(out, "water"));
    assert.ok(contrast(sea, bg) >= 1.35, `${mode} contrast ${contrast(sea, bg).toFixed(2)}`);
    assert.ok(lum(sea) < 0.05, `${mode} stays dark (cinematic)`);
  }
  const orig = (c) => contrast(hexRgb(c), bg);
  assert.ok(orig(colorOf(def, "water")) < 1.12, "the provider's sea is almost the colour of the land: the problem being solved");
  // Original is exactly the provider's value, also after going back from another preset (live map restore path).
  assert.deepEqual(layerPatches(provider, water({ colorMode: "original", brightness: 0 })), layerPatches(provider, defaultLayers()));
  assert.equal(colorOf(def, "water"), colorOf(provider, "water"));
  assert.equal(colorOf(def, "waterway"), colorOf(provider, "waterway"));
  // Reset (the studio sets water to its defaults) restores the original appearance.
  const reset = { ...defaultLayers().water };
  assert.deepEqual(layerPatches(provider, { water: reset }), layerPatches(provider, defaultLayers()));
  // Custom colour: exact at brightness 0; rivers a little lighter.
  const custom = applyLayers(provider, water({ colorMode: "custom", customColor: "#2a5a3a" }));
  assert.equal(colorOf(custom, "water"), "#2a5a3a");
  assert.ok(lum(hexRgb(colorOf(custom, "waterway"))) > lum(hexRgb("#2a5a3a")));
});

test("34. brightness is bounded, monotonic and independent of opacity and visibility", () => {
  const sea = (w) => hexRgb(colorOf(applyLayers(provider, water(w)), "water"));
  for (const mode of ["blue", "teal", "original"]) {
    const ls = [-50, -25, 0, 25, 50].map((b) => lum(sea({ colorMode: mode, brightness: b })));
    for (let i = 1; i < ls.length; i++) assert.ok(ls[i] > ls[i - 1] - 1e-9, `${mode} brightness is monotonic`);
  }
  assert.ok(lum(sea({ colorMode: "blue", brightness: 50 })) > 1.5 * lum(sea({ colorMode: "blue" })), "+50 % is visibly lighter");
  assert.ok(lum(sea({ colorMode: "blue", brightness: -50 })) < 0.6 * lum(sea({ colorMode: "blue" })), "−50 % is visibly darker");
  // Bounded: brightening a bright custom colour does not wash it out further, and +50 % of a dark preset stays moderate.
  assert.deepEqual(sea({ colorMode: "custom", customColor: "#ffffff", brightness: 50 }), [255, 255, 255]);
  assert.ok(lum(sea({ colorMode: "blue", brightness: 50 })) < 0.2 && lum(sea({ colorMode: "teal", brightness: 50 })) < 0.2);
  // Independent: brightness never changes opacity/visibility, opacity and visibility never change the colour.
  const a = layerPatches(provider, water({ colorMode: "blue", brightness: 20, opacity: 0.4 })).find((p) => p.id === "water");
  const b = layerPatches(provider, water({ colorMode: "blue", brightness: 20, opacity: 1 })).find((p) => p.id === "water");
  const c = layerPatches(provider, water({ colorMode: "blue", brightness: -20, opacity: 0.4 })).find((p) => p.id === "water");
  assert.equal(a.paint["fill-color"], b.paint["fill-color"]);
  assert.equal(a.paint["fill-opacity"], c.paint["fill-opacity"]);
  assert.equal(a.paint["fill-opacity"], 0.4);
  assert.notEqual(a.paint["fill-color"], c.paint["fill-color"]);
  assert.equal(layerPatches(provider, water({ colorMode: "blue", visible: false })).find((p) => p.id === "water").visibility, "none");
  // A colour that is an expression cannot be shaded: Original keeps it rather than guessing.
  const expr = { version: 8, layers: [{ id: "water", type: "fill", paint: { "fill-color": ["interpolate", ["linear"], ["zoom"], 0, "#000", 10, "#123"] } }] };
  assert.deepEqual(layerPatches(expr, water({ brightness: 30 }))[0].paint["fill-color"], expr.layers[0].paint["fill-color"]);
});

// ---- real MapLibre bakes (offline style: blue sea left, green land right, magenta border) ----
const W = 960, H = 540;
const frame = fitFrame(sample.events, W, H);
const cam = cameraOf(frameProjection(frame, W, H), W, H);
const LEFT = [W * 0.2 * 2, H * 0.5 * 2], RIGHT = [W * 0.8 * 2, H * 0.5 * 2], MID = [W, 320];
const bake = (layers, extra = {}) => renderBasemap({ frame, width: W, height: H, style: layerStyle(cam.lon), layers, probes: sample.events.slice(0, 50).map((e) => [e.lon, e.lat]), ...extra });
const decode = (dir, name, png) => { const f = join(dir, name); writeFileSync(f, png); return decodeRgb(f); };
const near = (p, q, tol = 2) => p.every((v, i) => Math.abs(v - q[i]) <= tol);

test("35. baked basemap: custom colour, brightness and opacity work independently; nothing else moves", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-water-"));
  try {
    const orig = await bake(null);
    const o = decode(dir, "o.png", orig.png);
    assert.deepEqual(pixel(o, ...LEFT), [0, 0, 255], "Original reproduces the provider's sea");
    const variants = {
      custom: water({ colorMode: "custom", customColor: "#208040" }),
      dim: water({ colorMode: "custom", customColor: "#208040", brightness: -50 }),
      half: water({ colorMode: "custom", customColor: "#208040", opacity: 0.5 }),
      blue: water({ colorMode: "blue" }),
      brightBlue: water({ colorMode: "blue", brightness: 30 }),
    };
    const out = {};
    for (const [name, layers] of Object.entries(variants)) {
      const r = await bake(layers);
      out[name] = { r, img: decode(dir, `${name}.png`, r.png) };
      // Land, border and every pixel on the land side are exactly the Original's; only the sea changed.
      assert.deepEqual(pixel(out[name].img, ...RIGHT), pixel(o, ...RIGHT), `${name}: land unchanged`);
      assert.deepEqual(pixel(out[name].img, ...MID), pixel(o, ...MID), `${name}: border unchanged`);
      // Geography is untouched: same camera, same alignment, same strike probes, same frame.
      assert.deepEqual(r.meta.camera, orig.meta.camera);
      assert.deepEqual(r.meta.frame, orig.meta.frame);
      assert.ok(r.meta.alignment.maxErrorPx < 1e-6 && r.meta.alignment.probes === orig.meta.alignment.probes, `${name}: alignment`);
      assert.notEqual(r.meta.id, orig.meta.id, `${name}: its own cache entry`);
      assert.equal(r.meta.layersKey, layersKey(layers));
      assert.equal(layersMismatch(r.meta, layers), null);
      assert.ok(layersMismatch(r.meta, defaultLayers()), `${name}: an export expecting the original sea refuses this map`);
    }
    assert.ok(near(pixel(out.custom.img, ...LEFT), [32, 128, 64]), `custom ${pixel(out.custom.img, ...LEFT)}`);
    assert.ok(near(pixel(out.dim.img, ...LEFT), [16, 64, 32], 3), `−50 % ${pixel(out.dim.img, ...LEFT)}`);
    assert.ok(near(pixel(out.half.img, ...LEFT), [16, 64, 32], 3), `opacity 50 % blends the colour over the background ${pixel(out.half.img, ...LEFT)}`);
    assert.ok(lum(pixel(out.brightBlue.img, ...LEFT)) > lum(pixel(out.blue.img, ...LEFT)));
    assert.ok(near(pixel(out.blue.img, ...LEFT), hexRgb(WATER_PRESETS.blue.color)));
    assert.ok(contrast(pixel(out.blue.img, ...LEFT), [7, 10, 16]) > 1.35);
    // Same settings → same cache identity (and brightness/opacity changes are not conflated).
    assert.equal((await bake(variants.custom)).meta.id, out.custom.r.meta.id);
    assert.notEqual(out.dim.r.meta.id, out.half.r.meta.id);
    // The prepared map is accepted for its frame regardless of water colour.
    const model = buildReplay(sample, { quality: "draft", frame });
    assert.equal(basemapMismatch({ ...out.custom.r.meta, pixelRatio: 2 }, buildReplay(sample, { frame })), null);
    assert.deepEqual(model.events.map((e) => [e.x, e.y, e.v]), buildReplay(sample, { quality: "draft", frame }).events.map((e) => [e.x, e.y, e.v]), "strike coordinates and timing do not depend on the map");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("36. exported MP4: the chosen water colour is in the frame for all three formats, Full HD and Draft", { timeout: 900000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-water-mp4-"));
  const text = JSON.stringify([{ id: "a", timestamp: "2026-11-01T14:00:00+03:00", lat: 39.9, lon: 32.8, type: "IC" }, { id: "b", timestamp: "2026-11-01T14:30:00+03:00", lat: 39.95, lon: 32.9, type: "IC" }]);
  const events = parseDataset(text, "w.json").events;
  try {
    const cases = [["landscape", "hd", "custom"], ["landscape", "hd", "original"], ["landscape", "draft", "custom"], ["portrait", "draft", "custom"], ["square", "draft", "custom"], ["portrait", "hd", "custom"]];
    for (const [format, quality, which] of cases) {
      const { width: Wo, height: Ho } = outputSize(format, quality), vp = designViewport(Wo, Ho);
      const fr = fitFrame(events, Wo, Ho);
      const c = cameraOf(frameProjection(fr, vp.width, vp.height), vp.width, vp.height);
      const layers = which === "custom" ? water({ colorMode: "custom", customColor: "#208040", brightness: 20 }) : null;
      const mapImage = await renderBasemap({ frame: fr, width: vp.width, height: vp.height, pixelRatio: vp.k, style: layerStyle(c.lon + 0), layers });
      const name = `${format}-${quality}-${which}`;
      const { model } = buildComposition({ text, filename: "w.json", settings: { duration: 2, frame: fr, format, quality, overlays: { title: false, clock: false, counter: false, activity: false, scaleBar: false, legend: false, syntheticNotice: false, attribution: false } }, outDir: join(dir, name), mapImage });
      const mp4 = join(dir, `${name}.mp4`);
      await renderComposition({ dir: join(dir, name), output: mp4, fps: 24, quality: quality === "hd" ? "looks" : "draft" });
      assert.deepEqual(checkVideo(probeVideo(mp4), model.settings), [], name);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.1", "-i", mp4, "-frames:v", "1", join(dir, `${name}.png`)]);
      const img = decodeRgb(join(dir, `${name}.png`));
      const sea = pixel(img, Wo * 0.1, Ho * 0.5), land = pixel(img, Wo * 0.9, Ho * 0.5);
      const expected = which === "custom" ? hexRgb(applyLayers({ version: 8, layers: [{ id: "water", type: "fill", paint: { "fill-color": "#000" } }] }, layers).layers[0].paint["fill-color"]) : [0, 0, 255];
      assert.ok(near(sea, expected, 14), `${name}: sea ${sea}, expected ${expected}`);
      assert.ok(near(land, [0, 255, 0], 14), `${name}: land unchanged ${land}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
