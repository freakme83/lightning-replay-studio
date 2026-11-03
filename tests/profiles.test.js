// Studio Profiles: schema, normalization, import / export, the localStorage store, the geographic
// frame policy and preview ↔ export consistency (src/profiles/*).
//   node --test tests/profiles.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay, fitFrame, normalizeSettings } from "../src/core/replay.js";
import { outputSize } from "../src/core/format.js";
import { buildComposition, ROOT } from "../src/export/composition.js";
import { noOverlays } from "../src/core/overlays.js";
import { defaultLayers, layersKey, normalizeLayers } from "../src/map/layers.js";
import { createLayoutStore } from "../src/editor/layout-edit.js";
import {
  PROFILE_FILE_KIND, PROFILE_LIMITS, PROFILE_SCHEMA_VERSION, ProfileError, captureSettings, cleanName, normalizeProfile, normalizeProfileSettings,
  parseProfileText, profileFileName, sameSettings, serializeProfile, toReplaySettings, uniqueName,
} from "../src/profiles/profile.js";
import { PROFILE_STORAGE_KEY, createProfileStore } from "../src/profiles/profile-store.js";

/** A complete 9:16 composition like the one in the walkthrough: teal water, hidden layers, moved overlays in all formats. */
function composition() {
  const layouts = createLayoutStore();
  layouts.set("portrait", "title", { x: 0.5, y: 0.2, scale: 0.8 });
  layouts.set("portrait", "clock", { x: 0.9, y: 0.3, scale: 1.2, locked: true });
  layouts.set("landscape", "counter", { x: 0.3, y: 0.8, scale: 1.1 });
  layouts.set("square", "legend", { x: 0.6, y: 0.7, scale: 0.9 });
  const mapLayers = normalizeLayers({
    water: { colorMode: "teal", brightness: 15, opacity: 0.8 },
    roadsMinor: { visible: false },
    labels: { visible: false },
    boundaries: { opacity: 0.4 },
  });
  return {
    format: "portrait", quality: "hd", mapLayers, overlays: { ...noOverlays(), title: true, clock: true, activity: true },
    overlayLayouts: layouts.toJSON(), hudShading: 0.5, grid: { visible: true, opacity: 0.3 },
    replay: { duration: 30, trailMinutes: 45, markerScale: 1.5, showHistory: false },
    frame: { west: 28, south: 40, east: 30, north: 42 },
  };
}

/** Browser-like Storage in memory, with switches for the failure modes. */
function memoryStorage({ failGet = false, failSet = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem(k) { if (failGet) throw new DOMException("denied", "SecurityError"); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (failSet) throw new DOMException("full", "QuotaExceededError"); data.set(k, String(v)); },
  };
}
const fixedNow = () => "2026-11-03T10:00:00.000Z";

test("P1. a profile is versioned JSON and round-trips through export and import unchanged", () => {
  const settings = captureSettings(composition());
  const store = createProfileStore(memoryStorage(), { now: fixedNow });
  const p = store.create("Cinematic Mediterranean", settings);
  assert.equal(p.schemaVersion, PROFILE_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(p).sort(), ["createdAt", "id", "name", "schemaVersion", "settings", "updatedAt"]);
  const text = serializeProfile(p);
  assert.equal(JSON.parse(text).kind, PROFILE_FILE_KIND);
  const back = parseProfileText(text);
  assert.deepEqual(back.settings, p.settings);
  assert.equal(back.name, "Cinematic Mediterranean");
  assert.ok(sameSettings(back.settings, settings));
});

test("P2. every reusable setting is captured: format, quality, layers, water, overlays, all three layouts, shading, grid, replay", () => {
  const s = captureSettings(composition());
  assert.equal(s.format, "portrait");
  assert.equal(s.quality, "hd");
  assert.equal(s.mapLayers.water.colorMode, "teal");
  assert.equal(s.mapLayers.water.brightness, 15);
  assert.equal(s.mapLayers.water.opacity, 0.8);
  assert.equal(s.mapLayers.roadsMinor.visible, false);
  assert.equal(s.mapLayers.labels.visible, false);
  assert.equal(s.mapLayers.boundaries.opacity, 0.4);
  assert.equal(s.overlays.legend, false);
  assert.equal(s.overlays.title, true);
  assert.deepEqual(s.overlayLayouts.portrait.title, { x: 0.5, y: 0.2, scale: 0.8 });
  assert.deepEqual(s.overlayLayouts.portrait.clock, { x: 0.9, y: 0.3, scale: 1.2, locked: true });
  assert.deepEqual(s.overlayLayouts.landscape.counter, { x: 0.3, y: 0.8, scale: 1.1 });
  assert.deepEqual(s.overlayLayouts.square.legend, { x: 0.6, y: 0.7, scale: 0.9 });
  assert.equal(s.hudShading, 0.5);
  assert.deepEqual(s.grid, { visible: true, opacity: 0.3 });
  assert.deepEqual(s.replay, { duration: 30, trailMinutes: 45, markerScale: 1.5, showHistory: false });
});

test("P3. map layers and water appearance survive a round trip with the same basemap identity", () => {
  const c = composition();
  const s = normalizeProfileSettings(JSON.parse(JSON.stringify(captureSettings(c))));
  assert.equal(layersKey(s.mapLayers), layersKey(c.mapLayers), "same layers key, so the cached basemap is reused");
  assert.notEqual(layersKey(s.mapLayers), layersKey(defaultLayers()));
  const custom = captureSettings({ ...c, mapLayers: normalizeLayers({ water: { colorMode: "custom", customColor: "#1F3F5F", brightness: -20 } }) });
  assert.equal(custom.mapLayers.water.customColor, "#1f3f5f");
  assert.equal(custom.mapLayers.water.brightness, -20);
});

test("P4. export quality and aspect ratio come back exactly as saved", () => {
  for (const [format, quality] of [["landscape", "hd"], ["portrait", "draft"], ["square", "hd"]]) {
    const s = captureSettings({ ...composition(), format, quality });
    const r = toReplaySettings(s);
    const { width, height } = normalizeSettings(r);
    assert.deepEqual({ width, height }, outputSize(format, quality));
  }
});

test("P5. invalid and hostile imports are rejected with a clear message and change nothing", () => {
  const bad = (text, pattern) => assert.throws(() => parseProfileText(text), (e) => e instanceof ProfileError && pattern.test(e.message), text.slice(0, 40));
  bad("not json {", /valid JSON/);
  bad("[]", /not a Studio profile/);
  bad("null", /not a Studio profile/);
  bad('"a string"', /not a Studio profile/);
  bad(JSON.stringify({ kind: PROFILE_FILE_KIND }), /schema version/);
  bad(JSON.stringify({ kind: PROFILE_FILE_KIND, schemaVersion: 1, name: "x" }), /no settings/);
  bad(JSON.stringify({ kind: PROFILE_FILE_KIND, schemaVersion: 1, settings: [] }), /no settings/);
  bad(JSON.stringify({ kind: PROFILE_FILE_KIND, schemaVersion: 99, settings: {} }), /newer Studio/);
  bad(JSON.stringify({ kind: "something-else", schemaVersion: 1, settings: {} }), /not a Studio profile/);
  bad(JSON.stringify({ kind: PROFILE_FILE_KIND, schemaVersion: 1, name: "x".repeat(PROFILE_LIMITS.maxBytes), settings: {} }), /too large/);
  bad("é".repeat(PROFILE_LIMITS.maxBytes / 2 + 1), /too large/); // measured in bytes, not characters
  const store = createProfileStore(memoryStorage());
  assert.throws(() => store.importText("{"), ProfileError);
  assert.equal(store.list().length, 0);
});

test("P6. unknown, obsolete and malformed settings are normalized, never trusted", () => {
  const s = normalizeProfileSettings({
    format: "cinemascope", quality: "8k", mapLayers: { water: { colorMode: "neon", brightness: 900, customColor: "red; background:url(x)" }, secretLayer: { visible: true } },
    overlays: { title: "false", clock: "yes", rocket: true }, overlayLayouts: { portrait: { title: { x: 99, y: "NaN", scale: 40, locked: "true" }, hologram: { x: 0.5 } }, widescreen: {} },
    hudShading: 7, grid: { visible: "true", opacity: -1 }, replay: { duration: 99999, trailMinutes: "abc", markerScale: 0, showHistory: "false" },
    frame: { west: 10, south: 0, east: 5, north: 1 }, obsoleteSetting: { anything: 1 },
  });
  assert.equal(s.format, "landscape");
  assert.equal(s.quality, "hd");
  assert.equal(s.mapLayers.water.colorMode, "original");
  assert.equal(s.mapLayers.water.brightness, 50);
  assert.equal(s.mapLayers.water.customColor, defaultLayers().water.customColor);
  assert.equal("secretLayer" in s.mapLayers, false);
  assert.equal(s.overlays.title, false);
  assert.equal(s.overlays.clock, true, "a non-boolean falls back to the overlay's default");
  assert.deepEqual(s.overlayLayouts.portrait.title, { x: 1.25, scale: 1.5, locked: true });
  assert.deepEqual(Object.keys(s.overlayLayouts).sort(), ["landscape", "portrait", "square"]);
  assert.equal(s.hudShading, 1);
  assert.deepEqual(s.grid, { visible: true, opacity: 0 });
  assert.deepEqual(s.replay, { duration: 3600, trailMinutes: 20, markerScale: 0.25, showHistory: false });
  assert.equal("frame" in s, false, "an invalid frame (west > east) is dropped");
  assert.equal("obsoleteSetting" in s, false);
  assert.doesNotThrow(() => normalizeSettings(toReplaySettings(s)), "whatever came in, the result is a valid replay setting");
  assert.deepEqual(normalizeProfileSettings(undefined), normalizeProfileSettings({}));
});

test("P7. names are untrusted text: control characters are stripped, length capped, markup kept inert as plain text", () => {
  assert.equal(cleanName("  Cinematic \n\t Mediterranean‮  "), "Cinematic Mediterranean");
  assert.equal(cleanName("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "kept as text; the UI sets it with textContent only");
  assert.equal(cleanName(""), "Untitled profile");
  assert.equal(cleanName(42), "Untitled profile");
  assert.equal([...cleanName("é".repeat(500))].length, PROFILE_LIMITS.nameLength);
  assert.equal(uniqueName("Look", ["look", "Look (2)"]), "Look (3)");
  assert.match(profileFileName("../../etc/passwd <x>"), /^[\p{L}\p{N}-]+\.studio-profile\.json$/u);
  const p = normalizeProfile({ schemaVersion: 1, id: "../../x", name: "n", settings: {} });
  assert.match(p.id, /^[\w-]+$/, "a malformed id is replaced");
});

test("P8. save, update, rename, duplicate and delete; a name is never silently overwritten", () => {
  let n = 0;
  const store = createProfileStore(memoryStorage(), { now: () => `2026-11-03T10:00:0${n++}.000Z` });
  const a = store.create("Look A", captureSettings(composition()));
  assert.equal(store.activeId(), a.id);
  assert.throws(() => store.create("look a", captureSettings(composition())), /already exists/);
  assert.equal(store.list().length, 1);

  const changed = captureSettings({ ...composition(), format: "square", hudShading: 0 });
  const u = store.update(a.id, changed);
  assert.equal(u.settings.format, "square");
  assert.equal(u.createdAt, a.createdAt);
  assert.notEqual(u.updatedAt, a.updatedAt);

  const copy = store.duplicate(a.id);
  assert.equal(copy.name, "Look A copy");
  assert.notEqual(copy.id, a.id);
  assert.deepEqual(copy.settings, u.settings);
  store.update(copy.id, captureSettings(composition()));
  assert.equal(store.get(a.id).settings.format, "square", "duplicates are independent");

  const b = store.create("Look B", changed);
  assert.throws(() => store.rename(b.id, "LOOK A"), /already exists/);
  assert.equal(store.rename(b.id, "Look B2").name, "Look B2");
  assert.equal(store.rename(b.id, "look b2").name, "look b2", "renaming to a different case of its own name is allowed");

  store.remove(copy.id);
  assert.equal(store.get(copy.id), null);
  assert.throws(() => store.remove(copy.id), ProfileError);
  assert.deepEqual(store.list().map((p) => p.name), ["Look A", "look b2"]);

  const imported = store.importText(serializeProfile(a));
  assert.equal(imported.name, "Look A (2)", "an imported name that is taken gets a suffix");
  assert.notEqual(imported.id, a.id);
});

test("P9. profiles survive a reload; damaged storage is ignored; the list is capped", () => {
  const storage = memoryStorage();
  const first = createProfileStore(storage, { now: fixedNow });
  const a = first.create("Look A", captureSettings(composition()));
  first.create("Look B", captureSettings({ ...composition(), format: "square" }));
  first.setActive(a.id);
  assert.ok(storage.data.has(PROFILE_STORAGE_KEY), "one dedicated, namespaced key");
  assert.equal(storage.data.size, 1);

  const again = createProfileStore(storage);
  assert.deepEqual(again.list().map((p) => p.name), ["Look A", "Look B"]);
  assert.deepEqual(again.get(a.id).settings, a.settings);
  assert.equal(again.activeId(), a.id);

  storage.data.set(PROFILE_STORAGE_KEY, "{broken");
  const damaged = createProfileStore(storage);
  assert.equal(damaged.list().length, 0);
  assert.match(damaged.status().problem, /unreadable/);

  storage.data.set(PROFILE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: [{ nonsense: 1 }, a, a, "text", null] }));
  const partial = createProfileStore(storage);
  assert.equal(partial.list().length, 1, "garbage and duplicate ids are skipped");
  assert.equal(partial.status().skipped, 4);

  const crowded = createProfileStore(memoryStorage());
  for (let i = 0; i < PROFILE_LIMITS.maxProfiles; i++) crowded.create(`P${i}`, {});
  assert.throws(() => crowded.create("one too many", {}), /At most/);
});

test("P10. unavailable or failing browser storage never throws; profiles then live for the session", () => {
  for (const storage of [null, memoryStorage({ failGet: true })]) {
    const store = createProfileStore(storage);
    assert.equal(store.status().persistent, false);
    const p = store.create("Session only", captureSettings(composition()));
    assert.equal(store.get(p.id).name, "Session only");
  }
  const full = createProfileStore(memoryStorage({ failSet: true }));
  assert.doesNotThrow(() => full.create("Quota", {}));
  assert.match(full.status().problem, /rejected/);
  assert.equal(full.list().length, 1);
});

test("P11. a profile never contains dataset content, and the map frame is saved only on request", () => {
  const c = composition();
  const without = captureSettings(c);
  assert.equal("frame" in without, false, "default: reusable visual settings only");
  const withFrame = captureSettings(c, { includeFrame: true });
  assert.deepEqual(withFrame.frame, { west: 28, south: 40, east: 30, north: 42 });
  // Another dataset's framing does not make two profiles different.
  const elsewhere = captureSettings({ ...c, frame: { west: 100, south: -10, east: 102, north: -8 } });
  assert.deepEqual(elsewhere, without);
  assert.ok(sameSettings(withFrame, without), "the frame alone never counts as a change");
  assert.ok(!sameSettings(withFrame, captureSettings({ ...c, frame: { west: 1, south: 1, east: 2, north: 2 } }, { includeFrame: true })));
  // No strikes, CSV or JSON records, images or playback state anywhere in the serialized profile.
  const text = serializeProfile(normalizeProfile({ schemaVersion: 1, name: "x", settings: { ...withFrame, events: [{ id: "a" }], text: "csv", dataset: {}, t: 3, selected: 1, mapImage: "data:image/png", mp4: "x" } }));
  for (const k of ["events", "dataset", "mapImage", "mp4", "selected", '"t"', '"text"']) assert.ok(!text.includes(k), k);
  assert.ok(text.length < 4000, "a profile is a few hundred bytes of settings");
  const withoutFrame = normalizeProfile({ schemaVersion: 1, name: "x", settings: without });
  assert.equal("frame" in withoutFrame.settings, false);
});

test("P12. backward compatibility: a minimal or older stored profile applies with today's defaults", () => {
  const older = ({
    schemaVersion: 1, id: "old-1", name: "From an older Studio", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
    settings: { format: "square", mapLayers: { roadsMajor: { visible: false } }, retiredOption: true }, // no water appearance, no layouts, no replay timing
  });
  // Profiles already in localStorage were saved without a file "kind" marker and must keep loading.
  const storage = memoryStorage();
  storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: [older], activeId: "old-1" }));
  const store = createProfileStore(storage);
  assert.equal(store.status().skipped, 0);
  assert.equal(store.activeId(), "old-1");
  const p = store.get("old-1");
  assert.equal(p.id, "old-1");
  assert.equal(p.settings.format, "square");
  assert.equal(p.settings.quality, "hd");
  assert.equal(p.settings.mapLayers.roadsMajor.visible, false);
  assert.equal(p.settings.mapLayers.water.colorMode, "original");
  assert.deepEqual(p.settings.overlayLayouts, { landscape: {}, portrait: {}, square: {} });
  assert.equal(p.settings.replay.duration, 20);
  assert.equal(p.settings.hudShading, 1);
  assert.equal("retiredOption" in p.settings, false);
  assert.doesNotThrow(() => normalizeSettings(toReplaySettings(p.settings)));
  assert.equal(sameSettings(p.settings, {}), false);
});

test("P13. preview and export read the same settings: the replay and the composition match the saved profile", () => {
  const text = readFileSync(join(ROOT, "data", "sample-istanbul-squall.json"), "utf8");
  const ds = parseDataset(text, "sample-istanbul-squall.json");
  const settings = captureSettings(composition());
  const flat = toReplaySettings(settings);
  // What Studio's readSettings() would produce after applying the profile, written out by hand.
  const manual = {
    duration: 30, trailMinutes: 45, markerScale: 1.5, showHistory: false, overlays: { ...noOverlays(), title: true, clock: true, activity: true },
    overlayLayout: { title: { x: 0.5, y: 0.2, scale: 0.8 }, clock: { x: 0.9, y: 0.3, scale: 1.2, locked: true } },
    hudShading: 0.5, showGrid: true, gridOpacity: 0.3, format: "portrait", quality: "hd",
  };
  assert.deepEqual(flat, manual);
  const { width, height } = outputSize("portrait", "hd");
  const frame = fitFrame(ds.events, width, height);
  const dir = mkdtempSync(join(tmpdir(), "lr-profile-"));
  try {
    const a = buildComposition({ text, filename: "sample-istanbul-squall.json", settings: { ...flat, frame }, outDir: join(dir, "a") });
    const b = buildComposition({ text, filename: "sample-istanbul-squall.json", settings: { ...manual, frame }, outDir: join(dir, "b") });
    assert.deepEqual(a.model.settings, b.model.settings);
    assert.equal(a.model.settings.width, 1080);
    assert.equal(a.model.settings.height, 1920);
    const input = JSON.parse(readFileSync(join(dir, "a", "replay-input.js"), "utf8").replace(/^window\.__REPLAY_INPUT = /, "").replace(/;\s*$/, ""));
    assert.deepEqual(input.settings.overlayLayout, manual.overlayLayout);
    assert.equal(input.settings.hudShading, 0.5);
    assert.equal(input.settings.duration, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(buildReplay(ds, { ...flat, frame }, {}).settings.showGrid);
});

test("P14. importing requires the export's kind marker; stored profiles without it still load", () => {
  const exported = serializeProfile(normalizeProfile({ schemaVersion: 1, name: "Marked", settings: captureSettings(composition()) }));
  assert.equal(parseProfileText(exported).name, "Marked");
  const body = JSON.parse(exported);
  const refuse = (data, label) => assert.throws(() => parseProfileText(JSON.stringify(data)), (e) => e instanceof ProfileError && /kind/.test(e.message), label);
  const { kind, ...unmarked } = body;
  refuse(unmarked, "marker missing");
  refuse({ ...body, kind: "something-else" }, "marker different");
  refuse({ ...body, kind: null }, "marker null");
  refuse({ ...body, kind: ["lightning-replay-studio-profile"] }, "marker not a string");
  assert.throws(() => createProfileStore(memoryStorage()).importText(JSON.stringify(unmarked)), ProfileError);
  // The same record, read from storage rather than a file, is fine: storage is the Studio's own.
  const storage = memoryStorage();
  storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: [unmarked] }));
  assert.equal(createProfileStore(storage).list().length, 1);
});
