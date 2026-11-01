// Draws one frame of the replay at video time t onto a 2D canvas context.
// Pure function of (model, t): no state carries between frames, so any frame can be
// rendered on its own (HyperFrames seeks frame by frame; the preview scrubs freely).
import { formatLocal } from "./parse.js";
import { zoneVisible } from "./overlays.js";

export const FONT_SANS = '"LR Inter", Inter, system-ui, sans-serif';
export const FONT_MONO = '"LR Mono", "JetBrains Mono", ui-monospace, Menlo, monospace';

export const PALETTE = {
  ground: "#06080b",
  land: "#0b1117",
  coast: "#22323d",
  border: "#2a3944",
  grid: "rgb(120, 160, 180)",
  gridLabel: "#66808e",
  ink: "#e4ebf0",
  muted: "#7b8a96",
  dim: "#56656f",
  signal: "#3fe0cc", // turquoise: primary signal
  signalRgb: "63, 224, 204",
  accent: "#ff8a3d", // orange: lightning accent (cloud-to-ground flashes)
  accentRgb: "255, 138, 61",
  cgRgb: "255, 168, 112", // residual cloud-to-ground marker: softened accent
  core: "255, 246, 234",
};

// Strike response timing, in video seconds.
const FLASH = 0.1;
const HALO = 0.22;
const RING = 0.7;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
// Under-damped spring settling from 1.9 to 1: the residual marker "lands".
const spring = (a) => 1 + 0.9 * Math.exp(-a * 9) * Math.cos(a * 20);

function strikeColor(type) {
  return type === "CG" ? PALETTE.accentRgb : PALETTE.signalRgb;
}

function lowerBoundV(events, v) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].v < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function drawBasemap(ctx, m, k) {
  if (m.mapImage) {
    // Prepared basemap: rendered for exactly this frame, so it fills the canvas 1:1.
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(m.mapImage.image, 0, 0, m.settings.width, m.settings.height);
    ctx.restore();
    return;
  }
  if (!m.basemap) return;
  ctx.save();
  ctx.lineJoin = "round";
  for (const ring of m.basemap.land) {
    ctx.beginPath();
    ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = PALETTE.land;
    ctx.fill();
    ctx.strokeStyle = PALETTE.coast;
    ctx.lineWidth = 1 * k;
    ctx.stroke();
  }
  ctx.setLineDash([4 * k, 3 * k]);
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = 0.8 * k;
  for (const line of m.basemap.borders) {
    ctx.beginPath();
    line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.restore();
}

const DEG_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30];

function fmtDeg(v, pos, neg, step) {
  const d = (String(step).split(".")[1] ?? "").length;
  return `${Math.abs(v).toFixed(d)}°${v >= 0 ? pos : neg}`;
}

function drawGrid(ctx, m, k) {
  const { extent, proj, settings } = m;
  if (!settings.showGrid || settings.gridOpacity <= 0) return; // off by default (Map layers panel)
  const W = settings.width, H = settings.height;
  const step = m.niceStep(Math.min(extent.east - extent.west, extent.north - extent.south) / 5, DEG_STEPS);
  ctx.save();
  const lineAlpha = 0.4 * settings.gridOpacity, labelAlpha = 0.4 + 0.6 * settings.gridOpacity;
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = PALETTE.gridLabel;
  ctx.font = `${9.5 * k}px ${FONT_MONO}`;
  const labelY = H - m.layout.grid.labelBottom * k;
  ctx.textAlign = "center";
  for (let lon = Math.ceil(extent.west / step) * step; lon <= extent.east; lon += step) {
    const [x] = proj.project(lon, extent.south);
    ctx.globalAlpha = lineAlpha;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke();
    ctx.globalAlpha = labelAlpha;
    if (x > 60 * k && x < W - 60 * k) ctx.fillText(fmtDeg(lon, "E", "W", step), x, labelY);
  }
  ctx.textAlign = "left";
  for (let lat = Math.ceil(extent.south / step) * step; lat <= extent.north; lat += step) {
    const [, y] = proj.project(extent.west, lat);
    ctx.globalAlpha = lineAlpha;
    ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); ctx.stroke();
    ctx.globalAlpha = labelAlpha;
    if (y > m.layout.safe.top * k && y < labelY - 8 * k) ctx.fillText(fmtDeg(lat, "N", "S", step), 6 * k, y - 3 * k);
  }
  ctx.restore();
}

function drawPlaces(ctx, m, k) {
  ctx.save();
  ctx.font = `${10 * k}px ${FONT_SANS}`;
  ctx.textBaseline = "middle";
  for (const p of m.places) {
    const [x, y] = p.xy;
    ctx.strokeStyle = "rgba(160, 180, 192, 0.55)";
    ctx.lineWidth = 1 * k;
    ctx.strokeRect(x - 2 * k, y - 2 * k, 4 * k, 4 * k);
    ctx.fillStyle = p.rank === 1 ? "#93a3ae" : "#6f7f8a";
    ctx.fillText(p.name, x + 6 * k, y);
  }
  ctx.restore();
}

function drawStrikes(ctx, m, t, k) {
  const { events, trailVideo, settings } = m;
  const s = settings.markerScale * k;
  const hi = m.countAt(t); // events with v <= t
  const life = Math.max(trailVideo, RING);
  const lo = lowerBoundV(events, t - life);
  ctx.save();

  // 1) History: every earlier strike stays as a faint dot, so the storm's footprint builds up.
  if (settings.showHistory) {
    ctx.fillStyle = `rgba(${PALETTE.signalRgb}, 0.2)`;
    for (let i = 0; i < hi; i++) {
      const e = events[i];
      ctx.beginPath();
      ctx.arc(e.x, e.y, 1.3 * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 2) Residual markers: recent strikes, fading over the trail duration.
  if (trailVideo > 0) {
    for (let i = lo; i < hi; i++) {
      const e = events[i];
      const a = t - e.v;
      if (a > trailVideo) continue;
      const fade = Math.pow(1 - a / trailVideo, 1.2);
      const appear = clamp01((a - 0.04) / 0.08);
      const r = (2.1 + 1.3 * e.w) * s * spring(a);
      const alpha = 0.92 * fade * appear;
      if (alpha <= 0.003) continue;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      if (e.type === "IC") {
        ctx.strokeStyle = `rgba(${PALETTE.signalRgb}, ${alpha})`;
        ctx.lineWidth = 1.2 * k;
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(${e.type === "CG" ? PALETTE.cgRgb : PALETTE.signalRgb}, ${alpha})`;
        ctx.fill();
      }
    }
  }

  // 3) Active responses: flash, halo, pulse ring.
  for (let i = lowerBoundV(events, t - RING); i < hi; i++) {
    const e = events[i];
    const a = t - e.v;
    const R = (3 + 2.4 * e.w) * s;
    const rgb = strikeColor(e.type);

    const ringP = a / RING;
    if (ringP < 1) {
      const r = R * 1.1 + R * 4.2 * easeOutExpo(ringP);
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb}, ${0.85 * Math.pow(1 - ringP, 1.6)})`;
      ctx.lineWidth = Math.max(0.5, (1.8 - 1.2 * ringP) * k);
      ctx.stroke();
    }
    if (a < HALO) {
      const hp = a / HALO;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, R * 4);
      g.addColorStop(0, `rgba(${rgb}, ${0.32 * (1 - hp)})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(e.x, e.y, R * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (a < FLASH) {
      const fp = a / FLASH;
      ctx.beginPath();
      ctx.arc(e.x, e.y, R * 1.5 * (1 - 0.4 * easeOutCubic(fp)), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${PALETTE.core}, ${1 - fp * fp})`;
      ctx.fill();
    }
  }
  ctx.restore();
}

const SCALE_STEPS_M = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];

/** `str` shortened with an ellipsis so it fits `maxW` px at the context's current font. */
function fitText(ctx, str, maxW) {
  if (!(maxW > 0) || ctx.measureText(str).width <= maxW) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * Draw `str` inside `maxW` px: shrunk down to `minScale` of the current font first, then
 * shortened with an ellipsis. Honours the context's textAlign.
 */
function drawFitted(ctx, str, x, y, maxW, minScale = 1) {
  const w = ctx.measureText(str).width;
  const sc = w <= maxW ? 1 : Math.max(minScale, maxW / w);
  const out = fitText(ctx, str, maxW / sc);
  if (sc === 1) return ctx.fillText(out, x, y);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sc, sc);
  ctx.fillText(out, 0, 0);
  ctx.restore();
}

function drawScaleBar(ctx, m, k) {
  const { proj } = m;
  const S = m.layout.scaleBar;
  const lat = (m.extent.north + m.extent.south) / 2;
  const mpp = proj.metersPerPixel(lat);
  const target = S.target * k * mpp;
  let dist = SCALE_STEPS_M[0];
  for (const d of SCALE_STEPS_M) if (d <= target) dist = d;
  const px = dist / mpp;
  const label = dist >= 1000 ? `${dist / 1000} km` : `${dist} m`;
  const y = S.y * k;
  ctx.save();
  ctx.font = `${S.size * k}px ${FONT_MONO}`;
  const total = px + 6 * k + ctx.measureText(label).width;
  const x = S.align === "right" ? S.x * k - total : S.x * k;
  ctx.strokeStyle = PALETTE.muted;
  ctx.lineWidth = 1 * k;
  ctx.beginPath();
  ctx.moveTo(x, y - 4 * k); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4 * k);
  ctx.stroke();
  ctx.fillStyle = PALETTE.muted;
  ctx.textAlign = "left";
  ctx.fillText(label, x + px + 6 * k, y + 1 * k);
  ctx.restore();
}

function drawLegend(ctx, m, k) {
  const S = m.layout.legend;
  const y = S.y * k;
  const types = new Set(m.events.map((e) => e.type));
  const items = [];
  if (types.has("CG")) items.push(["cloud-to-ground", (cx, cy) => { ctx.fillStyle = `rgb(${PALETTE.cgRgb})`; ctx.beginPath(); ctx.arc(cx, cy, 3 * k, 0, 7); ctx.fill(); }]);
  if (types.has("IC")) items.push(["intracloud", (cx, cy) => { ctx.strokeStyle = PALETTE.signal; ctx.lineWidth = 1.2 * k; ctx.beginPath(); ctx.arc(cx, cy, 3 * k, 0, 7); ctx.stroke(); }]);
  if (types.has("unknown")) items.push(["unclassified", (cx, cy) => { ctx.fillStyle = PALETTE.signal; ctx.beginPath(); ctx.arc(cx, cy, 3 * k, 0, 7); ctx.fill(); }]);
  ctx.save();
  ctx.font = `${S.size * k}px ${FONT_MONO}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const trail = `trail ${m.settings.trailMinutes} min`;
  let total = ctx.measureText(trail).width;
  for (const [label] of items) total += 12 * k + ctx.measureText(label).width + 14 * k;
  // A legend wider than its slot shrinks to fit, so it can never run into its neighbours.
  const f = Math.min(1, (S.maxW * k) / total);
  const x0 = S.align === "right" ? S.x * k - total * f : S.x * k;
  ctx.translate(x0, y);
  ctx.scale(f, f);
  let x = 0;
  for (const [label, mark] of items) {
    mark(x + 4 * k, 0);
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(label, x + 12 * k, 0);
    x += ctx.measureText(label).width + 26 * k;
  }
  ctx.fillStyle = PALETTE.dim;
  ctx.fillText(trail, x, 0);
  ctx.restore();
}

function niceMinutes(raw) {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080]) if (s >= raw) return s;
  return 10080;
}

function drawStrip(ctx, m, t, k) {
  const { settings, bins, range, timeMap, displayOffsetMin: off } = m;
  const ov = settings.overlays;
  const A = m.layout.activity;
  const x0 = A.x0 * k, x1 = A.x1 * k, top = A.top * k, base = A.base * k;
  const w = x1 - x0, h = base - top;
  const max = Math.max(1, ...bins);
  const dataSpan = range.end - range.start;
  const nowMs = timeMap.toData(t);
  const frac = dataSpan === 0 ? (t >= timeMap.leadIn + timeMap.span / 2 ? 1 : 0) : (nowMs - range.start) / dataSpan;
  const playX = x0 + clamp01(frac) * w;
  const bw = w / bins.length;
  ctx.save();
  if (ov.activity) {
    // baseline
    ctx.fillStyle = PALETTE.dim;
    ctx.fillRect(x0, base, w, 1 * k);
    bins.forEach((c, i) => {
      if (!c) return;
      const bh = Math.max(1.5 * k, (c / max) * h);
      const bx = x0 + i * bw;
      const past = bx + bw <= playX;
      const partial = !past && bx < playX;
      ctx.fillStyle = past ? `rgba(${PALETTE.signalRgb}, 0.7)` : "#1f2c35";
      ctx.fillRect(bx + 0.5 * k, base - bh, Math.max(1, bw - 1 * k), bh);
      if (partial) {
        ctx.fillStyle = `rgba(${PALETTE.signalRgb}, 0.7)`;
        ctx.fillRect(bx + 0.5 * k, base - bh, Math.max(0, playX - bx - 0.5 * k), bh);
      }
    });
    // ticks
    ctx.font = `${A.size * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.gridLabel;
    ctx.textAlign = "center";
    if (dataSpan > 0) {
      const stepMin = niceMinutes(dataSpan / 60000 / 7);
      const stepMs = stepMin * 60000;
      // Align ticks to local wall-clock multiples of the step.
      const offMs = off * 60000;
      let tick = Math.ceil((range.start + offMs) / stepMs) * stepMs - offMs;
      for (; tick <= range.end; tick += stepMs) {
        const tx = x0 + ((tick - range.start) / dataSpan) * w;
        ctx.fillRect(tx, base + 2 * k, 1, 4 * k);
        const f = formatLocal(tick, off);
        ctx.fillText(stepMin >= 1440 ? f.date.slice(5) : f.hm, tx, base + 16 * k);
      }
    }
    // playhead
    ctx.fillStyle = PALETTE.accent;
    ctx.fillRect(Math.round(playX), top - 6 * k, 1.5 * k, h + 10 * k);
    ctx.beginPath();
    ctx.moveTo(playX - 4 * k, top - 10 * k); ctx.lineTo(playX + 4.5 * k, top - 10 * k); ctx.lineTo(playX + 0.75 * k, top - 5 * k);
    ctx.fill();
    ctx.fillStyle = PALETTE.dim;
    ctx.textAlign = "left";
    ctx.fillText(`strikes / ${Math.max(1, Math.round(m.binMs / 6000) / 10)} min`, x0, top - 6 * k);
  }
  // counters
  if (ov.counter) {
    const C = m.layout.counter;
    const cx = C.x * k;
    const count = m.countAt(t);
    ctx.textAlign = "left";
    ctx.fillStyle = PALETTE.muted;
    ctx.font = `${C.label.size * k}px ${FONT_MONO}`;
    ctx.fillText("STRIKES", cx, C.label.y * k);
    ctx.font = `500 ${C.value.size * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.ink;
    const digits = String(m.totalEvents).length;
    const cs = String(count).padStart(digits, "0");
    ctx.fillText(cs, cx, C.value.y * k);
    const cw = ctx.measureText(cs).width;
    ctx.font = `${C.value.total * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.muted;
    ctx.fillText(` / ${m.totalEvents}`, cx + cw, C.value.y * k);
    ctx.font = `${C.recent.size * k}px ${FONT_MONO}`;
    ctx.fillText("LAST 10 MIN", cx, C.recent.y * k);
    ctx.fillStyle = PALETTE.signal;
    ctx.fillText(String(m.recentCount(t, 600000)), cx + C.recent.dx * k, C.recent.y * k);
  }
  ctx.restore();
}

function drawHeader(ctx, m, t, k) {
  const { settings, meta, timeMap, displayOffsetMin: off } = m;
  const { title: T, notice: N, clock: K } = m.layout;
  const W = settings.width;
  const now = formatLocal(timeMap.toData(t), off);
  const ov = settings.overlays;
  const gap = 16 * k;
  // Space the title block's rows may use: up to the clock text that shares that row (if the clock is on).
  const room = { label: W - T.x * k - 24 * k, name: W - T.x * k - 24 * k, summary: W - T.x * k - 24 * k };
  ctx.save();
  ctx.textBaseline = "alphabetic";
  if (ov.clock) {
    ctx.textAlign = "right";
    const row = (r, font, str, color) => {
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.fillText(str, K.xr * k, r.y * k);
      return K.xr * k - ctx.measureText(str).width - gap - T.x * k;
    };
    const zoneRoom = row(K.label, `${K.label.size * k}px ${FONT_MONO}`, `LOCAL TIME · ${now.zone}`, PALETTE.muted);
    const timeRoom = row(K.time, `500 ${K.time.size * k}px ${FONT_MONO}`, now.time, PALETTE.ink);
    const dateRoom = row(K.date, `${K.date.size * k}px ${FONT_MONO}`, now.date, PALETTE.muted);
    // Only rows at the same height can collide: label↔label, title↔time, summary↔date.
    room.label = zoneRoom; room.name = timeRoom; room.summary = dateRoom;
  }
  ctx.textAlign = "left";
  if (ov.title) {
    ctx.font = `500 ${T.label.size * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.signal;
    ctx.fillText("LIGHTNING REPLAY", T.x * k, T.label.y * k);
    ctx.font = `600 ${T.name.size * k}px ${FONT_SANS}`;
    ctx.fillStyle = PALETTE.ink;
    drawFitted(ctx, settings.title || meta.name || "Lightning dataset", T.x * k, T.name.y * k, room.name, 0.72);
    const span = m.range.end - m.range.start;
    const mins = Math.round(span / 60000);
    ctx.font = `${T.summary.size * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.muted;
    const dur = mins >= 120 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)} h` : `${mins} min`;
    drawFitted(ctx, `${m.totalEvents} strikes · ${dur} storm → ${settings.duration} s replay (×${Math.round(span / 1000 / timeMap.span)})`, T.x * k, T.summary.y * k, room.summary, 0.85);
  }
  if (ov.syntheticNotice && meta.synthetic) {
    ctx.font = `500 ${N.size * k}px ${FONT_MONO}`;
    const label = "SYNTHETIC DATA · FICTIONAL STORM · NOT REAL DETECTIONS";
    const tw = ctx.measureText(label).width;
    ctx.strokeStyle = `rgba(${PALETTE.accentRgb}, 0.7)`;
    ctx.lineWidth = 1 * k;
    ctx.strokeRect(N.x * k + 0.5, N.y * k + 0.5, tw + 12 * k, N.h * k);
    ctx.fillStyle = PALETTE.accent;
    ctx.fillText(label, N.x * k + 6 * k, (N.y + N.h * 0.75) * k);
  }
  ctx.restore();
}

function drawFooterNote(ctx, m, k) {
  const A = m.layout.attribution;
  ctx.save();
  ctx.textAlign = A.align;
  if (m.mapImage) {
    // Map data credit required by the tile provider; kept legible in every exported frame.
    ctx.font = `${A.size * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.muted;
    drawFitted(ctx, m.mapImage.attribution, A.x * k, A.y * k, A.maxW * k, 0.85);
  } else {
    ctx.font = `${(A.size - 0.5) * k}px ${FONT_MONO}`;
    ctx.fillStyle = PALETTE.dim;
    const geo = m.basemap ? "Coastlines/borders: Natural Earth 1:50m · " : "";
    drawFitted(ctx, `${geo}Web Mercator · places approx.`, A.x * k, (A.y - 1) * k, A.maxW * k, 0.85);
  }
  ctx.restore();
}

/**
 * @param ctx CanvasRenderingContext2D sized to settings.width × settings.height (logical px)
 * @param m model from buildReplay()
 * @param t video time in seconds
 * @param opts { highlight?: event }  preview-only overlay marking a selected strike
 */
export function drawFrame(ctx, m, t, opts = {}) {
  const { width: W, height: H } = m.settings;
  const L = m.layout;
  const k = L.k; // output px per design unit: 1 for Draft, 2 for Full HD
  ctx.save();
  ctx.fillStyle = PALETTE.ground;
  ctx.fillRect(0, 0, W, H);
  drawBasemap(ctx, m, k);
  drawGrid(ctx, m, k);
  drawPlaces(ctx, m, k);
  drawStrikes(ctx, m, t, k);
  // Informational overlays (src/core/overlays.js). The HUD backing bands keep their text
  // readable over the map, so each band exists only while an overlay needs it.
  const ov = m.settings.overlays;
  if (zoneVisible(ov, "top", L)) {
    const h = L.bands.top * k;
    const g1 = ctx.createLinearGradient(0, 0, 0, h);
    g1.addColorStop(0, "rgba(6, 8, 11, 0.92)"); g1.addColorStop(1, "rgba(6, 8, 11, 0)");
    ctx.fillStyle = g1; ctx.fillRect(0, 0, W, h);
  }
  if (zoneVisible(ov, "bottom", L)) {
    const h = L.bands.bottom * k;
    const g2 = ctx.createLinearGradient(0, H - h, 0, H);
    g2.addColorStop(0, "rgba(6, 8, 11, 0)"); g2.addColorStop(0.35, "rgba(6, 8, 11, 0.9)"); g2.addColorStop(1, "rgba(6, 8, 11, 0.96)");
    ctx.fillStyle = g2; ctx.fillRect(0, H - h, W, h);
  }
  drawHeader(ctx, m, t, k);
  if (ov.scaleBar) drawScaleBar(ctx, m, k);
  if (ov.legend) drawLegend(ctx, m, k);
  drawStrip(ctx, m, t, k);
  if (ov.attribution) drawFooterNote(ctx, m, k);
  if (opts.highlight) {
    const e = opts.highlight;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    const r = 12 * k;
    ctx.beginPath();
    ctx.moveTo(e.x - r * 1.6, e.y); ctx.lineTo(e.x - r * 0.7, e.y);
    ctx.moveTo(e.x + r * 0.7, e.y); ctx.lineTo(e.x + r * 1.6, e.y);
    ctx.moveTo(e.x, e.y - r * 1.6); ctx.lineTo(e.x, e.y - r * 0.7);
    ctx.moveTo(e.x, e.y + r * 0.7); ctx.lineTo(e.x, e.y + r * 1.6);
    ctx.stroke();
  }
  // Opening fade from black (0.4 s); the strike timeline starts after it.
  const fade = Math.min(0.4, m.timeMap.leadIn);
  if (t < fade) {
    ctx.fillStyle = `rgba(6, 8, 11, ${1 - easeOutCubic(t / fade)})`;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}
