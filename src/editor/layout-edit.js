// Overlay Layout Editor: the geometry behind dragging, snapping, scaling and nudging.
// Pure functions on boxes in *output* pixels (the video's own pixel grid), so the same layout
// results whatever size the preview is shown at; the DOM layer (app/layout-editor.js) only
// converts pointer positions and draws outlines and guides. Overrides are stored per format as
// normalized anchor positions (src/core/hud.js).
import { SCALE_MAX, SCALE_MIN, normalizeLayout, placeBox } from "../core/hud.js";

/** Snapping, in preview CSS px: capture within `capture`, hold until the unsnapped position is `release` away. */
export const SNAP = Object.freeze({ capture: 6, release: 10 });

// ---------- coordinates ----------

/** Output px per preview CSS px for a preview element `rect` showing a width × height frame. */
export const outputPerCss = (rect, width) => width / rect.width;

/** A pointer position (client CSS px) as a point in output px. */
export function toOutput(clientX, clientY, rect, width, height) {
  return [((clientX - rect.left) * width) / rect.width, ((clientY - rect.top) * height) / rect.height];
}

/** An output-px box as preview CSS px inside `rect`'s own coordinates. */
export function toCss(box, rect, width) {
  const f = rect.width / width;
  return { x: box.x * f, y: box.y * f, w: box.w * f, h: box.h * f };
}

// ---------- boxes and placements ----------

const edgeOf = (start, size, edge) => (edge === "start" ? start : edge === "center" ? start + size / 2 : start + size);

/** Keep a box inside the frame (a box larger than the frame is aligned to its start). */
export function clampBox(box, width, height) {
  const x = box.w >= width ? 0 : Math.min(width - box.w, Math.max(0, box.x));
  const y = box.h >= height ? 0 : Math.min(height - box.h, Math.max(0, box.y));
  return { ...box, x, y };
}

/** A placement moved so that its box lands at `box` (same size). */
export function moveTo(p, base, box) {
  const cur = placeBox(p, base);
  return { ...p, x: p.x + (box.x - cur.x), y: p.y + (box.y - cur.y) };
}

/** The override ({x, y, scale}, normalized) that reproduces a placement. */
export const overrideOf = (p, width, height) => ({ x: p.x / width, y: p.y / height, scale: p.s });

/** Largest scale at which an overlay (preset box `base`) still fits the frame. */
export const fitScale = (base, width, height) => Math.min(SCALE_MAX, width / base.w, height / base.h);

/**
 * Scale a placement to `scale` about the output-px point `pivot` (which stays where it is),
 * within [SCALE_MIN, SCALE_MAX] and no larger than the frame, then keep its box inside the frame.
 */
export function scaleAbout(p, base, scale, pivot, width, height) {
  const s = Math.max(SCALE_MIN, Math.min(fitScale(base, width, height), scale));
  const f = s / p.s;
  const q = { ...p, s, x: pivot[0] + (p.x - pivot[0]) * f, y: pivot[1] + (p.y - pivot[1]) * f };
  return moveTo(q, base, clampBox(placeBox(q, base), width, height));
}

/**
 * Resize by dragging a corner: the opposite corner stays fixed and the scale follows the pointer
 * along the box diagonal. The scale is limited so the box stays inside the frame.
 */
export function resizeFromCorner(p, base, corner, pointer, width, height) {
  const b = placeBox(p, base);
  const right = corner.includes("e"), bottom = corner.includes("s");
  const fixed = [right ? b.x : b.x + b.w, bottom ? b.y : b.y + b.h];
  const start = [right ? b.x + b.w : b.x, bottom ? b.y + b.h : b.y];
  const d = [start[0] - fixed[0], start[1] - fixed[1]];
  const r = ((pointer[0] - fixed[0]) * d[0] + (pointer[1] - fixed[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]);
  // Room from the fixed corner to the frame edge, in multiples of the current box.
  const roomX = (right ? width - fixed[0] : fixed[0]) / b.w, roomY = (bottom ? height - fixed[1] : fixed[1]) / b.h;
  const f = Math.max(SCALE_MIN / p.s, Math.min(r, roomX, roomY, fitScale(base, width, height) / p.s));
  const s = Math.round(p.s * f * 100) / 100;
  return scaleAbout(p, base, s, fixed, width, height);
}

/** Arrow-key nudge by (dx, dy) output px, inside the frame; no snapping. */
export function nudge(p, base, dx, dy, width, height) {
  const b = placeBox(p, base);
  return moveTo(p, base, clampBox({ ...b, x: b.x + dx, y: b.y + dy }, width, height));
}

// ---------- alignment targets ----------

/**
 * Alignment targets for a frame, per axis: { v (output px), edge (which edge of the dragged box
 * aligns: start / center / end), kind, major, rank (lower wins a tie) }.
 * Frame centre (major), platform safe areas (portrait), edge margins and quarters (minor), and the
 * edges and centres of the other visible overlays.
 */
export function snapTargets(L, width, height, others = []) {
  const k = L.k, m = L.safe.side * k;
  const x = [
    { v: width / 2, edge: "center", kind: "center", major: true, rank: 0 },
    { v: m, edge: "start", kind: "margin", rank: 2 },
    { v: width - m, edge: "end", kind: "margin", rank: 2 },
    { v: width / 4, edge: "center", kind: "quarter", rank: 3 },
    { v: (3 * width) / 4, edge: "center", kind: "quarter", rank: 3 },
  ];
  const y = [
    { v: height / 2, edge: "center", kind: "center", major: true, rank: 0 },
    { v: height / 4, edge: "center", kind: "quarter", rank: 3 },
    { v: (3 * height) / 4, edge: "center", kind: "quarter", rank: 3 },
  ];
  if (L.safe.top > 0) y.push({ v: L.safe.top * k, edge: "start", kind: "safe", rank: 1 });
  else y.push({ v: m, edge: "start", kind: "margin", rank: 2 });
  if (L.safe.bottom > 0) y.push({ v: height - L.safe.bottom * k, edge: "end", kind: "safe", rank: 1 });
  else y.push({ v: height - m, edge: "end", kind: "margin", rank: 2 });
  for (const o of others) {
    for (const edge of ["start", "center", "end"]) {
      x.push({ v: edgeOf(o.x, o.w, edge), edge, kind: "overlay", rank: 4, of: o.id });
      y.push({ v: edgeOf(o.y, o.h, edge), edge, kind: "overlay", rank: 4, of: o.id });
    }
  }
  return { x, y };
}

// ---------- magnetic snapping (one axis) ----------

/** Overlay-to-overlay targets capture and release within this fraction of the frame targets' distances. */
const OVERLAY_SNAP = 0.6;

/** Fresh state of one drag axis: nothing held, no recent release. */
export const freeAxis = () => ({ held: null, releasedAt: null });

/**
 * One axis of a drag. `state` is { held, releasedAt }; `start` and `size` are the dragged box's
 * unsnapped position and size on this axis; thresholds are in output px.
 * - A held target stays while the unsnapped box is within `release` of it (hysteresis).
 * - On release the box goes straight back to the unsnapped position, and nothing can capture again
 *   until it has moved `capture` further, so dragging on through a target never falls into the next.
 * - Otherwise the nearest target within `capture` is taken (overlay edges within a smaller
 *   distance; they also let go sooner), ties going to the lower rank, then the lower coordinate: always the same choice.
 * The unsnapped position is never modified, so no offset accumulates.
 * Returns { pos, state }.
 */
export function snapAxis(state, start, size, targets, { capture, release }) {
  const { held, releasedAt } = state ?? freeAxis();
  if (held) {
    const d = held.v - edgeOf(start, size, held.edge);
    if (Math.abs(d) <= (held.kind === "overlay" ? release * OVERLAY_SNAP : release)) return { pos: start + d, state: { held, releasedAt: null } };
    return { pos: start, state: { held: null, releasedAt: start } };
  }
  if (releasedAt !== null && Math.abs(start - releasedAt) < capture) return { pos: start, state: { held: null, releasedAt } };
  let best = null, bestKey = null;
  const tie = capture / 6; // distances this close count as equal, so the more important target wins
  for (const t of targets) {
    const d = t.v - edgeOf(start, size, t.edge);
    if (Math.abs(d) > (t.kind === "overlay" ? capture * OVERLAY_SNAP : capture)) continue;
    const key = [Math.round(Math.abs(d) / tie), t.rank, t.v];
    if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = { t, d };
      bestKey = key;
    }
  }
  return best ? { pos: start + best.d, state: { held: best.t, releasedAt: null } } : { pos: start, state: freeAxis() };
}

/**
 * The displayed box during a drag: start box + pointer delta, snapped per axis (unless `snapping`
 * is off) and kept inside the frame. `axes` is { x, y } axis state (see freeAxis); returns
 * { box, axes }. A held target whose guide no longer matches after clamping is dropped.
 */
export function dragBox(startBox, delta, axes, targets, thresholds, snapping, width, height) {
  const raw = { ...startBox, x: startBox.x + delta[0], y: startBox.y + delta[1] };
  let x = raw.x, y = raw.y, ax = freeAxis(), ay = freeAxis();
  if (snapping) {
    ({ pos: x, state: ax } = snapAxis(axes?.x, raw.x, raw.w, targets.x, thresholds));
    ({ pos: y, state: ay } = snapAxis(axes?.y, raw.y, raw.h, targets.y, thresholds));
  }
  const box = clampBox({ ...raw, x, y }, width, height);
  if (ax.held && Math.abs(edgeOf(box.x, box.w, ax.held.edge) - ax.held.v) > 0.01) ax = freeAxis();
  if (ay.held && Math.abs(edgeOf(box.y, box.h, ay.held.edge) - ay.held.v) > 0.01) ay = freeAxis();
  return { box, axes: { x: ax, y: ay } };
}

// ---------- per-format layout state ----------

/**
 * The studio's layouts: one set of overrides per video format, so editing portrait never touches
 * landscape or square. Draft and Full HD of a format share one layout (it is normalized).
 */
export function createLayoutStore(initial = {}) {
  const layouts = { landscape: {}, portrait: {}, square: {} };
  for (const f of Object.keys(layouts)) layouts[f] = normalizeLayout(initial[f]);
  return {
    get: (format) => layouts[format],
    /** Merge `patch` ({x, y, scale, locked}) into one overlay's override. */
    set(format, id, patch) {
      layouts[format] = normalizeLayout({ ...layouts[format], [id]: { ...layouts[format][id], ...patch } });
      return layouts[format];
    },
    /** Replace one overlay's override outright (null / undefined = none). */
    replace(format, id, value) {
      const next = { ...layouts[format] };
      if (value) next[id] = value;
      else delete next[id];
      layouts[format] = normalizeLayout(next);
      return layouts[format];
    },
    /** Back to the preset position and size (a lock is kept: it is about editing, not placement). */
    reset(format, id) {
      const next = { ...layouts[format] };
      if (next[id]?.locked) next[id] = { locked: true };
      else delete next[id];
      layouts[format] = normalizeLayout(next);
      return layouts[format];
    },
    resetAll(format) {
      layouts[format] = {};
      return layouts[format];
    },
    isLocked: (format, id) => !!layouts[format][id]?.locked,
    toJSON: () => structuredClone(layouts),
  };
}
