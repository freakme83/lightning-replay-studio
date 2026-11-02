// Overlay Layout Editor: the placement model (src/core/hud.js), how the shared renderer applies it,
// HUD shading, measured overlay geometry, and the editor's coordinate / snapping / scaling / store
// logic (src/editor/layout-edit.js).
//   node --test tests/layout-editor.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay, fitFrame } from "../src/core/replay.js";
import { drawFrame, overlayGeometry } from "../src/core/draw.js";
import { outputSize } from "../src/core/format.js";
import { layoutFor } from "../src/core/layout.js";
import { OVERLAYS, defaultOverlays, noOverlays } from "../src/core/overlays.js";
import { SCALE_MAX, SCALE_MIN, normalizeLayout, placeBox, placement, presetAnchor, shadingPreset } from "../src/core/hud.js";
import { basemapMismatch, buildComposition, ROOT } from "../src/export/composition.js";
import {
  SNAP, clampBox, createLayoutStore, dragBox, freeAxis, moveTo, nudge, outputPerCss, overrideOf, resizeFromCorner, scaleAbout, snapAxis, snapTargets, toCss, toOutput,
} from "../src/editor/layout-edit.js";

const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json"); // synthetic: all eight overlays draw
const MAP = { image: {}, attribution: "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors" };
const FORMATS = ["landscape", "portrait", "square"];
const IDS = OVERLAYS.map((o) => o.id);

function model(format = "portrait", quality = "hd", extra = {}) {
  const { width, height } = outputSize(format, quality);
  return buildReplay(sample, { format, quality, frame: fitFrame(sample.events, width, height), ...extra }, { mapImage: MAP });
}

/** Recording 2D context with a transform stack: text boxes, gradients, shadows and fill ops in output px. */
function record(m, t = 12) {
  const log = { text: [], gradients: [], shadowRects: 0, rects: [] };
  let tr = { tx: 0, ty: 0, s: 1 };
  const stack = [];
  const o = { font: "10px x", textAlign: "left", textBaseline: "alphabetic", shadowBlur: 0, shadowOffsetX: 0 };
  const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(o.font)?.[1] ?? 10);
  const ctx = new Proxy(o, {
    get: (_, k) => {
      if (k === "save") return () => stack.push({ tr: { ...tr }, o: { ...o } });
      if (k === "restore") return () => { const top = stack.pop(); tr = top.tr; Object.assign(o, top.o); };
      if (k === "translate") return (x, y) => { tr.tx += x * tr.s; tr.ty += y * tr.s; };
      if (k === "scale") return (a) => { tr.s *= a; };
      if (k === "measureText") return (s) => ({ width: String(s).length * size() * 0.6 });
      if (k === "createLinearGradient") return (x0, y0, x1, y1) => { const g = { y0, y1, stops: [], addColorStop: (f, c) => g.stops.push(Number(/,\s*([\d.]+)\)$/.exec(c)[1])) }; log.gradients.push(g); return g; };
      if (k === "createRadialGradient") return () => ({ addColorStop() {} });
      if (k === "fillText") return (s, x, y) => {
        const w = String(s).length * size() * 0.6 * tr.s;
        const X = tr.tx + x * tr.s, Y = tr.ty + y * tr.s;
        const l = o.textAlign === "right" ? X - w : o.textAlign === "center" ? X - w / 2 : X;
        log.text.push({ s: String(s), l, y: Y, size: size() * tr.s, shadow: o.shadowBlur });
      };
      if (k === "fillRect") return (x, y, w, h) => { if (o.shadowOffsetX) log.shadowRects++; log.rects.push([tr.tx + x * tr.s, tr.ty + y * tr.s, w * tr.s, h * tr.s]); };
      if (k in o) return o[k];
      return () => {};
    },
    set: (_, k, v) => { o[k] = v; return true; },
  });
  drawFrame(ctx, m, t);
  return JSON.parse(JSON.stringify(log)); // plain data, comparable with deepEqual
}
/** A measuring context for overlayGeometry (monospace-ish widths). */
const measureCtx = () => new Proxy({ font: "10px x" }, {
  get: (o, k) => (k === "measureText" ? (s) => ({ width: String(s).length * Number(/(\d+(?:\.\d+)?)px/.exec(o.font)[1]) * 0.6 }) : k in o ? o[k] : () => {}),
  set: (o, k, v) => { o[k] = v; return true; },
});

// ---------------- placement model ----------------

test("32. layout overrides: validation, clamping, per-format entries", () => {
  assert.deepEqual(normalizeLayout(null), {});
  assert.deepEqual(normalizeLayout({ title: { x: 0.2, y: "0.3", scale: 9, locked: "true", junk: 1 }, nope: { x: 1 } }), { title: { x: 0.2, y: 0.3, scale: SCALE_MAX, locked: true } });
  assert.deepEqual(normalizeLayout({ counter: { scale: 0.1 } }), { counter: { scale: SCALE_MIN } });
  assert.deepEqual(normalizeLayout({ counter: { x: 7, y: -3 } }), { counter: { x: 1.25, y: -0.25 } }, "anchors keep a little slack around the frame");
  assert.deepEqual(normalizeLayout({ clock: { x: NaN, scale: null, locked: false } }), {}, "nothing valid → no entry");
  assert.deepEqual(normalizeLayout({ portrait: { legend: { x: 0.5 } }, square: { legend: { x: 0.1 } } }, "portrait"), { legend: { x: 0.5 } });
  // Through the settings model, keyed by the selected format.
  const m = model("square", "draft", { overlayLayout: { portrait: { clock: { x: 0.5 } }, square: { clock: { x: 0.25 } } } });
  assert.deepEqual(m.settings.overlayLayout, { clock: { x: 0.25 } });
  assert.throws(() => model("portrait", "hd", { hudShading: 2 }), /HUD shading/);
});

test("33. normalized placement: the preset is unchanged, and one layout is the same relative composition in Draft and Full HD", () => {
  for (const f of FORMATS) {
    const hd = outputSize(f, "hd"), dr = outputSize(f, "draft");
    const Lh = layoutFor(hd.width, hd.height), Ld = layoutFor(dr.width, dr.height);
    for (const id of IDS) {
      const p = placement(Lh, {}, id, hd.width, hd.height);
      assert.equal(p.moved, false, `${f} ${id} preset`);
      assert.deepEqual([p.x, p.y, p.s], [p.x0, p.y0, 1]);
      const a = presetAnchor(Lh, id);
      assert.ok([0, 0.5, 1].includes(a.ax) && [0, 1].includes(a.ay));
    }
    const layout = { title: { x: 0.3, y: 0.42, scale: 1.25 }, activity: { x: 0.5, y: 0.97, scale: 0.75 } };
    for (const id of ["title", "activity"]) {
      const ph = placement(Lh, layout, id, hd.width, hd.height), pd = placement(Ld, layout, id, dr.width, dr.height);
      assert.ok(ph.moved && pd.moved);
      assert.ok(Math.abs(ph.x / hd.width - pd.x / dr.width) < 1e-12 && Math.abs(ph.y / hd.height - pd.y / dr.height) < 1e-12, `${f} ${id}: same relative anchor`);
      assert.equal(ph.s, pd.s);
      // Same box relative to the frame (the preset boxes scale with k).
      const b = { x: ph.x0 - 20, y: ph.y0 - 10, w: 300, h: 60 }, bd = { x: pd.x0 - 10, y: pd.y0 - 5, w: 150, h: 30 };
      const BH = placeBox(ph, b), BD = placeBox(pd, bd);
      assert.ok(Math.abs(BH.x / hd.width - BD.x / dr.width) < 1e-9 && Math.abs(BH.w / hd.width - BD.w / dr.width) < 1e-9);
    }
  }
});

// ---------------- renderer ----------------

test("34. the renderer applies placements: moved overlays shift and scale as a whole, others stay; the preset draws exactly as before", () => {
  const base = record(model());
  // An explicit override equal to the preset anchor is not a move: the draw calls are identical.
  const m0 = model();
  const p = placement(m0.layout, {}, "title", 1080, 1920);
  assert.deepEqual(record(model("portrait", "hd", { overlayLayout: { title: { x: p.x0 / 1080, y: p.y0 / 1920, scale: 1 } } })), base);

  const moved = record(model("portrait", "hd", { overlayLayout: { title: { x: 0.25, y: 0.5, scale: 1.5 } } }));
  const byText = (log, s) => log.text.find((x) => x.s === s);
  const a = byText(base, "LIGHTNING REPLAY"), b = byText(moved, "LIGHTNING REPLAY");
  // Anchor (title top-left) at (270, 960); text keeps its offset from the anchor, ×1.5.
  assert.ok(Math.abs(b.l - (270 + (a.l - p.x0) * 1.5)) < 1e-6 && Math.abs(b.y - (960 + (a.y - p.y0) * 1.5)) < 1e-6);
  assert.ok(Math.abs(b.size - a.size * 1.5) < 1e-9, "typography scales with the group");
  // The counter, chart and clock are untouched.
  for (const s of ["STRIKES", "LAST 10 MIN", "strikes / 2.5 min"]) assert.deepEqual(byText(moved, s), byText(base, s));
  // Chart values: same bars (relative heights) wherever the chart sits.
  const bars = (log) => log.rects.filter((r) => r[3] > 0 && r[2] < 20).map((r) => r[3]);
  const chart = record(model("portrait", "hd", { overlayLayout: { activity: { x: 0.5, y: 0.6, scale: 0.5 } } }));
  const r0 = bars(base), r1 = bars(chart).slice(0, r0.length);
  assert.ok(r0.length > 20);
  for (let i = 0; i < r0.length; i++) assert.ok(Math.abs(r1[i] / r0[i] - (r1[0] / r0[0])) < 1e-9, "bar heights keep their proportions");
});

test("35. layout and shading never touch events, counts, projection, camera or the prepared map", () => {
  const a = model("portrait", "hd");
  const b = model("portrait", "hd", { overlayLayout: { counter: { x: 0.5, y: 0.5, scale: 1.4, locked: true }, activity: { y: 0.6 } }, hudShading: 0 });
  assert.deepEqual(b.events.map((e) => [e.x, e.y, e.v]), a.events.map((e) => [e.x, e.y, e.v]));
  assert.deepEqual([b.camera, b.extent, b.totalEvents, b.countAt(7), b.timeMap.leadIn], [a.camera, a.extent, a.totalEvents, a.countAt(7), a.timeMap.leadIn]);
  // The basemap prepared for the frame still fits: a layout edit needs no map re-bake.
  const meta = { width: 540, height: 960, pixelRatio: 2, camera: a.camera };
  assert.equal(basemapMismatch(meta, b), null);
});

test("36. HUD shading: off draws no backing but keeps every overlay; subtle halves it; Hide all stays clean with a custom layout", () => {
  for (const f of FORMATS) {
    const std = record(model(f));
    const off = record(model(f, "hd", { hudShading: 0 }));
    const sub = record(model(f, "hd", { hudShading: 0.5 }));
    assert.equal(std.gradients.length, 2, `${f}: two bands by default`);
    assert.equal(off.gradients.length, 0, `${f}: off = no gradients`);
    assert.deepEqual(off.text.map((x) => x.s), std.text.map((x) => x.s), `${f}: off keeps all text`);
    for (let i = 0; i < 2; i++) sub.gradients[i].stops.forEach((a, j) => assert.ok(Math.abs(a - std.gradients[i].stops[j] / 2) < 1e-3, `${f}: subtle = half`));
    // Lighter than the preset → a halo keeps text legible (portrait always has one).
    assert.ok(off.text.every((x) => x.shadow > 0), `${f}: halo with shading off`);
    assert.equal(std.text.every((x) => x.shadow > 0), f === "portrait", `${f}: preset halo only in portrait`);
    const clean = record(model(f, "hd", { overlays: noOverlays(), overlayLayout: { title: { x: 0.5, y: 0.5 }, counter: { x: 0.1, y: 0.3 } }, hudShading: 1 }));
    assert.deepEqual([clean.text.length, clean.gradients.length, clean.shadowRects], [0, 0, 0], `${f}: Hide all is clean`);
  }
  assert.deepEqual([shadingPreset(0), shadingPreset(0.5), shadingPreset(1), shadingPreset(0.7)], ["off", "subtle", "standard", "custom"]);
});

test("37. backing follows moved overlays: a band only while an overlay sits in it, a soft local backing mid-frame", () => {
  // Everything at the top except the counter, which moves to the middle of the frame.
  const only = { ...noOverlays(), title: true, counter: true };
  const log = record(model("portrait", "hd", { overlays: only, overlayLayout: { counter: { x: 0.1, y: 0.5 } } }));
  assert.equal(log.gradients.length, 1, "the bottom band is gone: nothing visible sits in it");
  assert.equal(log.gradients[0].y0, 0, "the title's top band stays");
  assert.equal(log.shadowRects, 1, "one feathered local backing behind the counter");
  // Moved within its own band: the band stays, no local backing.
  const near = record(model("portrait", "hd", { overlays: only, overlayLayout: { counter: { x: 0.2, y: 0.82 } } }));
  assert.deepEqual([near.gradients.length, near.shadowRects], [2, 0]);
});

test("38. overlay geometry: measured from the renderer, every overlay in every format, hidden ones too", () => {
  for (const f of FORMATS) for (const q of ["hd", "draft"]) {
    const m = model(f, q, { overlays: { ...defaultOverlays(), legend: false } });
    const { width: W, height: H } = m.settings;
    const g = overlayGeometry(measureCtx(), m, 12);
    assert.deepEqual(Object.keys(g).sort(), [...IDS].sort());
    for (const id of IDS) {
      const b = g[id].box;
      assert.ok(b && b.w > 0 && b.h > 0, `${f}/${q} ${id} has a box`);
      assert.ok(b.x >= -1 && b.y >= -1 && b.x + b.w <= W + 1 && b.y + b.h <= H + 1, `${f}/${q} ${id} inside the frame`);
    }
    assert.equal(g.legend.visible, false, "hidden overlays are measured but not visible");
    // A moved overlay's box is its preset box mapped through the placement.
    const m2 = model(f, q, { overlayLayout: { clock: { x: 0.6, y: 0.4, scale: 0.8 } } });
    const g2 = overlayGeometry(measureCtx(), m2, 12);
    assert.deepEqual(g2.clock.box, placeBox(g2.clock.placement, g.clock.base));
  }
  // The synthetic notice only exists for fictional data.
  const real = parseDataset(JSON.stringify({ meta: { name: "x" }, events: [{ id: "a", timestamp: "2026-11-01T14:00:00Z", lat: 39.9, lon: 32.8 }, { id: "b", timestamp: "2026-11-01T15:00:00Z", lat: 39.95, lon: 32.85 }] }), "r.json");
  const g = overlayGeometry(measureCtx(), buildReplay(real, { quality: "draft" }, { mapImage: MAP }), 1);
  assert.equal(g.syntheticNotice.box, null);
});

test("39. preview/export parity: the composition carries the exact layout and shading the preview draws", () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-layout-comp-"));
  try {
    const overlayLayout = { activity: { x: 0.5, y: 0.93, scale: 1.2, locked: true }, title: { x: 0.1, y: 0.2 } };
    const settings = { format: "portrait", quality: "draft", overlayLayout, hudShading: 0.5 };
    const { model: m } = buildComposition({ text: SAMPLE, filename: "s.json", settings, outDir: dir });
    const input = JSON.parse(readFileSync(join(dir, "replay-input.js"), "utf8").replace(/^window\.__REPLAY_INPUT = /, "").replace(/;\s*$/, ""));
    assert.deepEqual(input.settings.overlayLayout, overlayLayout);
    assert.equal(input.settings.hudShading, 0.5);
    // The composition rebuilds the model from those settings: same draw calls as the preview model.
    const rebuilt = buildReplay(parseDataset(SAMPLE, "s.json"), input.settings, input.geo);
    const preview = buildReplay(sample, settings, input.geo);
    assert.deepEqual(record(rebuilt), record(preview));
    assert.deepEqual(record(m), record(preview));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- editor geometry ----------------

test("40. coordinates: CSS preview px ↔ output px at any preview size and quality", () => {
  for (const [W, H] of [[1080, 1920], [540, 960], [1920, 1080]]) for (const cssW of [300, 640]) {
    const rect = { left: 100, top: 50, width: cssW, height: (cssW * H) / W };
    const [x, y] = toOutput(100 + cssW / 2, 50 + rect.height / 4, rect, W, H);
    assert.ok(Math.abs(x - W / 2) < 1e-9 && Math.abs(y - H / 4) < 1e-9);
    assert.ok(Math.abs(outputPerCss(rect, W) - W / cssW) < 1e-12);
    const c = toCss({ x: W / 4, y: H / 2, w: W / 10, h: H / 20 }, rect, W);
    assert.ok(Math.abs(c.x - cssW / 4) < 1e-9 && Math.abs(c.w - cssW / 10) < 1e-9 && Math.abs(c.y - rect.height / 2) < 1e-9);
  }
});

test("41. dragging: the grab offset is kept, the box stays in the frame, Draft and Full HD land on the same relative place", () => {
  const box = { x: 100, y: 1500, w: 400, h: 120 };
  const r = dragBox(box, [37, -21], null, { x: [], y: [] }, { capture: 20, release: 40 }, true, 1080, 1920);
  assert.deepEqual([r.box.x, r.box.y], [137, 1479], "moves by the pointer delta, no centring on the cursor");
  const edge = dragBox(box, [5000, 900], null, { x: [], y: [] }, { capture: 20, release: 40 }, false, 1080, 1920);
  assert.deepEqual([edge.box.x, edge.box.y], [680, 1800], "clamped to the frame");
  assert.deepEqual(clampBox({ x: -5, y: 0, w: 2000, h: 10 }, 1080, 1920).x, 0, "a box wider than the frame aligns to its start");
  // Same CSS drag on a Draft and a Full HD frame shown at the same preview size → same relative result.
  const rect = { left: 0, top: 0, width: 300, height: 533.33 };
  for (const [W, H] of [[1080, 1920], [540, 960]]) {
    const [x0, y0] = toOutput(150, 400, rect, W, H), [x1, y1] = toOutput(180, 420, rect, W, H);
    const k = W / 1080;
    const out = dragBox({ x: 100 * k, y: 1400 * k, w: 300 * k, h: 100 * k }, [x1 - x0, y1 - y0], null, { x: [], y: [] }, { capture: 1, release: 2 }, false, W, H);
    assert.ok(Math.abs(out.box.x / W - (100 + 108) / 1080) < 1e-6);
  }
  // From box to placement and back to a normalized override.
  const m = model("portrait", "hd");
  const g = overlayGeometry(measureCtx(), m, 12).counter;
  const target = { ...g.box, x: g.box.x + 50, y: g.box.y - 300 };
  const p = moveTo(g.placement, g.base, target);
  const ov = overrideOf(p, 1080, 1920);
  const again = placeBox(placement(m.layout, { counter: ov }, "counter", 1080, 1920), g.base);
  assert.ok(Math.abs(again.x - target.x) < 1e-9 && Math.abs(again.y - target.y) < 1e-9);
});

test("42. snapping: capture, hysteresis, release without jumps or drift, quiet zone, competing targets, off", () => {
  const th = { capture: 6, release: 10 };
  const centre = { v: 540, edge: "center", kind: "center", major: true, rank: 0 };
  const T = [centre];
  const size = 200; // box centre = start + 100
  let st = freeAxis();
  const at = (start) => { const r = snapAxis(st, start, size, T, th); st = r.state; return r.pos; };
  assert.equal(at(430), 430, "far: free");
  assert.equal(at(435), 440, "within 6: captured (centre on 540)");
  assert.equal(at(447), 440, "held within the release distance");
  assert.equal(at(450), 440, "still held at exactly 10");
  assert.equal(at(451), 451, "released: back to the unsnapped position, no accumulated offset");
  assert.equal(at(446), 446, "quiet zone: no immediate re-capture within one capture distance of the release");
  assert.equal(at(444), 440, "moving back beyond it captures again");
  // Moving straight on through a target: positions stay monotonic and end exactly at the pointer.
  st = freeAxis();
  const seq = [];
  for (let s = 420; s <= 470; s++) seq.push(at(s));
  assert.ok(seq.every((v, i) => !i || v >= seq[i - 1]), "never jumps backwards");
  assert.equal(seq.at(-1), 470);
  // Competing targets: nearer wins; equal distance goes to the more important target, deterministically.
  const quarter = { v: 548, edge: "center", kind: "quarter", rank: 3 };
  const ov = { v: 437, edge: "start", kind: "overlay", rank: 4 };
  assert.equal(snapAxis(freeAxis(), 443, size, [quarter, centre], th).state.held, centre, "centre is nearer (3 vs 5)");
  assert.equal(snapAxis(freeAxis(), 444, size, [quarter, centre], th).state.held, centre, "4 vs 4: centre outranks quarter");
  assert.equal(snapAxis(freeAxis(), 444, size, [centre, quarter], th).state.held, centre, "order of targets does not matter");
  assert.equal(snapAxis(freeAxis(), 441, size, [ov], th).state.held, null, "overlay edges capture from a shorter distance");
  assert.equal(snapAxis(freeAxis(), 440, size, [ov], th).state.held, ov);
  // Snapping off (toggle or Shift): the box follows the pointer exactly.
  const targets = { x: T, y: [] };
  const on = dragBox({ x: 400, y: 0, w: 200, h: 50 }, [37, 0], null, targets, th, true, 1080, 1920);
  const off = dragBox({ x: 400, y: 0, w: 200, h: 50 }, [37, 0], null, targets, th, false, 1080, 1920);
  assert.deepEqual([on.box.x, on.axes.x.held?.kind, off.box.x, off.axes.x.held], [440, "center", 437, null]);
});

test("43. snap targets: frame centre, quarters, margins, portrait safe areas and other overlays", () => {
  const P = layoutFor(1080, 1920), Lh = layoutFor(1920, 1080);
  const tp = snapTargets(P, 1080, 1920, [{ id: "clock", x: 700, y: 180, w: 300, h: 120 }]);
  assert.ok(tp.y.some((t) => t.kind === "safe" && t.v === 180 && t.edge === "start"));
  assert.ok(tp.y.some((t) => t.kind === "safe" && t.v === 1920 - 260 && t.edge === "end"));
  assert.ok(tp.x.some((t) => t.major && t.v === 540) && tp.y.some((t) => t.major && t.v === 960));
  assert.deepEqual(tp.x.filter((t) => t.kind === "quarter").map((t) => t.v), [270, 810]);
  assert.deepEqual(tp.x.filter((t) => t.kind === "overlay").map((t) => [t.edge, t.v]), [["start", 700], ["center", 850], ["end", 1000]]);
  const tl = snapTargets(Lh, 1920, 1080);
  assert.ok(!tl.y.some((t) => t.kind === "safe"), "landscape has no platform safe areas");
  assert.deepEqual(tl.x.filter((t) => t.kind === "margin").map((t) => t.v), [48, 1872]);
});

test("44. scaling, corner resize and arrow nudges stay in the frame and keep the right point fixed", () => {
  const m = model("portrait", "hd");
  const g = overlayGeometry(measureCtx(), m, 12).activity;
  const { placement: p, base } = g;
  // Scale about the anchor (bottom centre of the chart): the anchor stays.
  const s = scaleAbout(p, base, 0.6, [p.x, p.y], 1080, 1920);
  assert.deepEqual([s.s, s.x, s.y], [0.6, p.x, p.y]);
  const ck = overlayGeometry(measureCtx(), m, 12).clock;
  assert.equal(scaleAbout(ck.placement, ck.base, 9, [ck.placement.x, ck.placement.y], 1080, 1920).s, SCALE_MAX);
  assert.equal(scaleAbout(p, base, 0.01, [p.x, p.y], 1080, 1920).s, SCALE_MIN);
  // The full-width portrait chart can only grow until it spans the frame, and stays inside it.
  const bigP = scaleAbout(p, base, 1.5, [p.x, p.y], 1080, 1920), big = placeBox(bigP, base);
  assert.ok(Math.abs(bigP.s - 1080 / base.w) < 1e-9, `limited to the frame width (${bigP.s})`);
  assert.ok(big.x >= -1e-9 && big.x + big.w <= 1080 + 1e-9 && big.y + big.h <= 1920 + 1e-9);
  // A small overlay near an edge is pushed back inside after growing.
  const c = overlayGeometry(measureCtx(), m, 12).clock;
  const cb = placeBox(scaleAbout(c.placement, c.base, 1.5, [c.placement.x, c.placement.y], 1080, 1920), c.base);
  assert.ok(cb.x + cb.w <= 1080 + 1e-9 && cb.y >= -1e-9);
  // Corner resize: the opposite corner stays put.
  const b = placeBox(p, base);
  const small = resizeFromCorner(p, base, "se", [b.x + b.w * 0.7, b.y + b.h * 0.7], 1080, 1920);
  const sb = placeBox(small, base);
  assert.ok(Math.abs(small.s - 0.7) < 0.011);
  assert.ok(Math.abs(sb.x - b.x) < 1e-6 && Math.abs(sb.y - b.y) < 1e-6, "top-left fixed when dragging the bottom-right corner");
  const nw = resizeFromCorner(p, base, "nw", [b.x + b.w * 0.5, b.y + b.h * 0.5], 1080, 1920);
  const nb = placeBox(nw, base);
  assert.ok(Math.abs(nb.x + nb.w - (b.x + b.w)) < 1e-6 && Math.abs(nb.y + nb.h - (b.y + b.h)) < 1e-6, "bottom-right fixed when dragging the top-left corner");
  const huge = placeBox(resizeFromCorner(p, base, "se", [5000, 5000], 1080, 1920), base);
  assert.ok(huge.x + huge.w <= 1080 + 1e-6 && huge.y + huge.h <= 1920 + 1e-6, "resize is limited by the frame");
  // Nudges: exact steps, clamped at the edges.
  const n = placeBox(nudge(p, base, 2, -2, 1080, 1920), base);
  assert.ok(Math.abs(n.x - b.x - 2) < 1e-9 && Math.abs(n.y - b.y + 2) < 1e-9);
  const far = placeBox(nudge(p, base, -9999, 9999, 1080, 1920), base);
  assert.ok(Math.abs(far.x) < 1e-9 && Math.abs(far.y + far.h - 1920) < 1e-9);
});

test("45. per-format layout store: isolation, lock, reset selected / reset layout, Hide all keeps positions", () => {
  const store = createLayoutStore();
  store.set("portrait", "activity", { x: 0.5, y: 0.9, scale: 1.2 });
  store.set("square", "clock", { x: 0.7, y: 0.2 });
  assert.deepEqual(store.get("landscape"), {}, "other formats untouched");
  assert.deepEqual(store.get("portrait"), { activity: { x: 0.5, y: 0.9, scale: 1.2 } });
  assert.deepEqual(store.get("square"), { clock: { x: 0.7, y: 0.2 } });
  // Lock is per overlay and survives Reset selected (it is about editing, not placement).
  store.set("portrait", "activity", { locked: true });
  store.set("portrait", "counter", { y: 0.5 });
  assert.equal(store.isLocked("portrait", "activity"), true);
  assert.equal(store.isLocked("portrait", "counter"), false);
  assert.equal(store.isLocked("square", "activity"), false);
  store.reset("portrait", "activity");
  assert.deepEqual(store.get("portrait").activity, { locked: true });
  store.set("portrait", "activity", { locked: false });
  assert.equal(store.get("portrait").activity, undefined, "unlocking an unmoved overlay leaves no entry");
  store.replace("portrait", "counter", null);
  assert.equal(store.get("portrait").counter, undefined);
  store.set("portrait", "legend", { x: 0.4 });
  store.resetAll("portrait");
  assert.deepEqual([store.get("portrait"), store.get("square")], [{}, { clock: { x: 0.7, y: 0.2 } }], "Reset layout only clears the current format");
  // Hide all is a visibility change: it renders nothing, and the layout is still there afterwards.
  const layout = { counter: { x: 0.5, y: 0.5 } };
  const hidden = model("portrait", "hd", { overlays: noOverlays(), overlayLayout: layout });
  assert.deepEqual(hidden.settings.overlayLayout, layout);
  assert.equal(record(hidden).text.length, 0);
  assert.ok(SNAP.release > SNAP.capture, "release distance is wider than capture (hysteresis)");
});
