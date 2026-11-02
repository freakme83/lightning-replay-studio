// Map layer groups: defaults, validation, style patching, cache identity, and parity between the
// interactive map and the baked PNG. Browser tests drive real MapLibre in headless Chrome with an
// offline style (no network).
//   node --test tests/layers.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { parseDataset } from "../src/core/parse.js";
import { frameProjection, cameraOf } from "../src/core/projection.js";
import { buildReplay, fitFrame } from "../src/core/replay.js";
import { basemapMismatch, layersMismatch, ROOT } from "../src/export/composition.js";
import { renderBasemap, findChrome } from "../src/map/render-basemap.js";
import { tuneDark } from "../src/map/providers.js";
import {
  LAYER_GROUPS, defaultLayers, normalizeLayers, layersKey, layersAreDefault, parseLayerSpec,
  availableGroups, layerPatches, applyLayers,
} from "../src/map/layers.js";
import { decodeRgb, layerStyle, pixel } from "./helpers.js";

const W = 960, H = 540;
const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json");
const fixture = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "openfreemap-dark-layers.json"), "utf8"));
// The provider's real layer list, tuned exactly as the studio tunes it.
const providerStyle = tuneDark({ version: 8, sources: {}, layers: fixture.layers });
const byId = (style, id) => style.layers.find((l) => l.id === id);

test("12. layer defaults, validation and reset", () => {
  const d = defaultLayers();
  assert.deepEqual(Object.keys(d), ["roadsMajor", "roadsMinor", "labels", "boundaries", "water", "land"]);
  assert.equal(d.roadsMajor.visible, true);
  assert.ok(d.roadsMinor.opacity < 1, "minor roads are subdued by default");
  assert.equal(LAYER_GROUPS.find((g) => g.id === "roadsMinor").minZoom, 12);
  assert.ok(d.boundaries.opacity < 1, "boundaries are subtle by default");
  for (const g of LAYER_GROUPS) assert.ok(g.label && g.hint, g.id);
  // Visibility and opacity are honoured, everything else is defaulted.
  const n = normalizeLayers({ water: { visible: false }, labels: { opacity: 0.4 }, land: { visible: false, opacity: 0.2 } });
  assert.deepEqual(n.water, { ...defaultLayers().water, visible: false });
  assert.deepEqual(n.labels, { visible: true, opacity: 0.4, textCase: "original" });
  assert.deepEqual(n.land, { visible: false, opacity: 0.2 });
  assert.deepEqual(n.roadsMajor, d.roadsMajor);
  // Invalid input never throws and never leaks through.
  const bad = normalizeLayers({
    roadsMajor: { visible: "yes", opacity: "abc" }, roadsMinor: { opacity: 7 }, labels: { opacity: -3 },
    boundaries: { opacity: NaN }, water: null, land: { opacity: "" }, bogus: { visible: false }, __proto__: { visible: false },
  });
  assert.deepEqual(bad.roadsMajor, d.roadsMajor);
  assert.equal(bad.roadsMinor.opacity, 1, "clamped to 1");
  assert.equal(bad.labels.opacity, 0, "clamped to 0");
  assert.equal(bad.boundaries.opacity, d.boundaries.opacity);
  assert.deepEqual(bad.water, d.water);
  assert.deepEqual(bad.land, d.land);
  assert.equal(bad.bogus, undefined);
  for (const junk of [null, undefined, 5, "x", []]) assert.deepEqual(normalizeLayers(junk), d);
  assert.equal(normalizeLayers({ labels: { opacity: "0.456" } }).labels.opacity, 0.46);
  // The cache identity ignores key order and spelling, and changes with every setting.
  const k = layersKey(d);
  assert.equal(layersKey({ land: d.land, water: d.water }), k);
  assert.equal(layersKey(null), k);
  assert.ok(layersAreDefault(d) && layersAreDefault(undefined));
  for (const g of LAYER_GROUPS) {
    assert.notEqual(layersKey({ [g.id]: { visible: false } }), k, `${g.id} visibility`);
    assert.notEqual(layersKey({ [g.id]: { opacity: 0.05 } }), k, `${g.id} opacity`);
  }
  // "Reset to defaults" = normalising the defaults again.
  const edited = normalizeLayers({ water: { visible: false }, roadsMinor: { opacity: 1 } });
  assert.ok(!layersAreDefault(edited));
  assert.ok(layersAreDefault(defaultLayers()));
  // CLI spec.
  assert.deepEqual(parseLayerSpec("roadsMinor=off, labels=40,water=on"), { roadsMinor: { visible: false }, labels: { visible: true, opacity: 0.4 }, water: { visible: true } });
  assert.deepEqual(parseLayerSpec("labels=40,labelCase=natural"), { labels: { visible: true, opacity: 0.4, textCase: "natural" } });
  assert.deepEqual(parseLayerSpec("labelCase=natural,labels=off"), { labels: { textCase: "natural", visible: false } });
  assert.throws(() => parseLayerSpec("labelCase=lower"), /labelCase must be original or natural/);
  assert.deepEqual(parseLayerSpec(undefined), {});
  assert.throws(() => parseLayerSpec("streets=off"), /Unknown map layer "streets"/);
  assert.throws(() => parseLayerSpec("labels=lots"), /expected on, off or a percentage/);
});

test("13b. provider tuning: province borders are solid and include region-shared levels; minor roads are readable", () => {
  const raw = fixture.layers.find((l) => l.id === "boundary_state");
  assert.deepEqual(raw.filter, ["==", ["get", "admin_level"], 4], "fixture still has the stock filter");
  assert.ok(raw.paint["line-dasharray"], "…and the stock dashes");
  const st = byId(providerStyle, "boundary_state");
  assert.equal(st.paint["line-dasharray"], undefined);
  // Matches admin_level 3 and 4 (Türkiye's region/province shared ways are tagged 3), never 2 (country) or 6 (district).
  const matches = (lvl) => lvl >= st.filter[1][2] && lvl <= st.filter[2][2]; // ["all", [">=", get, 3], ["<=", get, 4]]
  assert.deepEqual([2, 3, 4, 5, 6].map(matches), [false, true, true, false, false]);
  assert.ok(byId(providerStyle, "boundary_country_z5-").paint["line-dasharray"] === undefined);
  // Minor roads are clearly lighter than the background, yet darker than the major-road casing.
  const lum = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
  const bg = lum(providerStyle.layers[0].paint["background-color"].startsWith("#") ? "rgb(7,10,16)" : providerStyle.layers[0].paint["background-color"]);
  for (const id of ["highway_minor", "highway_path"]) assert.ok(lum(byId(providerStyle, id).paint["line-color"]) > bg + 40, id);
  assert.ok(lum(byId(providerStyle, "highway_minor").paint["line-color"]) < lum(byId(providerStyle, "highway_major_casing").paint["line-color"]));
});

test("13. layer groups drive the provider's style layers; missing layers are tolerated", () => {
  // Every group finds layers in the real OpenFreeMap dark style.
  const found = availableGroups(providerStyle);
  for (const g of LAYER_GROUPS) assert.ok(found[g.id] > 0, `${g.id} matches provider layers`);
  assert.ok(byId(providerStyle, "highway_motorway_inner") && byId(providerStyle, "place_city") && byId(providerStyle, "boundary_state"));

  const before = JSON.stringify(providerStyle);
  const style = applyLayers(providerStyle, { roadsMajor: { visible: false }, roadsMinor: { opacity: 0.5 }, labels: { opacity: 0.4 }, boundaries: { visible: false }, water: { opacity: 0.5 }, land: { visible: false } });
  assert.equal(JSON.stringify(providerStyle), before, "input style not mutated");
  const vis = (id) => byId(style, id).layout?.visibility;
  // Visibility toggles reach every layer of a group, and only those.
  for (const id of ["highway_major_inner", "highway_motorway_casing", "highway_major_subtle"]) assert.equal(vis(id), "none", id);
  for (const id of ["boundary_state", "boundary_country_z5-"]) assert.equal(vis(id), "none", id);
  for (const id of ["landuse_park", "landcover_wood"]) assert.equal(vis(id), "none", id);
  for (const id of ["highway_minor", "place_city", "place_town", "water", "waterway"]) assert.equal(vis(id), "visible", id);
  assert.equal(byId(style, "background").layout?.visibility, undefined, "background is never touched");
  // Opacity multiplies the style's own value (highway_minor is 0.9).
  assert.equal(byId(style, "highway_minor").paint["line-opacity"], 0.45);
  assert.equal(byId(style, "water").paint["fill-opacity"], 0.5);
  assert.equal(byId(style, "place_city").paint["text-opacity"], 0.4);
  assert.equal(byId(style, "place_city").paint["icon-opacity"], 0.18); // the dark tuning's 0.45 × 0.4
  // Zoom-dependent opacity stays a valid top-level interpolate with scaled outputs.
  const wood = applyLayers(providerStyle, { land: { opacity: 0.5 } });
  assert.deepEqual(byId(wood, "landcover_wood").paint["fill-opacity"], ["interpolate", ["exponential", 0.3], ["zoom"], 8, 0, 10, 0.4, 13, 0.2]);
  // Zero opacity hides, like switching the group off.
  assert.equal(byId(applyLayers(providerStyle, { water: { opacity: 0 } }), "water").layout.visibility, "none");
  // Patches are computed from the base style: re-applying never compounds.
  const p1 = layerPatches(providerStyle, { roadsMinor: { opacity: 0.5 } });
  const p2 = layerPatches(providerStyle, { roadsMinor: { opacity: 0.5 } });
  assert.deepEqual(p1, p2);
  assert.deepEqual(layerPatches(providerStyle, defaultLayers()).find((p) => p.id === "water").paint, { "fill-opacity": 1, "fill-color": byId(providerStyle, "water").paint["fill-color"] }); // Original: the provider's own colour, written explicitly

  // A style that lacks some (or all) of the layers: no error, unavailable groups reported.
  const partial = { version: 8, sources: {}, layers: [{ id: "background", type: "background" }, { id: "water", type: "fill", source: "x" }] };
  assert.deepEqual(availableGroups(partial), { roadsMajor: 0, roadsMinor: 0, labels: 0, boundaries: 0, water: 1, land: 0 });
  assert.doesNotThrow(() => applyLayers(partial, { roadsMajor: { visible: false }, water: { visible: false } }));
  assert.equal(byId(applyLayers(partial, { water: { visible: false } }), "water").layout.visibility, "none");
  for (const empty of [{ version: 8, sources: {}, layers: [] }, { version: 8 }]) {
    assert.doesNotThrow(() => layerPatches(empty, defaultLayers()));
    assert.ok(Object.values(availableGroups(empty)).every((n) => n === 0));
  }
  // A layer of the wrong type is not captured by a group (a "water_name" label is not Water).
  assert.equal(availableGroups({ layers: [{ id: "water_name", type: "symbol" }, { id: "place_x", type: "line" }] }).water, 0);
  assert.equal(availableGroups({ layers: [{ id: "place_x", type: "line" }] }).labels, 0);
});

const frame = fitFrame(sample.events, W, H);
const cam = cameraOf(frameProjection(frame, W, H), W, H);
const styleBlueGreen = () => layerStyle(cam.lon);
const LEFT = [W * 0.2 * 2, H * 0.5 * 2], RIGHT = [W * 0.8 * 2, H * 0.5 * 2]; // device pixels (pixelRatio 2)
const bake = (layers, extra = {}) => renderBasemap({ frame, width: W, height: H, style: styleBlueGreen(), layers, ...extra });
const decode = (dir, name, png) => { const f = join(dir, name); writeFileSync(f, png); return decodeRgb(f); };

test("18. place-name letter case: stock style uppercases via text-transform; natural case switches it off, nothing is re-cased", () => {
  const labelLayers = providerStyle.layers.filter((l) => /^place_/.test(l.id) && l.type === "symbol");
  assert.ok(labelLayers.length >= 10 && labelLayers.every((l) => l.layout["text-transform"] === "uppercase"), "stock labels are upper-cased by the style");
  assert.ok(labelLayers.every((l) => JSON.stringify(l.layout["text-field"]).includes("name_en")), "text-field reads the natural-case name");
  // Default / original keeps the style's own transform; natural drops it; text-field is never touched.
  const orig = applyLayers(providerStyle, defaultLayers()), nat = applyLayers(providerStyle, { labels: { textCase: "natural" } });
  for (const l of labelLayers) {
    assert.equal(byId(orig, l.id).layout["text-transform"], "uppercase", l.id);
    assert.equal(byId(nat, l.id).layout["text-transform"], "none", l.id);
    assert.deepEqual(byId(nat, l.id).layout["text-field"], l.layout["text-field"], `${l.id} text-field untouched`);
    assert.equal(byId(nat, l.id).layout["text-font"][0], l.layout["text-font"][0]);
  }
  // Only place labels are affected, and switching back restores the original (patches come from the base style).
  assert.deepEqual(byId(nat, "highway_motorway_inner").layout, { ...byId(providerStyle, "highway_motorway_inner").layout, visibility: "visible" });
  assert.deepEqual(layerPatches(providerStyle, { labels: { textCase: "original" } }), layerPatches(providerStyle, defaultLayers()));
  // Invalid values fall back to the default; the cache identity covers the option.
  assert.equal(normalizeLayers({ labels: { textCase: "lower" } }).labels.textCase, "original");
  assert.equal(normalizeLayers({ labels: { textCase: "NATURAL" } }).labels.textCase, "original");
  assert.equal(normalizeLayers({ water: { textCase: "natural" } }).water.textCase, undefined, "only labels have a case option");
  assert.notEqual(layersKey({ labels: { textCase: "natural" } }), layersKey(defaultLayers()));
  assert.equal(layersKey({ labels: { textCase: "original" } }), layersKey(defaultLayers()));
  // The transform is a layout property a symbol layer needs; a style without labels is fine.
  assert.doesNotThrow(() => applyLayers({ version: 8, layers: [{ id: "water", type: "fill" }] }, { labels: { textCase: "natural" } }));
  // Turkish names survive: the style never rewrites text, and JS-style upper-casing is exactly what breaks dotted İ/ı.
  for (const name of ["İstanbul", "Şanlıurfa", "Iğdır", "Çanakkale"]) assert.equal(name.normalize("NFC"), name);
  assert.equal("Şişli".toUpperCase(), "ŞIŞLI", "locale-free upper-casing turns i into plain I (wrong in Turkish)");
});

test("14. baked basemap: layers change the pixels, the cache keys on them, the frame does not drift", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-layers-"));
  const cacheDir = join(dir, "cache");
  try {
    const def = await bake(null, { cacheDir });
    const noSea = await bake({ water: { visible: false } }, { cacheDir });
    const halfPark = await bake({ land: { opacity: 0.5 }, boundaries: { visible: false } }, { cacheDir });
    const a = decode(dir, "a.png", def.png), b = decode(dir, "b.png", noSea.png), c = decode(dir, "c.png", halfPark.png);
    const [r, g, bl] = [0, 1, 2];
    // Default: blue sea left, green park right, magenta border in the middle.
    assert.ok(pixel(a, ...LEFT)[bl] > 250 && pixel(a, ...RIGHT)[g] > 250);
    assert.ok(Math.abs(pixel(a, W, H)[r] - 153) <= 4, `boundary at the default 60 %: ${pixel(a, W, H)}`); // 0.6 × 255 over the fills
    // Water off: the sea is gone, the park is untouched.
    assert.deepEqual(pixel(b, ...LEFT), [0, 0, 0]);
    assert.ok(pixel(b, ...RIGHT)[g] > 250);
    // Park at 50 %: blended onto the black background; boundary off: no line in the middle.
    assert.ok(Math.abs(pixel(c, ...RIGHT)[g] - 128) <= 3, `got ${pixel(c, ...RIGHT)}`);
    assert.ok(pixel(c, ...LEFT)[bl] > 250);
    assert.ok(pixel(c, W, H)[r] < 30, "boundary hidden");

    // Cache identity: same layers hit the cache, any change of a layer setting misses it.
    assert.equal(def.cached, false);
    const again = await bake(normalizeLayers({}), { cacheDir });
    assert.equal(again.cached, true);
    assert.equal(again.meta.id, def.meta.id);
    const ids = new Set([def.meta.id, noSea.meta.id, halfPark.meta.id]);
    assert.equal(ids.size, 3, "distinct layer settings → distinct cache entries");
    assert.equal((await bake({ water: { visible: false } }, { cacheDir })).cached, true);
    assert.equal((await bake({ water: { visible: false, opacity: 0.99 } }, { cacheDir })).cached, false, "a tiny opacity change is a different image");
    // Invalid layer input is normalised before keying, so it maps onto the defaults' entry.
    assert.equal((await bake({ water: { visible: "no" }, labels: { opacity: "x" } }, { cacheDir })).meta.id, def.meta.id);
    assert.equal(def.meta.layersKey, layersKey(defaultLayers()));
    assert.equal(noSea.meta.layers.water.visible, false);

    // Locked-frame updates: same frame, same camera, same alignment; only the pixels differ.
    for (const m of [def.meta, noSea.meta, halfPark.meta]) {
      assert.deepEqual(m.camera, def.meta.camera);
      assert.deepEqual(m.frame, def.meta.frame);
      assert.ok(m.alignment.maxErrorPx < 1e-6);
    }
    const model = buildReplay(sample, { frame });
    for (const m of [def.meta, noSea.meta, halfPark.meta]) assert.equal(basemapMismatch(m, model), null);
    // Strike pixels and timing never depend on the map image or its layers.
    const withMap = buildReplay(sample, { frame }, { mapImage: { image: {}, attribution: "x" } });
    assert.deepEqual(withMap.events.map((e) => [e.id, e.x, e.y, e.v]), model.events.map((e) => [e.id, e.x, e.y, e.v]));
    // The export refuses a map baked with other layers than the ones the user expects.
    assert.equal(layersMismatch(noSea.meta, { water: { visible: false } }), null);
    assert.match(layersMismatch(noSea.meta, defaultLayers()), /layers changed/);
    assert.equal(layersMismatch(def.meta, undefined), null);
    assert.match(layersMismatch({}, defaultLayers()), /does not record/);
    // The layers a provider doesn't have are reported, and the bake still succeeds.
    assert.deepEqual(def.meta.layerGroups, { roadsMajor: 0, roadsMinor: 0, labels: 0, boundaries: 1, water: 1, land: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("14b. a style without any of the layer groups bakes fine", { timeout: 120000 }, async () => {
  const bare = { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#123456" } }] };
  const r = await renderBasemap({ frame, width: W, height: H, style: bare, layers: { water: { visible: false }, labels: { opacity: 0.1 } } });
  assert.ok(Object.values(r.meta.layerGroups).every((n) => n === 0));
  assert.ok(r.png.length > 100);
});

/** The interactive path: base style + the same patches, applied through MapLibre's own API. */
async function renderInteractive({ style, layers }) {
  const { default: puppeteer } = await import("puppeteer-core");
  const dist = join(ROOT, "node_modules", "maplibre-gl", "dist"), mapDir = join(ROOT, "src", "map");
  const server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><body style='margin:0'><div id=map></div>"); }
    for (const [prefix, dir] of [["/maplibre/", dist], ["/map/", mapDir]]) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(dir, path.slice(prefix.length)));
      if (file.startsWith(dir + sep)) { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(await readFile(file)); }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const url = await page.evaluate(async (o) => {
      const maplibregl = await import("/maplibre/maplibre-gl.mjs");
      const { layerPatches } = await import("/map/layers.js");
      const el = document.getElementById("map");
      el.style.cssText = `position:absolute;left:0;top:0;width:${o.w}px;height:${o.h}px`;
      const map = new maplibregl.Map({ container: el, style: o.style, center: [o.cam.lon, o.cam.lat], zoom: o.cam.zoom, pixelRatio: 2, fadeDuration: 0, interactive: false, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true } });
      await new Promise((r) => map.once("idle", r)); // base style fully drawn first, then toggled live
      for (const p of layerPatches(o.style, o.layers)) {
        map.setLayoutProperty(p.id, "visibility", p.visibility);
        for (const [k, v] of Object.entries(p.layout)) map.setLayoutProperty(p.id, k, v);
        for (const [k, v] of Object.entries(p.paint)) map.setPaintProperty(p.id, k, v);
      }
      await new Promise((r) => { map.once("idle", r); map.triggerRepaint(); });
      return map.getCanvas().toDataURL("image/png");
    }, { style, layers, cam, w: W, h: H });
    return Buffer.from(url.split(",")[1], "base64");
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

test("15. the interactive map and the baked PNG render identical pixels for the same layers", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-parity-"));
  try {
    const layers = { water: { opacity: 0.5 }, land: { visible: false }, boundaries: { opacity: 0.3 } };
    const baked = decode(dir, "baked.png", (await bake(layers)).png);
    const live = decode(dir, "live.png", await renderInteractive({ style: styleBlueGreen(), layers }));
    assert.deepEqual([live.width, live.height], [baked.width, baked.height]);
    let worst = 0, sum = 0;
    for (let i = 0; i < baked.data.length; i++) { const d = Math.abs(baked.data[i] - live.data[i]); worst = Math.max(worst, d); sum += d; }
    assert.ok(worst <= 2 && sum / baked.data.length < 0.05, `max diff ${worst}, mean ${(sum / baked.data.length).toFixed(4)}`);
    // And the layers really were applied in the live path (sea at 50 %, park gone).
    assert.ok(Math.abs(pixel(live, ...LEFT)[2] - 128) <= 3 && pixel(live, ...RIGHT)[1] === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15b. water colour, brightness and opacity: the interactive map and the baked PNG render identical pixels", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-parity-water-"));
  try {
    // Live path = layerPatches() through setPaintProperty on an already-drawn map; bake path = applyLayers() before load.
    for (const water of [{ colorMode: "custom", customColor: "#208040" }, { colorMode: "blue", brightness: 30, opacity: 0.7 }, { colorMode: "original", brightness: -20 }]) {
      const layers = { water };
      const baked = decode(dir, "baked.png", (await bake(layers)).png);
      const live = decode(dir, "live.png", await renderInteractive({ style: styleBlueGreen(), layers }));
      let worst = 0;
      for (let i = 0; i < baked.data.length; i++) worst = Math.max(worst, Math.abs(baked.data[i] - live.data[i]));
      assert.ok(worst <= 2, `${JSON.stringify(water)}: max diff ${worst}`);
      assert.notDeepEqual(pixel(live, ...LEFT), [0, 0, 255], `${JSON.stringify(water)} changed the sea in the live map`);
      assert.deepEqual(pixel(live, ...RIGHT), [0, 255, 0], "land untouched");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("16. layers work for any location: Istanbul and a southern-hemisphere fixture", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-global-"));
  try {
    const places = [
      ["istanbul", parseDataset(readFileSync(join(ROOT, "data", "sample-istanbul-squall.csv"), "utf8"), "sample-istanbul-squall.csv")],
      ["saopaulo", parseDataset(readFileSync(join(ROOT, "tests", "fixtures", "synthetic-saopaulo.json"), "utf8"), "synthetic-saopaulo.json")],
    ];
    for (const [name, ds] of places) {
      assert.ok(ds.ok && ds.events.length > 10, name);
      const f = fitFrame(ds.events, W, H);
      const c = cameraOf(frameProjection(f, W, H), W, H);
      const run = (layers) => renderBasemap({ frame: f, width: W, height: H, style: layerStyle(c.lon), layers, probes: ds.events.map((e) => [e.lon, e.lat]) });
      const def = await run(null), noWater = await run({ water: { visible: false }, land: { opacity: 0.5 } });
      assert.ok(def.meta.alignment.maxErrorPx < 1e-6 && noWater.meta.alignment.maxErrorPx < 1e-6, `${name} aligned`);
      const a = decode(dir, `${name}-a.png`, def.png), b = decode(dir, `${name}-b.png`, noWater.png);
      assert.ok(pixel(a, ...LEFT)[2] > 250 && pixel(a, ...RIGHT)[1] > 250, `${name} default layers`);
      assert.deepEqual(pixel(b, ...LEFT), [0, 0, 0], `${name} water off`);
      assert.ok(Math.abs(pixel(b, ...RIGHT)[1] - 128) <= 3, `${name} land at 50 %`);
      assert.notEqual(def.meta.id, noWater.meta.id);
      // Strikes land inside the frame regardless of hemisphere.
      const m = buildReplay(ds, { quality: "draft", frame: f });
      for (const e of m.events) assert.ok(e.x >= 0 && e.x <= W && e.y >= 0 && e.y <= H, `${name} ${e.id}`);
    }
    assert.ok(places[1][1].events.every((e) => e.lat < 0 && e.lon < 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("17. lat/lon grid: off by default, validated, drawn by the shared renderer, no effect on positions or timing", async () => {
  const { drawFrame } = await import("../src/core/draw.js");
  const { normalizeSettings, DEFAULTS } = await import("../src/core/replay.js");
  assert.equal(DEFAULTS.showGrid, false);
  assert.equal(normalizeSettings({}).showGrid, false);
  assert.equal(normalizeSettings({ showGrid: true }).showGrid, true);
  assert.equal(normalizeSettings({ showGrid: "true" }).showGrid, true);
  assert.equal(normalizeSettings({ showGrid: "yes" }).showGrid, false);
  assert.throws(() => normalizeSettings({ gridOpacity: 2 }), /Grid opacity must be between 0 and 1/);
  assert.throws(() => normalizeSettings({ gridOpacity: "x" }), /Grid opacity/);

  // A recording 2D context: counts degree labels and the line alphas used for the graticule.
  const record = (model, t) => {
    const log = { labels: [], strokeAlphas: [], state: { globalAlpha: 1 } };
    const ctx = new Proxy({}, {
      get: (_, k) => {
        if (k === "measureText") return (s) => ({ width: String(s).length * 5 });
        if (k === "createLinearGradient" || k === "createRadialGradient") return () => ({ addColorStop() {} });
        if (k === "fillText") return (s) => { if (/°[NSEW]$/.test(s)) log.labels.push({ s, a: log.state.globalAlpha }); };
        if (k === "stroke") return () => log.strokeAlphas.push(log.state.globalAlpha);
        if (k in log.state) return log.state[k];
        return () => {};
      },
      set: (_, k, v) => { log.state[k] = v; return true; },
    });
    drawFrame(ctx, model, t);
    return log;
  };
  const frame = fitFrame(sample.events, W, H);
  const off = buildReplay(sample, { quality: "draft", frame }, { mapImage: { image: {}, attribution: "x" } });
  const on = buildReplay(sample, { quality: "draft", frame, showGrid: true, gridOpacity: 1 }, { mapImage: { image: {}, attribution: "x" } });
  const dim = buildReplay(sample, { quality: "draft", frame, showGrid: true, gridOpacity: 0.25 }, { mapImage: { image: {}, attribution: "x" } });
  assert.equal(record(off, 3).labels.length, 0, "no degree labels when off");
  const a = record(on, 3), b = record(dim, 3);
  assert.ok(a.labels.length >= 4 && a.labels.some((l) => /°E$/.test(l.s)) && a.labels.some((l) => /°N$/.test(l.s)));
  assert.equal(a.labels.length, b.labels.length, "same lines at any opacity");
  assert.ok(Math.max(...a.labels.map((l) => l.a)) > Math.max(...b.labels.map((l) => l.a)), "opacity changes the label strength");
  // Grid never moves a strike or changes timing.
  assert.deepEqual(on.events.map((e) => [e.id, e.x, e.y, e.v]), off.events.map((e) => [e.id, e.x, e.y, e.v]));
  assert.deepEqual(on.camera, off.camera);
  // The export carries the setting: the composition embeds the normalised settings the preview used.
  const dir = mkdtempSync(join(tmpdir(), "lr-grid-"));
  try {
    const { buildComposition } = await import("../src/export/composition.js");
    buildComposition({ text: SAMPLE, filename: "s.json", settings: { frame, showGrid: true, gridOpacity: 0.7 }, outDir: join(dir, "c") });
    const code = readFileSync(join(dir, "c", "replay-input.js"), "utf8");
    assert.match(code, /"showGrid":true/);
    assert.match(code, /"gridOpacity":0\.7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
