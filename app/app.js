// Lightning Replay Studio — interactive preview.
// Uses the same core modules (parse → buildReplay → drawFrame) as the exported video.
// Map workflow: compose (interactive map + frame guide) → Lock Frame → the server bakes
// one basemap PNG for that exact frame → preview and export both draw that PNG.
import { parseDataset, formatLocal, formatOffset, toIsoWithOffset } from "/src/core/parse.js";
import { buildReplay, DEFAULTS, normalizeSettings, resolveTimeRange } from "/src/core/replay.js";
import { FORMATS, QUALITIES, describeSize, designViewport, outputSize } from "/src/core/format.js";
import { layoutFor } from "/src/core/layout.js";
import { autoBounds, containFrame } from "/src/core/projection.js";
import { drawFrame, overlayGeometry } from "/src/core/draw.js";
import { SHADING_PRESETS, shadingPreset } from "/src/core/hud.js";
import { createLayoutStore, clampBox, moveTo, overrideOf, scaleAbout } from "/src/editor/layout-edit.js";
import { createComposer } from "./composer.js";
import { createLayoutEditor } from "./layout-editor.js";
import { createFollowGate, scrollRowIntoContainer, watchUserScroll } from "./table-follow.js";
import { OVERLAYS, defaultOverlays, noOverlays, normalizeOverlays, attributionLines, zoneVisible } from "/src/core/overlays.js";
import { createProfilesUi } from "./profiles-ui.js";
import { createProfileStore } from "/src/profiles/profile-store.js";
import { captureSettings, normalizeProfileSettings } from "/src/profiles/profile.js";
import { LAYER_GROUPS, WATER_BRIGHTNESS, WATER_PRESETS, defaultLayers, layersKey, normalizeLayers } from "/src/map/layers.js";
import { createSoundTab } from "./sound-tab.js";

const $ = (id) => document.getElementById(id);
const tableWrap = $("ev-body").closest(".table-wrap");
const followGate = createFollowGate();
watchUserScroll(tableWrap, followGate);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

const state = {
  text: null,
  filename: null,
  dataset: null,
  model: null,
  geo: null,
  t: 0,
  playing: false,
  format: "landscape", // video aspect ratio: landscape | portrait | square (src/core/format.js)
  quality: "hd", // output resolution: hd (Full HD) | draft (half size)
  frame: null, // {west, south, east, north} of the whole video frame
  mode: "compose", // "compose" (editing the frame on the map) | "locked"
  mapImage: null, // { image, attribution, id, meta } once the basemap for the locked frame is baked
  mapError: null,
  mapBusy: false, // a basemap bake is in flight
  bakingKey: null, // layer settings + output size of the bake in flight
  mapLayers: defaultLayers(), // geographic layers behind the replay (roads, labels, …)
  grid: { visible: false, opacity: 0.5 }, // lat/lon graticule: drawn by the replay renderer, not part of the map image
  overlays: defaultOverlays(), // informational video overlays (title, clock, counter, …): drawn by the replay renderer
  layouts: createLayoutStore(), // overlay placement per video format (preset + user overrides)
  shading: SHADING_PRESETS.standard, // HUD backing gradient opacity 0…1
  editing: false, // Edit Layout mode
  snapping: true, // smart alignment while dragging overlays
  layerTimer: null,
  cameraZoom: 0, // output-frame zoom while composing
  lockToken: 0, // bumped by every bake and by unlocking; stale bake results are dropped
  composer: null,
  selected: null,
  lastRowNow: -1,
  tab: "video", // "video" (the replay and its export) | "sound" (the music made from the strikes)
};
let profilesUi = null; // Studio Profiles panel (created at the end); told whenever a saved setting may have changed
const settingsChanged = () => profilesUi?.refresh();

// ---------- sound ----------
// The Sound tab plays the strikes as music. While sound is on and playing, the audio clock drives the
// preview (state.t), so the picture shows the video time that is being heard.
const sound = createSoundTab({
  panel: $("sound-panel"),
  viz: $("sound-viz"),
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  onEnabledChange(on) {
    syncSoundToggle();
    if (!state.playing) return;
    if (on) sound.start(state.t);
    else sound.stop();
  },
});
function syncSoundToggle() {
  const on = sound.enabled();
  $("sound-toggle").textContent = on ? "🔊" : "🔇";
  $("sound-toggle").setAttribute("aria-pressed", String(on));
  $("sound-toggle").title = on ? "Sound on: click to mute (set it up in the Sound tab)" : "Sound off: click to play the strikes as music (set it up in the Sound tab)";
  $("tab-sound-dot").hidden = !on;
}
/** Playback needs a locked frame in the Video tab; the Sound tab can also play while the frame is being composed. */
const canPlay = () => !!state.model && (state.mode === "locked" || state.tab === "sound");
function setTab(tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  $("video-panel").hidden = tab !== "video";
  $("sound-panel").hidden = tab !== "sound";
  $("strikes-panel").hidden = tab !== "video";
  $("sound-viz").hidden = tab !== "sound";
  if (state.playing && !canPlay()) pause();
  updateFrameUi();
  draw();
}

// ---------- geography & fonts ----------
async function loadGeo() {
  const [basemap, places] = await Promise.all([
    fetch("/basemap/ne-50m.json").then((r) => r.json()),
    fetch("/basemap/places.json").then((r) => r.json()),
  ]);
  state.geo = { basemap, places: places.places };
}
async function loadFonts() {
  const sample = "AÇĞİÖŞÜ çğıöşü 0123456789:·→";
  await Promise.all(['400 12px "LR Inter"', '600 12px "LR Inter"', '400 12px "LR Mono"', '500 12px "LR Mono"'].map((f) => document.fonts.load(f, sample)));
}

// ---------- settings ----------
function readSettings() {
  const start = $("range-start").value.trim(), end = $("range-end").value.trim();
  return {
    duration: Number($("duration").value),
    trailMinutes: Number($("trail").value),
    markerScale: Number($("scale").value),
    showHistory: $("history").checked,
    overlays: state.overlays,
    overlayLayout: state.layouts.get(state.format),
    hudShading: state.shading,
    showGrid: state.grid.visible,
    gridOpacity: state.grid.opacity,
    frame: state.frame,
    timeRange: start || end ? { start: start || null, end: end || null } : null,
    fps: DEFAULTS.fps,
    format: state.format,
    quality: state.quality,
  };
}

function message(kind, html) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.innerHTML = html;
  $("messages").appendChild(div);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- model ----------
function rebuild({ keepTime = true } = {}) {
  if (!state.dataset?.ok) return;
  const frac = state.model ? state.t / state.model.settings.duration : 0;
  try {
    state.model = buildReplay(state.dataset, readSettings(), { ...state.geo, mapImage: state.mapImage });
  } catch (e) {
    sound.setReplay(null, state.dataset, state.frame);
    $("messages").querySelectorAll(".msg.settings").forEach((n) => n.remove());
    message("error settings", esc(e.message));
    return;
  }
  $("messages").querySelectorAll(".msg.settings").forEach((n) => n.remove());
  const m = state.model;
  // A fresh load opens on the end of the opening fade, just before the first strike can appear.
  const fps = m.settings.fps;
  state.t = keepTime ? Math.min(m.settings.duration, frac * m.settings.duration) : Math.floor(m.timeMap.leadIn * fps) / fps;
  // New strike timing (duration, time range, dataset): a sounding preview continues from the same place.
  if (sound.setReplay(m, state.dataset, state.frame) && state.playing && sound.running) sound.start(state.t);
  $("scrub").max = m.settings.duration;
  $("scale-val").textContent = `${m.settings.markerScale.toFixed(1)}×`;
  showFrameEdges(m.extent);
  state.composer?.setStrikes(m.events);
  if (state.selected) state.selected = m.events.find((e) => e.index === state.selected.index) ?? null;
  renderTable();
  updateInfo();
  draw();
  settingsChanged();
}

function loadText(text, filename) {
  $("messages").innerHTML = "";
  const ds = parseDataset(text, filename);
  if (!ds.ok) {
    message("error", `<strong>Could not load ${esc(filename)}.</strong><br>${ds.errors.slice(0, 6).map(esc).join("<br>")}`);
    return;
  }
  state.text = text;
  state.filename = filename;
  state.dataset = ds;
  state.selected = null;
  $("range-start").value = "";
  $("range-end").value = "";
  state.frame = null; // replaced by Fit to Data below
  if (ds.errors.length)
    message("warn", `${ds.errors.length} of ${ds.totalRecords} record(s) rejected.<details><summary>Show</summary>${ds.errors.map(esc).join("<br>")}</details>`);
  for (const w of ds.warnings) message("warn", esc(w));
  if (ds.meta.description) message("", esc(ds.meta.description));
  $("empty").hidden = true;
  pause();
  // A new dataset opens in the composer, framed on its strikes.
  state.frame = fitToDataFrame();
  rebuild({ keepTime: false });
  enterCompose(state.frame);
}

function updateInfo() {
  const ds = state.dataset, m = state.model;
  if (!ds || !m) return;
  const off = m.displayOffsetMin;
  const a = formatLocal(m.range.start, off), b = formatLocal(m.range.end, off);
  const mins = (m.range.end - m.range.start) / 60000;
  const rows = [
    ["Name", ds.meta.name ?? "—"],
    ["File", state.filename],
    ["Events", `${m.totalEvents} shown · ${ds.events.length} valid · ${ds.totalRecords} records`],
    ["Range", `${a.date} ${a.time} → ${b.date === a.date ? "" : b.date + " "}${b.time}`],
    ["Span", `${mins.toFixed(1)} min → ${m.settings.duration} s (×${Math.round((mins * 60) / m.timeMap.span)})`],
    ["Timezone", formatOffset(off)],
    ["Source", ds.meta.synthetic ? "SYNTHETIC — fictional" : "as provided"],
  ];
  if (m.excluded) rows.splice(3, 0, ["Outside range", `${m.excluded} event(s)`]);
  $("info").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
  const badge = $("dataset-badge");
  badge.hidden = false;
  badge.textContent = ds.meta.synthetic ? "SYNTHETIC DATA · NOT REAL DETECTIONS" : (ds.meta.name ?? state.filename);
  badge.classList.toggle("real", !ds.meta.synthetic);
  $("range-start").placeholder = toIsoWithOffset(resolveTimeRange(ds, null).start, off);
  $("range-end").placeholder = toIsoWithOffset(resolveTimeRange(ds, null).end, off);
}

// ---------- map frame ----------
/** Output pixels of the selected format and quality, and the design viewport the map is composed in. */
const outSize = () => outputSize(state.format, state.quality);
const viewport = () => { const o = outSize(); return designViewport(o.width, o.height); };
const outKey = () => { const o = outSize(); return `${o.width}x${o.height}`; };
/** Identity of the map image a bake produces: layer settings + output size (format and quality). */
const bakeKey = () => `${layersKey(state.mapLayers)}|${outKey()}`;

/** Fit to Data: the v1 auto-fit layout (strikes inside the HUD-free area) as a full frame. */
function fitToDataFrame() {
  return buildReplay(state.dataset, { ...readSettings(), frame: null }).extent;
}

function showFrameEdges(f) {
  if (document.activeElement?.closest?.(".bounds")) return; // don't overwrite while typing
  for (const k of ["north", "west", "east", "south"]) $(`b-${k}`).value = f[k].toFixed(4);
}

function setMapState(html) {
  $("map-state").innerHTML = html;
}

function stageStatus(text, bad = false) {
  const el = $("stage-status");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.classList.toggle("bad", bad);
}

/** Is the prepared map out of date with the layer settings or the output size (or missing)? */
const mapIsStale = () => !state.mapImage || state.mapImage.bakeKey !== bakeKey();

function updateFrameUi() {
  const locked = state.mode === "locked";
  const pill = $("frame-mode");
  const failed = locked && !state.mapImage && state.mapError;
  const layersFailed = locked && state.mapImage && state.mapError;
  const updating = locked && (state.mapBusy || (state.mapImage && mapIsStale() && !state.mapError));
  pill.textContent = !locked ? "editing" : failed ? "map failed" : layersFailed ? "map not updated" : updating ? (state.mapImage ? "updating map…" : "preparing…") : "locked";
  pill.className = `pill ${!locked ? "editing" : failed || layersFailed ? "failed" : "locked"}`;
  $("lock").textContent = locked ? "Unlock / Edit Frame" : "Lock Frame";
  $("lock").classList.toggle("secondary", locked);
  $("frame-guide").hidden = locked;
  const wasHidden = canvas.hidden;
  canvas.hidden = !locked;
  if (locked && wasHidden) sizeCanvas(); // the canvas had no layout size while hidden
  $("frame-help").textContent = locked
    ? "Frame locked: the preview below is exactly what the MP4 will show."
    : `Drag to pan, scroll or +/− to zoom. The bright rectangle is the ${FORMATS[state.format].ratio} video frame; hatched bands sit under the HUD${state.format === "portrait" ? " and the platform's top/bottom interface areas" : ""}.`;
  $("outline-row").hidden = !failed && !layersFailed && !(state.composer && !state.composer.online());
  for (const id of ["play", "prev", "next", "scrub"]) $(id).disabled = !canPlay();
  $("edit-layout").disabled = $("edit-layout-side").disabled = !locked || !state.model;
  $("edit-layout").title = locked ? "Move, resize and lock overlays directly on the preview" : "Lock the frame first: overlays are edited on the locked preview";
  updateExportButton();
  updateLayersState();
}

/** The map an export would use right now, or null when none is ready. */
function exportMap() {
  if (state.mode !== "locked" || state.mapBusy) return null;
  if (state.mapImage && !mapIsStale()) return { basemapId: state.mapImage.id, layers: state.mapLayers };
  return $("use-outline").checked ? { fallback: "outline" } : null;
}

function updateExportButton() {
  const ready = !!exportMap();
  $("export").disabled = !state.dataset || !ready;
  $("export").title = ready ? ""
    : state.mode !== "locked" ? "Lock the frame first"
    : state.mapBusy || (state.mapImage && !state.mapError) ? "Waiting for the map to finish updating"
    : "Map not prepared — tick the offline outline option to export anyway";
}

function enterCompose(frame) {
  pause();
  setEditing(false);
  state.mode = "compose";
  state.lockToken++;
  clearTimeout(state.layerTimer);
  state.mapBusy = false;
  state.mapImage = null;
  state.mapError = null;
  stageStatus(null);
  if (frame) state.composer?.showFrame(frame);
  state.composer?.setInteractive(true);
  setMapState(state.composer?.online() === false ? `<span class="bad">Online map unavailable.</span> Framing uses offline outlines.` : "");
  rebuild();
  updateFrameUi();
}

async function lockFrame() {
  if (!state.dataset) return;
  formatNote("");
  if (state.composer) state.frame = state.composer.frame();
  state.mode = "locked";
  state.mapImage = null;
  state.composer?.setInteractive(false);
  rebuild();
  await bakeMap({ keepImage: false });
}

/**
 * Prepare the basemap PNG for the locked frame with the current layer settings.
 * keepImage: a layer change on an already-locked frame keeps drawing the previous map (and the
 * replay position) until the new one is ready; export stays blocked meanwhile.
 */
async function bakeMap({ keepImage }) {
  clearTimeout(state.layerTimer);
  const token = ++state.lockToken;
  const layers = structuredClone(state.mapLayers);
  const key = bakeKey();
  state.bakingKey = key;
  state.mapBusy = true;
  state.mapError = null;
  if (!keepImage) state.mapImage = null;
  updateFrameUi();
  const o = outSize();
  stageStatus(keepImage ? `Updating the map (${o.width} × ${o.height})…` : `Preparing the map at ${o.width} × ${o.height}…`);
  setMapState(keepImage ? "Updating map…" : `Preparing map at ${o.width} × ${o.height}…`);
  try {
    const res = await fetch("/api/basemap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame: state.frame, format: state.format, quality: state.quality, layers, probes: state.model.events.slice(0, 200).map((e) => [e.lon, e.lat]) }),
    });
    const meta = await res.json();
    if (!res.ok) throw new Error(meta.error ?? `Map preparation failed (${res.status}).`);
    const image = new Image();
    image.src = meta.url;
    await image.decode();
    if (token !== state.lockToken) return; // unlocked, or a newer bake took over
    state.mapImage = { image, attribution: meta.attribution, id: meta.id, meta, bakeKey: key };
    stageStatus(null);
    setMapState(`<span class="ok">Map ready ✓</span> ${esc(meta.provider)} · ${meta.output.join(" × ")} px · zoom ${meta.camera.zoom.toFixed(2)} · alignment ${meta.alignment.maxErrorPx < 0.001 ? "&lt;0.001" : meta.alignment.maxErrorPx.toFixed(3)} px${meta.cached ? " · cached" : ""}`);
  } catch (e) {
    if (token !== state.lockToken) return;
    state.mapError = e.message;
    stageStatus(
      state.mapImage
        ? "Couldn't update the map — still showing the previous map. Export is blocked until it updates."
        : "Map unavailable — previewing offline outlines. Export is blocked until you choose the outline fallback.",
      true,
    );
    setMapState(`<span class="bad">${esc(e.message)}</span>`);
  }
  state.mapBusy = false;
  state.bakingKey = null;
  rebuild();
  updateFrameUi();
}

// ---------- video format ----------
/** Hatched bands of the composer guide: the visible HUD bands, plus the platform safe areas in portrait. */
function updateHud() {
  const o = outSize();
  const L = layoutFor(o.width, o.height);
  const safe = L.kind === "portrait";
  const top = zoneVisible(state.overlays, "top", L) ? L.bands.top : safe ? L.safe.top : 0;
  const bottom = zoneVisible(state.overlays, "bottom", L) ? L.bands.bottom : safe ? L.safe.bottom : 0;
  state.composer?.setHud({ top: top / L.Hu, bottom: bottom / L.Hu, safe });
}

function syncFormatControls() {
  const o = outSize(), f = FORMATS[state.format], q = QUALITIES[state.quality];
  for (const b of $("format-seg").children) b.setAttribute("aria-checked", String(b.dataset.format === state.format));
  for (const b of $("quality-seg").children) b.setAttribute("aria-checked", String(b.dataset.quality === state.quality));
  $("format-pill").textContent = `${o.width} × ${o.height}`;
  $("format-size").textContent = `${o.width} × ${o.height} px · ${f.ratio} · ${DEFAULTS.fps} fps · ${q.id === "hd" ? "Full HD: the map is rendered at this size" : "Draft: half size, fast encode"}`;
  $("export-note").textContent = `${o.width} × ${o.height} · ${DEFAULTS.fps} fps · H.264 yuv420p, ${q.id === "hd" ? "CRF-based" : "fast draft"} encode, rendered locally by HyperFrames with the locked map frame.`;
  $("frame-label").textContent = `VIDEO FRAME · ${o.width}×${o.height} · ${f.ratio}`;
  $("edges-note").textContent = `Edges are widened on one axis to keep the ${f.ratio} video shape.`;
  $("stage-col").dataset.format = state.format;
  $("export").textContent = `Export ${q.id === "hd" ? "Full HD" : "Draft"} MP4`;
  settingsChanged();
}

const formatNote = (html) => { $("format-state").innerHTML = html; };

/**
 * Another aspect ratio. The map centre stays and the old frame is fitted inside the new shape, so
 * nothing that was in view is lost; Fit to Data re-frames the strikes. A prepared basemap belongs to
 * one shape, so a locked frame returns to editing and the map is prepared again on the next lock.
 */
function setFormat(format) {
  if (!FORMATS[format] || format === state.format) return;
  const wasLocked = state.mode === "locked", f = FORMATS[format];
  state.format = format;
  syncFormatControls();
  const vp = viewport(), o = outSize();
  state.composer?.setViewport(vp.width, vp.height);
  updateHud();
  if (!state.dataset) return;
  if (state.frame) state.frame = containFrame(state.frame, o.width, o.height);
  enterCompose(state.frame); // also leaves Edit Layout; this format's own overlay layout applies
  formatNote(wasLocked
    ? `<span class="warn">${f.label} ${f.ratio}: the prepared map no longer fits, so the frame is unlocked.</span> Same centre, the previous view is kept inside the new shape. Lock the frame to prepare the map at ${o.width} × ${o.height}.`
    : `${f.label} ${f.ratio}: same centre, the area you had in view still fits. Fit to Data re-frames the strikes for this shape.`);
}

/** Draft ↔ Full HD: same frame and camera, different pixel density; a locked map is prepared again at the new size. */
function setQuality(quality) {
  if (!QUALITIES[quality] || quality === state.quality) return;
  state.quality = quality;
  syncFormatControls();
  const o = outSize();
  if (!state.dataset) return;
  rebuild();
  if (state.mode === "locked") {
    scheduleRebake();
    formatNote(`${QUALITIES[quality].label}: preparing the map at ${o.width} × ${o.height}. Export unlocks when it is ready.`);
  } else formatNote(`${QUALITIES[quality].label}: the map is prepared at ${o.width} × ${o.height} when you lock the frame.`);
}

$("format-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setFormat(b.dataset.format); });
$("quality-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setQuality(b.dataset.quality); });

// ---------- map layers ----------
function buildLayerControls() {
  $("layers").innerHTML = LAYER_GROUPS.map(
    (g) => `<div class="layer" data-id="${g.id}" title="${esc(g.hint)}">
      <label class="layer-name"><input type="checkbox" data-role="visible" /> ${esc(g.label)}</label>
      <input type="range" min="0" max="100" step="5" data-role="opacity" aria-label="${esc(g.label)} opacity" />
      <span class="pct" data-role="pct"></span>
      ${g.textCase ? `<label class="layer-sub">Letter case
        <select data-role="textCase" title="Original: the map style's capitals. Natural: names as written in the map data (İstanbul, Şanlıurfa).">
          <option value="original">Original map style</option><option value="natural">Natural case</option></select></label>` : ""}
      ${g.appearance ? `<div class="layer-sub water-sub"><span>Color</span>
        <select data-role="waterMode" title="Original keeps the map provider's colours; the presets and Custom replace the colour of every water layer (sea, lakes, rivers).">
          ${Object.entries(WATER_PRESETS).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join("")}</select>
        <input type="color" data-role="waterCustom" title="Custom water colour" aria-label="Custom water colour" /></div>
        <div class="layer-sub water-sub"><span>Brightness</span>
        <input type="range" min="${WATER_BRIGHTNESS.min}" max="${WATER_BRIGHTNESS.max}" step="${WATER_BRIGHTNESS.step}" data-role="waterBright" aria-label="Water brightness" title="Lighter or darker water; independent of opacity" />
        <span class="pct" data-role="waterBrightPct"></span>
        <button type="button" class="linkbtn" data-role="waterReset" title="Back to the provider's original water colours, full opacity">Reset</button></div>` : ""}
    </div>`,
  ).join("");
}

function syncLayerControls() {
  for (const row of $("layers").children) {
    const id = row.dataset.id, v = state.mapLayers[id];
    const missing = state.composer && state.composer.layerGroups[id] === 0;
    row.querySelector('[data-role="visible"]').checked = v.visible;
    row.querySelector('[data-role="opacity"]').value = Math.round(v.opacity * 100);
    const tc = row.querySelector('[data-role="textCase"]');
    if (tc) tc.value = v.textCase;
    if (v.colorMode !== undefined) {
      row.querySelector('[data-role="waterMode"]').value = v.colorMode;
      const custom = row.querySelector('[data-role="waterCustom"]');
      custom.value = v.customColor;
      custom.hidden = v.colorMode !== "custom";
      row.querySelector('[data-role="waterBright"]').value = v.brightness;
      row.querySelector('[data-role="waterBrightPct"]').textContent = `${v.brightness > 0 ? "+" : ""}${v.brightness}%`;
      row.querySelector('[data-role="waterReset"]').hidden = v.colorMode === "original" && v.brightness === 0 && v.visible && v.opacity === 1;
    }
    row.querySelector('[data-role="pct"]').textContent = `${Math.round(v.opacity * 100)}%`;
    row.classList.toggle("off", !v.visible);
    row.classList.toggle("missing", !!missing);
    row.title = missing ? "Not available in the current map style" : LAYER_GROUPS.find((g) => g.id === id).hint;
    for (const input of row.querySelectorAll("input, select")) input.disabled = !!missing;
  }
}

function setLayers(next) {
  state.mapLayers = normalizeLayers(next);
  syncLayerControls();
  state.composer?.setLayers(state.mapLayers); // live in the interactive map
  scheduleRebake();
  settingsChanged();
}

/** After a layer or output-size change on a locked frame: re-bake only the map, once the controls settle. */
function scheduleRebake() {
  clearTimeout(state.layerTimer);
  updateFrameUi(); // marks the prepared map stale, which blocks export straight away
  if (state.mode !== "locked") return;
  state.layerTimer = setTimeout(() => {
    const key = bakeKey();
    if (state.mapBusy ? state.bakingKey === key : state.mapImage?.bakeKey === key) return; // nothing changed
    bakeMap({ keepImage: !!state.mapImage });
  }, 450);
}

/** Output-frame zoom of the current framing (the locked frame, or the composer's camera). */
const currentZoom = () => (state.mode === "locked" ? state.model?.camera?.zoom : state.cameraZoom);

function updateLayersState() {
  const zoom = currentZoom();
  const low = LAYER_GROUPS.filter((g) => g.minZoom && state.mapLayers[g.id].visible && state.mapLayers[g.id].opacity > 0 && state.composer?.layerGroups[g.id] !== 0 && zoom > 0 && zoom < g.minZoom);
  $("layers-hint").textContent = low.length ? `${low.map((g) => g.label).join(", ")}: map data only exists from zoom ${Math.max(...low.map((g) => g.minZoom))} (street level); this frame is zoom ${zoom.toFixed(1)}, so nothing shows.` : "";
  const el = $("layers-state");
  if (state.composer && !state.composer.online()) {
    el.innerHTML = `<span class="bad">Offline outline map — layer controls need the online map.</span>`;
  } else if (state.mode !== "locked") {
    el.textContent = "Changes show live. They are baked into the video when you lock the frame.";
  } else if (state.mapBusy || (state.mapImage && mapIsStale() && !state.mapError)) {
    el.textContent = "Updating map…";
  } else if (state.mapError) {
    el.innerHTML = `<span class="bad">${esc(state.mapError)}</span> <button class="linkbtn" data-retry>Retry</button>`;
  } else if (state.mapImage) {
    el.innerHTML = `<span class="ok">Applied ✓</span> baked into this frame${state.mapImage.meta.cached ? " (cached)" : ""}`;
  }
}

$("layers").addEventListener("input", (e) => {
  const row = e.target.closest(".layer");
  if (!row) return;
  const id = row.dataset.id, cur = state.mapLayers[id];
  if (e.target.dataset.role === "visible") setLayers({ ...state.mapLayers, [id]: { ...cur, visible: e.target.checked } });
  else if (e.target.dataset.role === "textCase") setLayers({ ...state.mapLayers, [id]: { ...cur, textCase: e.target.value } });
  else if (e.target.dataset.role === "waterMode") setLayers({ ...state.mapLayers, [id]: { ...cur, colorMode: e.target.value } });
  else if (e.target.dataset.role === "waterCustom") setLayers({ ...state.mapLayers, [id]: { ...cur, colorMode: "custom", customColor: e.target.value } });
  else if (e.target.dataset.role === "waterBright") setLayers({ ...state.mapLayers, [id]: { ...cur, brightness: Number(e.target.value) } });
  else if (e.target.dataset.role === "opacity") setLayers({ ...state.mapLayers, [id]: { ...cur, visible: Number(e.target.value) > 0 ? true : cur.visible, opacity: Number(e.target.value) / 100 } });
});
// ---------- video overlays ----------
function buildOverlayControls() {
  $("overlays").innerHTML = OVERLAYS.map(
    (o) => `<label class="check" title="${esc(o.hint)}"><input type="checkbox" data-id="${o.id}" /> ${esc(o.label)}</label>`,
  ).join("");
}
function syncOverlayControls() {
  for (const input of $("overlays").querySelectorAll("input")) input.checked = state.overlays[input.dataset.id];
  $("attribution-note").hidden = state.overlays.attribution;
}
/** Overlays only change what the replay canvas draws: no rebuild, no map re-bake, the timeline stays put. */
function setOverlays(next) {
  state.overlays = normalizeOverlays(next);
  syncOverlayControls();
  updateHud();
  if (state.model) {
    state.model.settings.overlays = state.overlays;
    if (state.editing) buildInspectorList();
    draw();
  }
  settingsChanged();
}
// ---------- overlay layout & shading ----------
/** Layout and shading only change what the replay canvas draws: no rebuild, no map re-bake, the timeline stays put. */
function applyLayout() {
  if (!state.model) return;
  state.model.settings.overlayLayout = state.layouts.get(state.format);
  state.model.settings.hudShading = state.shading;
  draw();
  settingsChanged();
}

function setShading(v) {
  state.shading = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
  syncShadingControls();
  applyLayout(); // also reports the change
}
function syncShadingControls() {
  const name = shadingPreset(state.shading);
  for (const b of $("shading-seg").children) b.setAttribute("aria-checked", String(b.dataset.shading === name));
  $("shading").value = Math.round(state.shading * 100);
  $("shading-pct").textContent = name === "custom" ? `${Math.round(state.shading * 100)}%` : name === "off" ? "off" : `${Math.round(state.shading * 100)}%`;
}
$("shading-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setShading(SHADING_PRESETS[b.dataset.shading]); });
$("shading").addEventListener("input", (e) => setShading(Number(e.target.value) / 100));

/** Measured overlay boxes (output px) for the editor, from the very renderer that draws them. */
function editorGeometry() {
  const m = state.model;
  if (!m || state.mode !== "locked") return null;
  return { model: m, boxes: overlayGeometry(ctx, m, state.t), overrides: state.layouts.get(state.format) };
}

const editor = createLayoutEditor({
  layer: $("hud-editor"),
  canvas,
  geometry: editorGeometry,
  isLocked: (id) => state.layouts.isLocked(state.format, id),
  snapping: () => state.snapping,
  onSelect: () => syncInspector(true),
  onChange: (id, override) => {
    if (override !== undefined) state.layouts.replace(state.format, id, override);
    applyLayout();
  },
});

function setEditing(on) {
  on = !!on && state.mode === "locked" && !!state.model;
  if (on === state.editing) return;
  editor.cancelDrag();
  state.editing = on;
  if (on) pause();
  $("hud-editor").hidden = !on;
  $("hud-inspector").hidden = !on;
  $("stage-col").classList.toggle("editing", on);
  $("edit-layout").setAttribute("aria-pressed", String(on));
  $("edit-layout").textContent = on ? "Done" : "Edit layout";
  if (!on) editor.select(null);
  if (on) {
    buildInspectorList();
    $("hud-editor").focus({ preventScroll: true });
  }
  draw();
}

function buildInspectorList() {
  const g = editorGeometry();
  $("insp-overlay").innerHTML = `<option value="">Select an overlay…</option>` + OVERLAYS.map((o) => {
    const avail = g?.boxes[o.id]?.base;
    const tag = !avail ? " (not in this dataset)" : !state.overlays[o.id] ? " (hidden)" : "";
    return `<option value="${o.id}"${avail ? "" : " disabled"}>${esc(o.label)}${tag}</option>`;
  }).join("");
}

/** Inspector fields from the selected overlay's measured box; `force` also rewrites a focused field. */
function syncInspector(force = false) {
  if (!state.editing) return;
  const id = editor.selected();
  const g = editorGeometry()?.boxes[id];
  const box = $("hud-inspector");
  box.classList.toggle("no-sel", !g?.box);
  if ($("insp-overlay").value !== (id ?? "")) $("insp-overlay").value = id ?? "";
  const locked = id ? state.layouts.isLocked(state.format, id) : false;
  $("insp-lock").setAttribute("aria-pressed", String(locked));
  $("insp-lock").textContent = locked ? "Locked" : "Lock position";
  for (const el of ["insp-x", "insp-y", "insp-scale", "insp-reset"]) $(el).disabled = !g?.box || locked;
  $("insp-hint").textContent = !g?.box
    ? "Click an overlay in the frame to select it. Drag to move, drag a corner to resize, arrow keys nudge (Shift = 10×)."
    : locked ? "Locked: it stays where it is. Unlock to move or resize it."
    : !g.visible ? "Hidden in the video. Its position is kept and can be edited here."
    : "Drag to move · corner to resize · arrows nudge · Esc deselects";
  if (!g?.box) return;
  const { width: W, height: H } = state.model.settings;
  const set = (el, v) => { if (force || document.activeElement !== $(el)) $(el).value = v; };
  set("insp-x", (((g.box.x + g.box.w / 2) / W) * 100).toFixed(1));
  set("insp-y", (((g.box.y + g.box.h / 2) / H) * 100).toFixed(1));
  set("insp-scale", Math.round(g.placement.s * 100));
  $("insp-scale-val").textContent = `${Math.round(g.placement.s * 100)}%`;
}

/** Apply an inspector edit to the selected overlay: `fn(placement, base, W, H)` returns the new placement. */
function editSelected(fn) {
  const id = editor.selected();
  const g = editorGeometry()?.boxes[id];
  if (!g?.base || state.layouts.isLocked(state.format, id)) return;
  const { width: W, height: H } = state.model.settings;
  const p = fn(g.placement, g.base, W, H);
  state.layouts.replace(state.format, id, { ...state.layouts.get(state.format)[id], ...overrideOf(p, W, H) });
  applyLayout();
}
const centreTo = (axis, pct) => editSelected((p, base, W, H) => {
  const b = overlayGeometry(ctx, state.model, state.t)[editor.selected()].box;
  const target = { ...b, [axis]: (pct / 100) * (axis === "x" ? W : H) - (axis === "x" ? b.w : b.h) / 2 };
  return moveTo(p, base, clampBox(target, W, H));
});
$("insp-x").addEventListener("change", (e) => Number.isFinite(+e.target.value) && centreTo("x", +e.target.value));
$("insp-y").addEventListener("change", (e) => Number.isFinite(+e.target.value) && centreTo("y", +e.target.value));
// Scale about the overlay's anchor (its natural corner or edge), then kept inside the frame.
$("insp-scale").addEventListener("input", (e) => editSelected((p, base, W, H) => scaleAbout(p, base, Number(e.target.value) / 100, [p.x, p.y], W, H)));
$("insp-overlay").addEventListener("change", (e) => { editor.select(e.target.value || null); syncInspector(true); });
$("insp-lock").addEventListener("click", () => {
  const id = editor.selected();
  if (!id) return;
  state.layouts.set(state.format, id, { locked: !state.layouts.isLocked(state.format, id) }); // unlocking drops the flag
  applyLayout();
  syncInspector(true);
});
$("insp-reset").addEventListener("click", () => {
  const id = editor.selected();
  if (!id) return;
  state.layouts.reset(state.format, id);
  applyLayout();
  syncInspector(true);
});
$("layout-reset").addEventListener("click", () => {
  state.layouts.resetAll(state.format);
  applyLayout();
  syncInspector(true);
});
$("snap-toggle").addEventListener("change", (e) => { state.snapping = e.target.checked; });
$("edit-done").addEventListener("click", () => setEditing(false));
$("edit-layout").addEventListener("click", () => setEditing(!state.editing));
$("edit-layout-side").addEventListener("click", () => {
  setEditing(true);
  $("hud-inspector").scrollIntoView({ block: "nearest", behavior: "smooth" });
});

$("overlays").addEventListener("input", (e) => {
  const id = e.target.dataset.id;
  if (id) setOverlays({ ...state.overlays, [id]: e.target.checked });
});
$("overlays-hide").addEventListener("click", () => setOverlays(noOverlays()));
$("overlays-reset").addEventListener("click", () => setOverlays(defaultOverlays()));
$("copy-attribution").addEventListener("click", async () => {
  const cfg = await fetch("/api/map-config").then((r) => r.json()).catch(() => ({}));
  const text = attributionLines({
    // The prepared map's own credit; before locking, the provider's, if the online map is in use.
    mapAttribution: state.mapImage?.attribution ?? (state.composer?.online() ? cfg.attribution : null),
    outline: !state.mapImage && $("use-outline").checked,
    meta: state.dataset?.meta ?? {},
  }).join("\n");
  const btn = $("copy-attribution");
  const label = (t) => { btn.textContent = t; setTimeout(() => (btn.textContent = "Copy attribution"), 1800); };
  if (!text) return label("Nothing to copy yet");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  label("Copied ✓");
});

// Water Reset: the provider's original appearance (colour preset, brightness, visibility and opacity).
$("layers").addEventListener("click", (e) => {
  if (e.target.dataset.role === "waterReset") setLayers({ ...state.mapLayers, water: { ...defaultLayers().water } });
});
$("layers-reset").addEventListener("click", () => {
  state.grid = { visible: false, opacity: 0.5 };
  syncGridControls();
  setLayers(defaultLayers());
  rebuild();
});
/** The graticule is drawn on the replay canvas (same renderer as the MP4): no map re-bake needed. */
function syncGridControls() {
  $("grid-visible").checked = state.grid.visible;
  $("grid-opacity").value = Math.round(state.grid.opacity * 100);
  $("grid-pct").textContent = `${Math.round(state.grid.opacity * 100)}%`;
  $("grid-row").classList.toggle("off", !state.grid.visible);
}
$("grid-row").addEventListener("input", (e) => {
  if (e.target.id === "grid-visible") state.grid.visible = e.target.checked;
  else if (e.target.id === "grid-opacity") {
    state.grid.opacity = Number(e.target.value) / 100;
    if (state.grid.opacity > 0) state.grid.visible = true;
  }
  syncGridControls();
  rebuild();
});
$("layers-state").addEventListener("click", (e) => {
  if (e.target.matches("[data-retry]")) bakeMap({ keepImage: !!state.mapImage });
});

// ---------- drawing ----------
function sizeCanvas() {
  const m = state.model;
  const w = m?.settings.width ?? 960, h = m?.settings.height ?? 540;
  const rect = canvas.getBoundingClientRect();
  // The preview draws at screen size, not export size: the frame is drawn in output px and scaled down.
  const dpr = Math.max(0.25, Math.min(3, (rect.width * devicePixelRatio) / w));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  draw();
}

function draw() {
  const m = state.model;
  if (!m) return;
  const dpr = canvas.width / m.settings.width;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFrame(ctx, m, state.t, { highlight: state.playing || state.editing ? null : state.selected });
  if (state.editing) { editor.refresh(); syncInspector(); }
  const fps = m.settings.fps;
  const now = formatLocal(m.timeMap.toData(state.t), m.displayOffsetMin);
  $("readout").textContent = `${state.t.toFixed(2)} / ${m.settings.duration} s · f${Math.round(state.t * fps)} · ${now.time} ${now.zone}`;
  $("scrub").value = state.t;
  markRows();
  sound.draw(state.t);
}

// ---------- event table ----------
function renderTable() {
  const m = state.model;
  const q = $("ev-filter").value.trim().toLowerCase();
  const off = m.displayOffsetMin;
  const rows = [];
  m.events.forEach((e, i) => {
    const time = formatLocal(e.t, off).time;
    if (q && !`${e.id} ${time} ${e.type}`.toLowerCase().includes(q)) return;
    rows.push(
      `<tr data-i="${i}"><td>${i + 1}</td><td>${esc(e.id)}</td><td>${time}</td><td class="t-${e.type}">${e.type}</td><td>${e.intensity ?? "—"}</td><td>${e.lat.toFixed(4)}</td><td>${e.lon.toFixed(4)}</td><td>${e.v.toFixed(3)} s</td></tr>`,
    );
  });
  $("ev-body").innerHTML = rows.join("");
  $("ev-count").textContent = `${m.totalEvents}`;
  state.lastRowNow = -1;
  markRows();
}

function markRows() {
  const m = state.model;
  const count = m.countAt(state.t);
  for (const tr of $("ev-body").children) {
    const i = Number(tr.dataset.i);
    tr.className = i < count ? (state.t - m.events[i].v < 0.7 ? "now" : "past") : "future";
    if (state.selected && m.events[i].index === state.selected.index) tr.classList.add("selected");
  }
  // Keep the most recent strike in view while playing: inside the table only (never the page), and
  // not while the user is scrolling the table themselves.
  if (state.playing && count !== state.lastRowNow && count > 0) {
    state.lastRowNow = count;
    if (followGate.active()) scrollRowIntoContainer(tableWrap, $("ev-body").querySelector(`tr[data-i="${count - 1}"]`));
  }
}

/** Jump to the first frame on which event i is visible (its initial flash). */
function seekToEvent(i) {
  const m = state.model;
  const e = m.events[i];
  if (!e) return;
  pause();
  state.selected = e;
  const fps = m.settings.fps;
  state.t = m.timeMap.frameOf(e.v, fps) / fps;
  draw();
  scrollRowIntoContainer(tableWrap, $("ev-body").querySelector(`tr[data-i="${i}"]`));
}

function stepEvent(dir) {
  const m = state.model;
  if (!m) return;
  const eps = 1e-6;
  let i;
  if (dir > 0) i = m.events.findIndex((e) => e.v > state.t + eps);
  else {
    const before = m.events.filter((e) => e.v < state.t - 1 / m.settings.fps + eps);
    i = before.length - 1;
  }
  if (i >= 0) seekToEvent(i);
}

// ---------- playback ----------
let lastTs = null;
function tick(ts) {
  if (!state.playing) return;
  const m = state.model;
  // With sound, the audio clock is the master: the picture shows the moment being heard.
  if (sound.running) state.t = sound.position();
  else if (lastTs !== null) state.t += (ts - lastTs) / 1000;
  lastTs = ts;
  if (state.t >= m.settings.duration) {
    state.t = m.settings.duration;
    pause({ ringOut: true }); // the last notes fade naturally
  }
  draw();
  if (state.playing) requestAnimationFrame(tick);
}
function play() {
  if (!canPlay()) return;
  if (state.t >= state.model.settings.duration - 1e-3) state.t = 0;
  state.playing = true;
  state.selected = null;
  lastTs = null;
  $("play").textContent = "❚❚";
  sound.start(state.t);
  requestAnimationFrame(tick);
}
function pause({ ringOut = false } = {}) {
  sound.stop({ ringOut });
  state.playing = false;
  $("play").textContent = "▶";
  // Snap to the export frame grid so a paused preview shows exactly an exported frame.
  if (state.model) {
    const fps = state.model.settings.fps;
    state.t = Math.round(state.t * fps) / fps;
    draw();
  }
}

// ---------- export ----------
async function startExport() {
  if (!state.dataset) return;
  const box = $("export-status");
  $("export").disabled = true;
  box.innerHTML = "Preparing composition…";
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: state.text,
      filename: state.filename,
      settings: readSettings(),
      map: exportMap(),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    box.innerHTML = `<span class="bad">${esc(body.error)}</span>`;
    updateExportButton();
    return;
  }
  poll(body.id);
}
async function poll(id) {
  const box = $("export-status");
  const job = await fetch(`/api/export/${id}`).then((r) => r.json());
  const pct = [...job.log.matchAll(/(\d{1,3})%/g)].pop()?.[1];
  if (job.status === "rendering" || job.status === "building") {
    box.innerHTML = `Rendering with HyperFrames… ${pct ? pct + "% · " : ""}${job.elapsed.toFixed(0)} s<pre>${esc(job.log.split("\n").slice(-6).join("\n"))}</pre>`;
    setTimeout(() => poll(id), 1000);
    return;
  }
  updateExportButton();
  if (job.status === "failed") {
    box.innerHTML = `<span class="bad">Export failed.</span><pre>${esc(job.error)}</pre>`;
    return;
  }
  const p = job.probe;
  const verdict = job.problems.length ? `<span class="bad">Check failed: ${esc(job.problems.join("; "))}</span>` : `<span class="ok">Verified with ffprobe ✓</span>`;
  box.innerHTML = `${verdict}<br><span class="note">${p.codec} ${p.width}×${p.height} · ${p.fps} fps · ${p.duration.toFixed(2)} s · ${p.frames} frames · ${(p.bytes / 1e6).toFixed(1)} MB · ${job.elapsed.toFixed(0)} s</span><br><a href="${job.output}" download>Download ${esc(job.output.split("/").pop())}</a><video src="${job.output}" controls muted></video>`;
}

// ---------- wiring ----------
async function loadSampleList() {
  const { files } = await fetch("/api/samples").then((r) => r.json());
  $("sample").innerHTML = files.map((f) => `<option>${esc(f)}</option>`).join("");
  const def = files.find((f) => f === "sample-ankara-storm.json");
  if (def) $("sample").value = def;
}
async function loadSample() {
  const f = $("sample").value;
  if (!f) return;
  loadText(await fetch(`/data/${encodeURIComponent(f)}`).then((r) => r.text()), f);
}
async function loadFile(file) {
  if (file) loadText(await file.text(), file.name);
}

$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); loadFile(e.dataTransfer.files[0]); });
$("load-sample").addEventListener("click", loadSample);
for (const id of ["duration", "trail", "range-start", "range-end"]) $(id).addEventListener("change", () => rebuild());
$("scale").addEventListener("input", () => rebuild());
$("history").addEventListener("change", () => rebuild());
$("fit").addEventListener("click", () => {
  if (!state.dataset) return;
  formatNote("");
  state.frame = fitToDataFrame();
  enterCompose(state.frame);
});
$("lock").addEventListener("click", () => (state.mode === "locked" ? enterCompose(state.frame) : lockFrame()));
$("use-outline").addEventListener("change", updateExportButton);
$("apply-bounds").addEventListener("click", () => {
  const b = { west: +$("b-west").value, south: +$("b-south").value, east: +$("b-east").value, north: +$("b-north").value };
  try {
    // Widen to the video's aspect ratio; validates the numbers too.
    const { width: W, height: H } = viewport();
    state.frame = containFrame(normalizeSettings({ frame: b }).frame, W, H);
  } catch (e) {
    setMapState(`<span class="bad">${esc(e.message)}</span>`);
    return;
  }
  enterCompose(state.frame);
});
$("play").addEventListener("click", () => (state.playing ? pause() : play()));
$("sound-toggle").addEventListener("click", () => sound.setEnabled(!sound.enabled()));
for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => setTab(b.dataset.tab));
syncSoundToggle();
$("prev").addEventListener("click", () => stepEvent(-1));
$("next").addEventListener("click", () => stepEvent(1));
$("scrub").addEventListener("input", (e) => {
  if (!state.model) return;
  state.playing = false;
  sound.stop();
  $("play").textContent = "▶";
  const fps = state.model.settings.fps;
  state.t = Math.round(Number(e.target.value) * fps) / fps;
  draw();
});
$("ev-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) seekToEvent(Number(tr.dataset.i));
});
$("ev-filter").addEventListener("input", () => state.model && renderTable());
$("export").addEventListener("click", startExport);
document.addEventListener("keydown", (e) => {
  if (!state.model || e.target.matches?.("input, select, textarea")) return;
  if (state.editing && editor.keydown(e)) return; // arrows nudge the selected overlay, Esc cancels / deselects
  const fps = state.model.settings.fps;
  if (e.code === "Space") { e.preventDefault(); state.playing ? pause() : play(); }
  else if (e.key === "ArrowRight") { pause(); state.t = Math.min(state.model.settings.duration, state.t + 1 / fps); draw(); }
  else if (e.key === "ArrowLeft") { pause(); state.t = Math.max(0, state.t - 1 / fps); draw(); }
  else if (e.key === "]") stepEvent(1);
  else if (e.key === "[") stepEvent(-1);
});
new ResizeObserver(() => sizeCanvas()).observe($("stage"));

await Promise.all([loadGeo(), loadFonts(), loadSampleList()]);
// The map attaches when its style is in; the studio never waits on map tiles.
setMapState("Loading map…");
createComposer({
  container: $("map"),
  guide: $("frame-guide"),
  width: viewport().width,
  height: viewport().height,
  basemap: state.geo.basemap,
  layers: state.mapLayers,
  onChange: (frame, camera) => {
    if (state.mode !== "compose") return;
    state.frame = frame;
    sound.setFrame(frame);
    state.cameraZoom = camera.zoom;
    updateLayersState();
    showFrameEdges(frame);
  },
  onStatus: ({ message }) => setMapState(`<span class="bad">${esc(message)}</span>`),
})
  .then((composer) => {
    state.composer = composer;
    if (!composer.online()) setMapState(`<span class="bad">Online map unavailable.</span> Framing uses offline outlines.`);
    else if (state.mode === "compose") setMapState("");
    composer.setViewport(viewport().width, viewport().height);
    updateHud();
    if (state.frame) composer.showFrame(state.frame);
    if (state.model) composer.setStrikes(state.model.events);
    composer.setInteractive(state.mode === "compose");
    state.cameraZoom = composer.camera().zoom;
    syncLayerControls();
    updateFrameUi();
  })
  .catch((e) => {
    // No interactive map (e.g. WebGL unavailable): frames come from Fit to Data / exact edges.
    setMapState(`<span class="bad">Interactive map unavailable: ${esc(e.message)}</span>`);
  });
syncFormatControls();
buildLayerControls();
syncLayerControls();
syncGridControls();
buildOverlayControls();
syncOverlayControls();
syncShadingControls();
updateLayersState();
await loadSample();
sizeCanvas();
// Exposed for automated checks in the browser.
// ---------- studio profiles ----------
// A profile is the look of a video, never a dataset: applying one changes settings only, keeps the
// loaded data, the replay position and (unless asked) the map frame, and re-prepares the basemap
// only when the layers or the output size really changed (the existing bake key decides).
const profileStore = createProfileStore(
  (() => { try { return window.localStorage; } catch { return null; } })(),
);

/** The current composition as profile settings (the map frame only when `includeFrame`). */
function captureProfile({ includeFrame = false } = {}) {
  return captureSettings(
    {
      format: state.format,
      quality: state.quality,
      mapLayers: state.mapLayers,
      overlays: state.overlays,
      overlayLayouts: state.layouts.toJSON(),
      hudShading: state.shading,
      grid: state.grid,
      replay: { duration: $("duration").value, trailMinutes: $("trail").value, markerScale: $("scale").value, showHistory: $("history").checked },
      frame: state.dataset ? state.frame : null,
    },
    { includeFrame },
  );
}

/**
 * Apply a profile in one coordinated step. The settings are validated first; after that everything
 * is committed synchronously (no awaits), so nothing can observe a half-applied profile. Returns a
 * sentence for the user about what happened to the map.
 */
function applyProfile(profile, { restoreFrame = false } = {}) {
  const s = normalizeProfileSettings(profile.settings);
  const before = captureProfile();
  const wasFormat = state.format, wasLocked = state.mode === "locked";
  setEditing(false); // Edit Layout shows the layout being replaced

  state.mapLayers = s.mapLayers;
  state.overlays = s.overlays;
  state.layouts = createLayoutStore(s.overlayLayouts);
  state.shading = s.hudShading;
  state.grid = { ...s.grid };
  $("duration").value = s.replay.duration;
  $("trail").value = s.replay.trailMinutes;
  $("scale").value = s.replay.markerScale;
  $("history").checked = s.replay.showHistory;
  state.format = s.format;
  state.quality = s.quality;

  syncLayerControls();
  syncOverlayControls();
  syncShadingControls();
  syncGridControls();
  syncFormatControls();
  const vp = viewport(), o = outSize();
  state.composer?.setViewport(vp.width, vp.height);
  state.composer?.setLayers(state.mapLayers);
  updateHud();
  formatNote("");

  if (!state.dataset) return "It will be used once a dataset is loaded.";
  const formatChanged = s.format !== wasFormat;
  let frameNote = "Map frame kept.";
  if (restoreFrame && s.frame) {
    state.frame = s.frame;
    frameNote = "Saved map frame restored.";
  } else if (formatChanged && state.frame) {
    state.frame = containFrame(state.frame, o.width, o.height);
    frameNote = `Map frame kept, adapted to ${FORMATS[s.format].ratio}.`;
  }
  const frameMoved = restoreFrame && !!s.frame || formatChanged;
  if (frameMoved) {
    // A prepared map belongs to one frame and one shape: back to editing, locked again by the user.
    enterCompose(state.frame);
    return wasLocked ? `${frameNote} The frame is unlocked: lock it to prepare the map at ${o.width} × ${o.height}.` : frameNote;
  }
  const replayChanged = JSON.stringify([before.replay, before.grid]) !== JSON.stringify([s.replay, s.grid]) || before.quality !== s.quality;
  if (replayChanged) rebuild();
  else {
    state.model.settings.overlays = state.overlays;
    applyLayout();
  }
  if (state.mode === "locked") {
    const key = bakeKey();
    scheduleRebake(); // a no-op when the layers and size are the same as the prepared (or preparing) map
    return state.mapImage?.bakeKey === key || (state.mapBusy && state.bakingKey === key) ? `${frameNote} Map unchanged.` : `${frameNote} Updating the map…`;
  }
  return frameNote;
}

profilesUi = createProfilesUi({ $, store: profileStore, capture: captureProfile, apply: applyProfile });

window.__studio = { sound, setTab, profileStore, captureProfile, applyProfile, state, seekToEvent, autoBounds, lockFrame, enterCompose, fitToDataFrame, setLayers, bakeMap, setFormat, setQuality, setOverlays, setShading, setEditing, editor, editorGeometry };
