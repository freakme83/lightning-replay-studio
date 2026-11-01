// Builds the replay model: the one object both the preview and the exported video draw from.
import { createTimeMap } from "./timeline.js";
import { autoBounds, cameraOf, createProjection, frameProjection, validateBounds } from "./projection.js";
import { parseTimestamp } from "./parse.js";

export const DEFAULTS = Object.freeze({
  duration: 20, // output video seconds
  fps: 24,
  width: 960,
  height: 540,
  trailMinutes: 20, // residual marker lifetime, in dataset minutes
  markerScale: 1, // visual size multiplier for strike markers
  showHistory: true, // keep a faint dot for every earlier strike
  bounds: null, // {west, south, east, north} or null = fit to data (strikes fitted inside the HUD-free map area)
  frame: null, // {west, south, east, north} of the whole video frame (Map Composer); takes precedence over bounds
  timeRange: null, // {start, end} ISO strings / epoch ms, or null = first..last strike
  title: null,
});

/** Area of the frame strikes are fitted into (the HUD bands stay clear). */
export function mapRect(width, height) {
  const k = width / 960;
  return { x: 40 * k, y: 98 * k, w: width - 80 * k, h: height - 98 * k - 104 * k };
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
  s.width = Math.round(num(s.width, "Width", 160, 3840));
  s.height = Math.round(num(s.height, "Height", 90, 2160));
  s.trailMinutes = num(s.trailMinutes, "Trail duration (min)", 0, 1440);
  s.markerScale = num(s.markerScale, "Marker size", 0.25, 4);
  s.showHistory = s.showHistory !== false && s.showHistory !== "false";
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
export function fitFrame(events, width = DEFAULTS.width, height = DEFAULTS.height) {
  const bounds = autoBounds(events);
  if (!bounds) return null;
  return createProjection(bounds, mapRect(width, height)).extentOf({ x: 0, y: 0, w: width, h: height });
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
  const proj = s.frame ? frameProjection(s.frame, s.width, s.height) : createProjection(bounds, mapRect(s.width, s.height));
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
    /** MapLibre camera that renders exactly this frame at settings.width × settings.height. */
    camera: cameraOf(proj, s.width, s.height),
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
