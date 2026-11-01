// HUD layout per video format. One small table per layout family says where every informational
// overlay sits, in *design units* (u): the renderer multiplies by k (output px per unit), so a
// layout is resolution-independent and Draft / Full HD only differ in pixel density.
//
//   landscape   960 × 540 u  the classic HUD, unchanged
//   portrait    540 × 960 u  stacked HUD that respects the mobile-platform safe areas
//   square      540 × 540 u  compact HUD, the map stays dominant
//
// `zone` says which backing gradient band ("top" / "bottom") an overlay's text sits on; a band is
// drawn only while one of its overlays is on. `fit` gives the margins of the HUD-free map area that
// Fit to Data uses (`top` / `bottom` while that band is visible, `edgeTop` / `edgeBottom` otherwise).
import { designViewport } from "./format.js";
import { cameraOf } from "./projection.js";

const text = (y, size, extra = {}) => ({ y, size, ...extra });

function landscape(Wu, Hu) {
  return {
    safe: { top: 0, bottom: 0, side: 24 },
    zone: { title: "top", clock: "top", syntheticNotice: "top", attribution: "top", counter: "bottom", activity: "bottom", scaleBar: "bottom", legend: "bottom" },
    bands: { top: 100, bottom: 92 },
    fit: { top: 98, bottom: 104, side: 40, edgeTop: 40, edgeBottom: 40 },
    title: { x: 24, label: text(30, 9.5), name: text(52, 17), summary: text(68, 9) },
    notice: { x: 24, y: 76, h: 14, size: 8.5 },
    clock: { xr: Wu - 24, label: text(26, 9), time: text(56, 28), date: text(72, 9) },
    attribution: { x: Wu - 24, y: 87, size: 9, align: "right", maxW: Wu - 48 },
    counter: { x: 24, label: text(Hu - 74, 9), value: text(Hu - 50, 22, { total: 11 }), recent: text(Hu - 30, 9, { dx: 80 }) },
    activity: { x0: 196, x1: Wu - 24, top: Hu - 70, base: Hu - 30, size: 9.5 },
    scaleBar: { x: 24, y: Hu - 84, size: 9, align: "left", target: 110 },
    legend: { x: Wu - 360, y: Hu - 86, size: 9.5, align: "left", maxW: 340 },
    grid: { labelBottom: 4 },
  };
}

// Portrait: platform UI (status bar, tabs, caption, buttons) covers roughly the top 9 % and the
// bottom 13 % of a 9:16 frame, so nothing but the map lives there. The HUD stacks inside the rest.
function portrait(Wu, Hu) {
  const m = 32, safeTop = 90, safeBottom = 130, Hb = Hu - safeBottom;
  return {
    safe: { top: safeTop, bottom: safeBottom, side: m },
    zone: { title: "top", clock: "top", syntheticNotice: "top", attribution: "bottom", counter: "bottom", activity: "bottom", scaleBar: "bottom", legend: "bottom" },
    bands: { top: 204, bottom: 306 },
    fit: { top: 216, bottom: 290, side: 40, edgeTop: safeTop, edgeBottom: safeBottom },
    title: { x: m, label: text(104, 10.5), name: text(131, 22), summary: text(151, 9.5) },
    notice: { x: m, y: 162, h: 18, size: 9 },
    clock: { xr: Wu - m, label: text(104, 9.5), time: text(135, 30), date: text(151, 9.5) },
    attribution: { x: m, y: Hb - 2, size: 9, align: "left", maxW: Wu - 2 * m },
    counter: { x: m, label: text(Hb - 142, 10), value: text(Hb - 114, 28, { total: 13 }), recent: text(Hb - 94, 10, { dx: 90 }) },
    activity: { x0: m + 14, x1: Wu - m - 14, top: Hb - 70, base: Hb - 30, size: 9.5 }, // inset so the end tick labels stay inside the margins
    scaleBar: { x: Wu - m, y: Hb - 114, size: 9.5, align: "right", target: 110 },
    legend: { x: Wu - m, y: Hb - 92, size: 9.5, align: "right", maxW: Wu - 2 * m },
    grid: { labelBottom: safeBottom + 150 },
  };
}

function square(Wu, Hu) {
  const m = 24;
  return {
    safe: { top: 20, bottom: 20, side: m },
    zone: { title: "top", clock: "top", syntheticNotice: "top", attribution: "bottom", counter: "bottom", activity: "bottom", scaleBar: "bottom", legend: "bottom" },
    bands: { top: 96, bottom: 124 },
    fit: { top: 104, bottom: 130, side: 28, edgeTop: 28, edgeBottom: 28 },
    title: { x: m, label: text(26, 9.5), name: text(49, 19), summary: text(64, 9) },
    notice: { x: m, y: 71, h: 14, size: 9 },
    clock: { xr: Wu - m, label: text(25, 9), time: text(51, 26), date: text(66, 9) },
    attribution: { x: m, y: Hu - 6, size: 9, align: "left", maxW: Wu - 2 * m },
    counter: { x: m, label: text(Hu - 76, 9), value: text(Hu - 52, 22, { total: 11 }), recent: text(Hu - 34, 9, { dx: 80 }) },
    activity: { x0: 170, x1: Wu - m - 12, top: Hu - 72, base: Hu - 34, size: 9.5 },
    scaleBar: { x: m, y: Hu - 92, size: 9, align: "left", target: 110 },
    legend: { x: Wu - m, y: Hu - 92, size: 9.5, align: "right", maxW: Wu - 2 * m - 170 },
    grid: { labelBottom: 4 },
  };
}

const FAMILIES = { landscape, portrait, square };

/** Layout of an output size: { kind, k, Wu, Hu, ...slots } (see the family tables above). */
export function layoutFor(width, height) {
  const { kind, k, width: Wu, height: Hu } = designViewport(width, height);
  return { kind, k, Wu, Hu, ...FAMILIES[kind](Wu, Hu) };
}

/**
 * The MapLibre camera of a projection in *design* CSS px (the viewport the basemap is baked in and
 * the composer shows). Draft and Full HD of one frame share it, so they show the same map detail.
 */
export function designCamera(proj, width, height) {
  const { k } = designViewport(width, height);
  const c = cameraOf(proj, width, height);
  return { lon: c.lon, lat: c.lat, zoom: c.zoom - Math.log2(k) };
}
