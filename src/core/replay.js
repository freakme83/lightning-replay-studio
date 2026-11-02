// Builds the replay model: the one object both the preview and the exported video draw from.
import { createTimeMap } from "./timeline.js";
import { autoBounds, createProjection, frameProjection, validateBounds } from "./projection.js";
import { parseTimestamp } from "./parse.js";
import { defaultOverlays, normalizeOverlays, zoneVisible } from "./overlays.js";
import { DEFAULT_FORMAT, DEFAULT_QUALITY, FORMATS, QUALITIES, outputSize, presetOfSize } from "./format.js";
import { designCamera, layoutFor } from "./layout.js";
import { DEFAULT_SHADING, normalizeLayout } from "./hud.js";

export const DEFAULTS = Object.freeze({
  duration: 20, // output video seconds
  fps: 24,
  format: DEFAULT_FORMAT, // landscape | portrait | square (src/core/format.js)
  quality: DEFAULT_QUALITY, // hd = Full HD | draft = half resolution
  width: null, // output px; derived from format + quality unless a size is given explicitly (CLI --width/--height)
  height: null,
  trailMinutes: 20, // residual marker lifetime, in dataset minutes
  markerScale: 1, // visual size multiplier for strike markers
  showHistory: true, // keep a faint dot for every earlier strike
  overlays: defaultOverlays(), // informational video overlays (src/core/overlays.js); all on = the classic look
  overlayLayout: {}, // user placement of the overlays for this format (src/core/hud.js); {} = the format's preset
  hudShading: DEFAULT_SHADING, // opacity of the HUD backing gradients, 0 (off) … 1 (the format's preset look)
  showGrid: false, // latitude / longitude graticule with degree labels
  gridOpacity: 0.5, // 0…1
  bounds: null, // {west, south, east, north} or null = fit to data (strikes fitted inside the HUD-free map area)
  frame: null, // {west, south, east, north} of the whole video frame (Map Composer); takes precedence over bounds
  timeRange: null, // {start, end} ISO strings / epoch ms, or null = first..last strike
  title: null,
});

/**
 * Area of the frame strikes are fitted into: clear of the HUD bands that are visible (and, when a
 * band is hidden, of the platform safe area or a small edge margin). Margins come from the layout.
 */
export function mapRect(width, height, overlays = defaultOverlays()) {
  const L = layoutFor(width, height), k = L.k;
  const top = (zoneVisible(overlays, "top", L) ? L.fit.top : L.fit.edgeTop) * k;
  const bottom = (zoneVisible(overlays, "bottom", L) ? L.fit.bottom : L.fit.edgeBottom) * k;
  const side = L.fit.side * k;
  return { x: side, y: top, w: width - 2 * side, h: height - top - bottom };
}

export function normalizeSettings(settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const num = (v, name, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}.`);
    return n;
  };
  s.duration = num(s.duration, "Video duration (s)", 2, 3600);
  s.fps = num(s.fps, "Frame rate", 1, 120);
  // Size: a format + quality preset, unless a width × height is given explicitly (CLI only).
  const given = (v) => v !== null && v !== undefined && v !== "";
  if (given(settings.width) !== given(settings.height)) throw new Error("Give both width and height, or neither (use format and quality instead).");
  if (given(settings.width)) {
    s.width = Math.round(num(settings.width, "Width", 160, 3840));
    s.height = Math.round(num(settings.height, "Height", 90, 3840));
    Object.assign(s, presetOfSize(s.width, s.height));
  } else {
    if (!FORMATS[s.format]) throw new Error(`Unknown video format "${s.format}". Formats: ${Object.keys(FORMATS).join(", ")}.`);
    if (!QUALITIES[s.quality]) throw new Error(`Unknown video quality "${s.quality}". Qualities: ${Object.keys(QUALITIES).join(", ")}.`);
    Object.assign(s, outputSize(s.format, s.quality));
  }
  s.trailMinutes = num(s.trailMinutes, "Trail duration (min)", 0, 1440);
  s.markerScale = num(s.markerScale, "Marker size", 0.25, 4);
  s.showHistory = s.showHistory !== false && s.showHistory !== "false";
  s.overlays = normalizeOverlays(s.overlays);
  s.overlayLayout = normalizeLayout(s.overlayLayout, s.format);
  s.hudShading = num(s.hudShading, "HUD shading", 0, 1);
  s.showGrid = s.showGrid === true || s.showGrid === "true";
  s.gridOpacity = num(s.gridOpacity, "Grid opacity", 0, 1);
  for (const key of ["bounds", "frame"]) {
    if (!s[key]) continue;
    const b = { west: +s[key].west, south: +s[key].south, east: +s[key].east, north: +s[key].north };
    const err = validateBounds(b);
    if (err) throw new Error(key === "frame" ? `Map frame: ${err}` : err);
    s[key] = b;
  }
  return s;
}

function upperBound(arr, key, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function niceStep(raw, steps) {
  for (const s of steps) if (s >= raw) return s;
  return steps[steps.length - 1];
}

/**
 * Visual weight 0..1 per event. Intensity is used directly only when the dataset says it is
 * already normalised (meta.intensityNormalized, as in the synthetic sample). Otherwise the
 * absolute value is rank-normalised within the dataset, so units (kA, arbitrary) never matter.
 */
function visualWeights(events, meta) {
  const has = events.filter((e) => e.intensity !== null);
  if (!has.length) return events.map(() => 0.5);
  if (meta?.intensityNormalized) return events.map((e) => (e.intensity === null ? 0.5 : Math.min(1, Math.max(0, e.intensity))));
  const sorted = has.map((e) => Math.abs(e.intensity)).sort((a, b) => a - b);
  const rank = (v) => {
    if (sorted.length === 1) return 0.5;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  };
  return events.map((e) => (e.intensity === null ? 0.5 : rank(Math.abs(e.intensity))));
}

/**
 * Shown time range: explicit settings.timeRange, else the dataset's declared observation
 * window (meta.windowStart / meta.windowEnd, if it contains every strike), else first..last strike.
 */
export function resolveTimeRange(dataset, timeRange) {
  if (!timeRange) {
    const ws = parseTimestamp(dataset.meta?.windowStart), we = parseTimestamp(dataset.meta?.windowEnd);
    if (ws && we && ws.ms <= dataset.timeRange.start && we.ms >= dataset.timeRange.end) return { start: ws.ms, end: we.ms };
    return { ...dataset.timeRange };
  }
  const p = (v, name) => {
    if (v === null || v === undefined || v === "") return null;
    const ts = parseTimestamp(v);
    if (!ts) throw new Error(`Invalid ${name} time: ${v}`);
    return ts.ms;
  };
  const start = p(timeRange.start, "start") ?? dataset.timeRange.start;
  const end = p(timeRange.end, "end") ?? dataset.timeRange.end;
  if (end < start) throw new Error("Time range end precedes its start.");
  return { start, end };
}

/** Keep only basemap rings/lines whose bounding box touches the extent (plus a margin in degrees). */
export function filterBasemap(basemap, extent, pad = 0.5) {
  if (!basemap) return null;
  const touches = (b) => !(b[2] < extent.west - pad || b[0] > extent.east + pad || b[3] < extent.south - pad || b[1] > extent.north + pad);
  return {
    source: basemap.source,
    land: (basemap.land ?? []).filter((f) => touches(f.b)),
    borders: (basemap.borders ?? []).filter((f) => touches(f.b)),
  };
}

/**
 * The video frame that "Fit to Data" selects: the strikes (padded) fitted inside the
 * HUD-free map area, extended to the full width × height canvas.
 */
export function fitFrame(events, width, height, overlays = defaultOverlays()) {
  if (!width || !height) ({ width, height } = outputSize(DEFAULT_FORMAT, DEFAULT_QUALITY));
  const bounds = autoBounds(events);
  if (!bounds) return null;
  return createProjection(bounds, mapRect(width, height, overlays)).extentOf({ x: 0, y: 0, w: width, h: height });
}

/** Project the visible basemap once per model. */
function prepareBasemap(basemap, proj, extent) {
  const b = filterBasemap(basemap, extent);
  if (!b) return null;
  const projectAll = (list) => list.map((f) => f.c.map(([lon, lat]) => proj.project(lon, lat)));
  return { land: projectAll(b.land), borders: projectAll(b.borders), source: b.source };
}

/**
 * @param dataset result of parseDataset()
 * @param settings partial settings (see DEFAULTS)
 * @param assets {basemap?, places?, mapImage?} optional geography for drawing.
 *   mapImage = { image, attribution }: a prepared basemap (CanvasImageSource) that covers the
 *   whole frame exactly. When present it replaces the Natural Earth outlines and place list.
 */
export function buildReplay(dataset, settings = {}, assets = {}) {
  if (!dataset?.ok || !dataset.events.length) throw new Error("No valid events to replay.");
  const s = normalizeSettings(settings);
  const range = resolveTimeRange(dataset, s.timeRange);
  const inRange = dataset.events.filter((e) => e.t >= range.start && e.t <= range.end);
  const excluded = dataset.events.length - inRange.length;
  if (!inRange.length) throw new Error("No events fall inside the selected time range.");

  const timeMap = createTimeMap({ startMs: range.start, endMs: range.end, duration: s.duration });
  // A locked map frame covers the whole canvas; otherwise strikes (or manual bounds) are
  // fitted into the HUD-free area as in v1.
  const bounds = s.frame ?? s.bounds ?? autoBounds(inRange);
  const proj = s.frame ? frameProjection(s.frame, s.width, s.height) : createProjection(bounds, mapRect(s.width, s.height, s.overlays));
  const mapImage = assets.mapImage ?? null;
  const weights = visualWeights(inRange, dataset.meta);

  const events = inRange.map((e, i) => {
    const [x, y] = proj.project(e.lon, e.lat);
    return { ...e, v: timeMap.toVideo(e.t), x, y, w: weights[i] };
  });

  // Strikes per bin over the shown range, for the activity strip.
  const binCount = 72;
  const bins = new Array(binCount).fill(0);
  const dataSpan = range.end - range.start;
  for (const e of events) {
    const b = dataSpan === 0 ? 0 : Math.min(binCount - 1, Math.floor(((e.t - range.start) / dataSpan) * binCount));
    bins[b]++;
  }

  const trailVideo = timeMap.rate > 0 ? s.trailMinutes * 60000 * timeMap.rate : s.trailMinutes > 0 ? s.duration : 0;
  const extent = proj.extentOf({ x: 0, y: 0, w: s.width, h: s.height });
  const visible = (p) => p.lat >= extent.south && p.lat <= extent.north && p.lon >= extent.west && p.lon <= extent.east;
  const latSpan = extent.north - extent.south;
  const places = (mapImage ? [] : assets.places ?? [])
    .filter(visible)
    .filter((p) => (p.rank ?? 1) <= (latSpan < 1.5 ? 3 : latSpan < 6 ? 2 : 1))
    .map((p) => ({ ...p, xy: proj.project(p.lon, p.lat) }));

  return {
    settings: s,
    meta: dataset.meta ?? {},
    displayOffsetMin: dataset.displayOffsetMin ?? 0,
    range,
    excluded,
    totalEvents: events.length,
    timeMap,
    proj,
    bounds,
    autoFitted: !s.bounds && !s.frame,
    extent,
    layout: layoutFor(s.width, s.height),
    /** MapLibre camera (design px, see designCamera) that renders exactly this frame at any quality of this format. */
    camera: designCamera(proj, s.width, s.height),
    mapImage,
    events,
    bins,
    binMs: dataSpan / binCount,
    trailVideo,
    basemap: mapImage ? null : prepareBasemap(assets.basemap, proj, extent),
    places,
    /** Number of strikes visible at video time t (event visible once t >= its video time). */
    countAt: (t) => upperBound(events, "v", t),
    /** Strikes within the last `ms` of dataset time at video time t. */
    recentCount: (t, ms) => {
      const now = timeMap.toData(t);
      const hi = upperBound(events, "v", t);
      let lo = hi;
      while (lo > 0 && events[lo - 1].t > now - ms) lo--;
      return hi - lo;
    },
    niceStep,
  };
}
