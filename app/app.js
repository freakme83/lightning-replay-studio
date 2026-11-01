// Lightning Replay Studio — interactive preview.
// Uses the same core modules (parse → buildReplay → drawFrame) as the exported video.
// Map workflow: compose (interactive map + frame guide) → Lock Frame → the server bakes
// one basemap PNG for that exact frame → preview and export both draw that PNG.
import { parseDataset, formatLocal, formatOffset, toIsoWithOffset } from "/src/core/parse.js";
import { buildReplay, DEFAULTS, normalizeSettings, resolveTimeRange } from "/src/core/replay.js";
import { autoBounds, frameProjection } from "/src/core/projection.js";
import { drawFrame } from "/src/core/draw.js";
import { createComposer } from "./composer.js";
import { LAYER_GROUPS, defaultLayers, layersKey, normalizeLayers } from "/src/map/layers.js";

const $ = (id) => document.getElementById(id);
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
  frame: null, // {west, south, east, north} of the whole video frame
  mode: "compose", // "compose" (editing the frame on the map) | "locked"
  mapImage: null, // { image, attribution, id, meta } once the basemap for the locked frame is baked
  mapError: null,
  mapBusy: false, // a basemap bake is in flight
  bakingKey: null, // layer settings of the bake in flight
  mapLayers: defaultLayers(), // geographic layers behind the replay (roads, labels, …)
  grid: { visible: false, opacity: 0.5 }, // lat/lon graticule: drawn by the replay renderer, not part of the map image
  layerTimer: null,
  cameraZoom: 0, // output-frame zoom while composing
  lockToken: 0, // bumped by every bake and by unlocking; stale bake results are dropped
  composer: null,
  selected: null,
  lastRowNow: -1,
};

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
    showGrid: state.grid.visible,
    gridOpacity: state.grid.opacity,
    frame: state.frame,
    timeRange: start || end ? { start: start || null, end: end || null } : null,
    fps: DEFAULTS.fps,
    width: DEFAULTS.width,
    height: DEFAULTS.height,
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
    $("messages").querySelectorAll(".msg.settings").forEach((n) => n.remove());
    message("error settings", esc(e.message));
    return;
  }
  $("messages").querySelectorAll(".msg.settings").forEach((n) => n.remove());
  const m = state.model;
  // A fresh load opens on the end of the opening fade, just before the first strike can appear.
  const fps = m.settings.fps;
  state.t = keepTime ? Math.min(m.settings.duration, frac * m.settings.duration) : Math.floor(m.timeMap.leadIn * fps) / fps;
  $("scrub").max = m.settings.duration;
  $("scale-val").textContent = `${m.settings.markerScale.toFixed(1)}×`;
  showFrameEdges(m.extent);
  state.composer?.setStrikes(m.events);
  if (state.selected) state.selected = m.events.find((e) => e.index === state.selected.index) ?? null;
  renderTable();
  updateInfo();
  draw();
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
const W = DEFAULTS.width, H = DEFAULTS.height;

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

/** Is the prepared map out of date with the layer settings (or missing)? */
const mapIsStale = () => !state.mapImage || state.mapImage.layersKey !== layersKey(state.mapLayers);

function updateFrameUi() {
  const locked = state.mode === "locked";
  const pill = $("frame-mode");
  const failed = locked && !state.mapImage && state.mapError;
  const layersFailed = locked && state.mapImage && state.mapError;
  const updating = locked && (state.mapBusy || (state.mapImage && mapIsStale() && !state.mapError));
  pill.textContent = !locked ? "editing" : failed ? "map failed" : layersFailed ? "layers not applied" : updating ? (state.mapImage ? "updating layers…" : "preparing…") : "locked";
  pill.className = `pill ${!locked ? "editing" : failed || layersFailed ? "failed" : "locked"}`;
  $("lock").textContent = locked ? "Unlock / Edit Frame" : "Lock Frame";
  $("lock").classList.toggle("secondary", locked);
  $("frame-guide").hidden = locked;
  const wasHidden = canvas.hidden;
  canvas.hidden = !locked;
  if (locked && wasHidden) sizeCanvas(); // the canvas had no layout size while hidden
  $("frame-help").textContent = locked
    ? "Frame locked: the preview below is exactly what the MP4 will show."
    : "Drag to pan, scroll or +/− to zoom. The bright rectangle is the 16:9 video frame; hatched bands sit under the HUD.";
  $("outline-row").hidden = !failed && !layersFailed && !(state.composer && !state.composer.online());
  for (const id of ["play", "prev", "next", "scrub"]) $(id).disabled = !locked;
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
    : state.mapBusy || (state.mapImage && !state.mapError) ? "Waiting for the map layers to finish updating"
    : "Map not prepared — tick the offline outline option to export anyway";
}

function enterCompose(frame) {
  pause();
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
  const key = layersKey(layers);
  state.bakingKey = key;
  state.mapBusy = true;
  state.mapError = null;
  if (!keepImage) state.mapImage = null;
  updateFrameUi();
  stageStatus(keepImage ? "Updating map layers…" : "Preparing map for this frame…");
  setMapState(keepImage ? "Updating map layers…" : "Preparing map…");
  try {
    const res = await fetch("/api/basemap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame: state.frame, width: W, height: H, layers, probes: state.model.events.slice(0, 200).map((e) => [e.lon, e.lat]) }),
    });
    const meta = await res.json();
    if (!res.ok) throw new Error(meta.error ?? `Map preparation failed (${res.status}).`);
    const image = new Image();
    image.src = meta.url;
    await image.decode();
    if (token !== state.lockToken) return; // unlocked, or a newer bake took over
    state.mapImage = { image, attribution: meta.attribution, id: meta.id, meta, layersKey: key };
    stageStatus(null);
    setMapState(`<span class="ok">Map ready ✓</span> ${esc(meta.provider)} · zoom ${meta.camera.zoom.toFixed(2)} · alignment ${meta.alignment.maxErrorPx < 0.001 ? "&lt;0.001" : meta.alignment.maxErrorPx.toFixed(3)} px${meta.cached ? " · cached" : ""}`);
  } catch (e) {
    if (token !== state.lockToken) return;
    state.mapError = e.message;
    stageStatus(
      state.mapImage
        ? "Couldn't update the map layers — still showing the previous map. Export is blocked until it updates."
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
}

/** After a layer change on a locked frame: re-bake only the map, once the controls settle. */
function scheduleRebake() {
  clearTimeout(state.layerTimer);
  updateFrameUi(); // marks the prepared map stale, which blocks export straight away
  if (state.mode !== "locked") return;
  state.layerTimer = setTimeout(() => {
    const key = layersKey(state.mapLayers);
    if (state.mapBusy ? state.bakingKey === key : state.mapImage?.layersKey === key) return; // nothing changed
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
  else if (e.target.dataset.role === "opacity") setLayers({ ...state.mapLayers, [id]: { ...cur, visible: Number(e.target.value) > 0 ? true : cur.visible, opacity: Number(e.target.value) / 100 } });
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
  const dpr = Math.max(1, Math.min(3, (rect.width * devicePixelRatio) / w));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  draw();
}

function draw() {
  const m = state.model;
  if (!m) return;
  const dpr = canvas.width / m.settings.width;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFrame(ctx, m, state.t, { highlight: state.playing ? null : state.selected });
  const fps = m.settings.fps;
  const now = formatLocal(m.timeMap.toData(state.t), m.displayOffsetMin);
  $("readout").textContent = `${state.t.toFixed(2)} / ${m.settings.duration} s · f${Math.round(state.t * fps)} · ${now.time} ${now.zone}`;
  $("scrub").value = state.t;
  markRows();
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
  // Keep the most recent strike in view while playing.
  if (state.playing && count !== state.lastRowNow && count > 0) {
    state.lastRowNow = count;
    $("ev-body").querySelector(`tr[data-i="${count - 1}"]`)?.scrollIntoView({ block: "nearest" });
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
  $("ev-body").querySelector(`tr[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
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
  if (lastTs !== null) state.t += (ts - lastTs) / 1000;
  lastTs = ts;
  if (state.t >= m.settings.duration) {
    state.t = m.settings.duration;
    pause();
  }
  draw();
  if (state.playing) requestAnimationFrame(tick);
}
function play() {
  if (!state.model || state.mode !== "locked") return;
  if (state.t >= state.model.settings.duration - 1e-3) state.t = 0;
  state.playing = true;
  state.selected = null;
  lastTs = null;
  $("play").textContent = "❚❚";
  requestAnimationFrame(tick);
}
function pause() {
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
      quality: $("quality").value,
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
  state.frame = fitToDataFrame();
  enterCompose(state.frame);
});
$("lock").addEventListener("click", () => (state.mode === "locked" ? enterCompose(state.frame) : lockFrame()));
$("use-outline").addEventListener("change", updateExportButton);
$("apply-bounds").addEventListener("click", () => {
  const b = { west: +$("b-west").value, south: +$("b-south").value, east: +$("b-east").value, north: +$("b-north").value };
  try {
    // Widen to the video's aspect ratio; validates the numbers too.
    state.frame = frameProjection(normalizeSettings({ frame: b }).frame, W, H).extentOf({ x: 0, y: 0, w: W, h: H });
  } catch (e) {
    setMapState(`<span class="bad">${esc(e.message)}</span>`);
    return;
  }
  enterCompose(state.frame);
});
$("play").addEventListener("click", () => (state.playing ? pause() : play()));
$("prev").addEventListener("click", () => stepEvent(-1));
$("next").addEventListener("click", () => stepEvent(1));
$("scrub").addEventListener("input", (e) => {
  if (!state.model) return;
  state.playing = false;
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
  if (!state.model || e.target.matches("input, select, textarea")) return;
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
  width: W,
  height: H,
  basemap: state.geo.basemap,
  layers: state.mapLayers,
  onChange: (frame, camera) => {
    if (state.mode !== "compose") return;
    state.frame = frame;
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
buildLayerControls();
syncLayerControls();
syncGridControls();
updateLayersState();
await loadSample();
sizeCanvas();
// Exposed for automated checks in the browser.
window.__studio = { state, seekToEvent, autoBounds, lockFrame, enterCompose, fitToDataFrame, setLayers, bakeMap };
