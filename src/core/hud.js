// Overlay placement: where each informational overlay sits and how large it is drawn.
//
//   effective placement = the format's preset (src/core/layout.js) + the user's overrides
//
// Every overlay has an *anchor*: a point on its natural edge (the title's top-left corner, the
// clock's top-right, the activity chart's bottom centre, …) taken from the preset layout. A user
// override moves that anchor and scales the overlay about it:
//
//   overlayLayout = { [overlayId]: { x, y, scale, locked } }   (all fields optional)
//
// x and y are the anchor's position as a fraction of the frame width / height (0…1), so one layout
// renders at the same relative place and size in Draft and Full HD. The renderer draws an overlay
// exactly as in the preset and maps it with  p → anchor + (p − presetAnchor) · scale , which keeps
// its typography, chart values and internal spacing intact. `locked` only guards against editing.
import { OVERLAYS } from "./overlays.js";

export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1.5;
const IDS = OVERLAYS.map((o) => o.id);
const FORMAT_KEYS = ["landscape", "portrait", "square"];

/**
 * Validated overrides for one format. Unknown overlays and fields are dropped, positions are kept
 * at the frame (with a little slack for anchors), scale inside [SCALE_MIN, SCALE_MAX]. A layout keyed by format
 * ({ portrait: {...}, square: {...} }) yields the entry for `format`.
 */
export function normalizeLayout(input, format = null) {
  if (!input || typeof input !== "object") return {};
  if (format && FORMAT_KEYS.some((f) => f in input)) input = input[format] ?? {};
  const out = {};
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  for (const id of IDS) {
    const o = input[id];
    if (!o || typeof o !== "object") continue;
    const e = {};
    // The anchor may sit slightly outside the frame while the overlay's box touches an edge.
    if (Number.isFinite(+o.x) && o.x !== null && o.x !== "") e.x = clamp(+o.x, -0.25, 1.25);
    if (Number.isFinite(+o.y) && o.y !== null && o.y !== "") e.y = clamp(+o.y, -0.25, 1.25);
    if (Number.isFinite(+o.scale) && o.scale !== null && o.scale !== "") e.scale = clamp(+o.scale, SCALE_MIN, SCALE_MAX);
    if (o.locked === true || o.locked === "true") e.locked = true;
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}

/**
 * Preset anchor of an overlay, in design units: the point on its natural edge and that point's
 * place in the overlay's box (ax, ay: 0 = left / top, 0.5 = centre, 1 = right / bottom).
 */
export function presetAnchor(L, id) {
  const zone = L.zone[id];
  const vy = zone === "top" ? 0 : 1;
  switch (id) {
    case "title": return { x: L.title.x, y: L.title.label.y - L.title.label.size, ax: 0, ay: 0 };
    case "clock": return { x: L.clock.xr, y: L.clock.label.y - L.clock.label.size, ax: 1, ay: 0 };
    case "syntheticNotice": return { x: L.notice.x, y: L.notice.y, ax: 0, ay: 0 };
    case "counter": return { x: L.counter.x, y: L.counter.recent.y + 0.3 * L.counter.recent.size, ax: 0, ay: 1 };
    case "activity": return { x: (L.activity.x0 + L.activity.x1) / 2, y: L.activity.base + 16 + 0.3 * L.activity.size, ax: 0.5, ay: 1 };
    case "scaleBar": return { x: L.scaleBar.x, y: L.scaleBar.y + 3, ax: L.scaleBar.align === "right" ? 1 : 0, ay: 1 };
    case "legend": return { x: L.legend.x, y: L.legend.y + 0.6 * L.legend.size, ax: L.legend.align === "right" ? 1 : 0, ay: 1 };
    case "attribution": {
      const A = L.attribution;
      return { x: A.x, y: vy ? A.y + 0.3 * A.size : A.y - A.size, ax: A.align === "right" ? 1 : A.align === "center" ? 0.5 : 0, ay: vy };
    }
  }
  throw new Error(`Unknown overlay "${id}".`);
}

/**
 * Effective placement of an overlay on a width × height output (output px):
 * { x0, y0 } preset anchor, { x, y } anchor, s scale, moved (differs from the preset), locked.
 */
export function placement(L, layout, id, width, height) {
  const a = presetAnchor(L, id);
  const x0 = a.x * L.k, y0 = a.y * L.k;
  const o = layout?.[id] ?? {};
  const x = o.x !== undefined ? o.x * width : x0;
  const y = o.y !== undefined ? o.y * height : y0;
  const s = o.scale ?? 1;
  const moved = Math.abs(x - x0) > 1e-6 || Math.abs(y - y0) > 1e-6 || Math.abs(s - 1) > 1e-9;
  return { id, x0, y0, x, y, s, ax: a.ax, ay: a.ay, moved, locked: !!o.locked };
}

/** Map a box drawn at the preset placement (output px) to where the placement puts it. */
export function placeBox(p, b) {
  return { x: p.x + (b.x - p.x0) * p.s, y: p.y + (b.y - p.y0) * p.s, w: b.w * p.s, h: b.h * p.s };
}

/** Is any overlay of this layout away from its preset? */
export const layoutIsCustom = (L, layout, width, height) => IDS.some((id) => placement(L, layout, id, width, height).moved);

// ---- HUD backing shading ----
// One intensity 0…1 multiplies the backing gradients' opacity; 1 is the preset look of each format.
export const SHADING_PRESETS = Object.freeze({ off: 0, subtle: 0.5, standard: 1 });
export const DEFAULT_SHADING = SHADING_PRESETS.standard;

export function shadingPreset(v) {
  for (const [name, x] of Object.entries(SHADING_PRESETS)) if (Math.abs(v - x) < 1e-9) return name;
  return "custom";
}
