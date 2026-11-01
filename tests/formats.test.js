// Video formats and Full HD: presets, adaptive framing, geographic correctness, basemap resolution and
// cache identity, responsive overlay layout (non-overlap, safe areas, Hide all) in all three formats.
//   node --test tests/formats.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDataset } from "../src/core/parse.js";
import { buildReplay, fitFrame, mapRect, normalizeSettings, DEFAULTS } from "../src/core/replay.js";
import { drawFrame } from "../src/core/draw.js";
import { FORMATS, QUALITIES, outputSize, formatOfSize, presetOfSize, designViewport, describeSize } from "../src/core/format.js";
import { layoutFor } from "../src/core/layout.js";
import { containFrame, frameFromCamera, frameProjection, mercX, mercY } from "../src/core/projection.js";
import { defaultOverlays, noOverlays, OVERLAYS, zoneVisible } from "../src/core/overlays.js";
import { basemapMismatch, buildComposition, ROOT } from "../src/export/composition.js";
import { renderBasemap } from "../src/map/render-basemap.js";
import { centroid, decodeRgb, isMagenta, markerStyle } from "./helpers.js";

const SAMPLE = readFileSync(join(ROOT, "data", "sample-ankara-storm.json"), "utf8");
const sample = parseDataset(SAMPLE, "sample-ankara-storm.json");
const FORMAT_IDS = Object.keys(FORMATS);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (±${tol})`);
const MAP = { image: {}, attribution: "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors" };

test("24. presets: Full HD and Draft sizes, aspect ratios, validation, defaults", () => {
  assert.deepEqual(outputSize("landscape", "hd"), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize("portrait", "hd"), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize("square", "hd"), { width: 1080, height: 1080 });
  assert.deepEqual(outputSize("landscape", "draft"), { width: 960, height: 540 });
  assert.deepEqual(outputSize("portrait", "draft"), { width: 540, height: 960 });
  assert.deepEqual(outputSize("square", "draft"), { width: 540, height: 540 });
  const ratio = { landscape: 16 / 9, portrait: 9 / 16, square: 1 };
  for (const f of FORMAT_IDS) for (const q of Object.keys(QUALITIES)) {
    const { width, height } = outputSize(f, q);
    close(width / height, ratio[f], 1e-12, `${f}/${q} aspect`);
    assert.equal(width % 2 + height % 2, 0, "even dimensions (yuv420p)");
    assert.equal(formatOfSize(width, height), f);
    assert.deepEqual(presetOfSize(width, height), { format: f, quality: q });
  }
  assert.equal(describeSize("portrait", "hd"), "1080 × 1920 · 9:16 · Full HD");
  assert.throws(() => outputSize("cinema", "hd"), /Unknown video format/);
  assert.throws(() => outputSize("landscape", "4k"), /Unknown video quality/);

  // Aspect ratio and quality are separate settings; the default is landscape Full HD.
  const d = normalizeSettings({});
  assert.deepEqual([d.format, d.quality, d.width, d.height], ["landscape", "hd", 1920, 1080]);
  for (const f of FORMAT_IDS) for (const q of Object.keys(QUALITIES)) {
    const s = normalizeSettings({ format: f, quality: q });
    assert.deepEqual([s.width, s.height], Object.values(outputSize(f, q)));
  }
  assert.equal(normalizeSettings({ format: "portrait" }).quality, "hd", "changing the format keeps the default quality");
  assert.equal(normalizeSettings({ quality: "draft" }).format, "landscape", "changing the quality keeps the format");
  // An explicit size (CLI --width/--height) is honoured, and recognised when it is a preset.
  assert.deepEqual(pick(normalizeSettings({ width: 960, height: 540 })), ["landscape", "draft", 960, 540]);
  assert.deepEqual(pick(normalizeSettings({ width: 1280, height: 720 })), ["landscape", "custom", 1280, 720]);
  assert.deepEqual(pick(normalizeSettings({ width: 1080, height: 1350 })), ["portrait", "custom", 1080, 1350]);
  assert.throws(() => normalizeSettings({ width: 1000 }), /both width and height/);
  assert.throws(() => normalizeSettings({ format: "wide" }), /Unknown video format/);
  assert.throws(() => normalizeSettings({ quality: "ultra" }), /Unknown video quality/);
  assert.equal(DEFAULTS.width, null, "the size is derived, not stored in the defaults");
  // Re-normalising a normalised settings object (the composition does this in Chrome) is stable.
  for (const f of FORMAT_IDS) { const once = normalizeSettings({ format: f }); assert.deepEqual(normalizeSettings(once), once); }
  // Draft and Full HD of one format share the design viewport (and so the map detail).
  for (const f of FORMAT_IDS) {
    const a = designViewport(...Object.values(outputSize(f, "draft"))), b = designViewport(...Object.values(outputSize(f, "hd")));
    assert.deepEqual([a.width, a.height], [b.width, b.height]);
    assert.equal(b.k, 2 * a.k);
  }
  assert.deepEqual(["landscape", "portrait", "square"].map((f) => { const v = designViewport(...Object.values(outputSize(f, "hd"))); return [v.width, v.height]; }), [[960, 540], [540, 960], [540, 540]]);
});
const pick = (s) => [s.format, s.quality, s.width, s.height];

test("25. framing per format: Fit to Data respects the HUD, Hide all uses the frame, pan/zoom/lock behave", () => {
  for (const f of FORMAT_IDS) {
    const { width: W, height: H } = outputSize(f, "hd");
    const frame = fitFrame(sample.events, W, H);
    // The frame has the output's shape: equal metres per pixel east and north (no stretching).
    close((mercX(frame.east) - mercX(frame.west)) / (mercY(frame.south) - mercY(frame.north)), W / H, 1e-9, `${f} frame aspect`);
    // Every strike sits inside the HUD-free map area of that layout.
    const m = buildReplay(sample, { format: f, frame });
    const r = mapRect(W, H);
    for (const e of m.events) assert.ok(e.x >= r.x - 1e-6 && e.x <= r.x + r.w + 1e-6 && e.y >= r.y - 1e-6 && e.y <= r.y + r.h + 1e-6, `${f} ${e.id} inside the HUD-free area`);
    // Fit to Data through buildReplay (no frame) and through fitFrame agree.
    const auto = buildReplay(sample, { format: f });
    auto.events.forEach((e, i) => { close(e.x, m.events[i].x, 1e-6); close(e.y, m.events[i].y, 1e-6); });
    // Hiding every overlay frees the HUD area: the fit may use (almost) the whole frame.
    const bare = mapRect(W, H, noOverlays()), full = mapRect(W, H, defaultOverlays());
    assert.ok(bare.h >= full.h && bare.w >= full.w - 1e-9, `${f} Hide all frees map area`);
    assert.ok(fitFrame(sample.events, W, H, noOverlays()).north - fitFrame(sample.events, W, H, noOverlays()).south <= frame.north - frame.south + 1e-9, `${f} tighter fit without HUD`);
    // Only the visible band counts: top-only overlays keep the bottom edge margin and vice versa.
    const topOnly = mapRect(W, H, { ...noOverlays(), clock: true }), botOnly = mapRect(W, H, { ...noOverlays(), counter: true });
    assert.ok(topOnly.y > bare.y - 1e-9 && close(topOnly.y + topOnly.h, bare.y + bare.h, 1e-9, `${f} bottom unchanged`) === undefined);
    assert.ok(botOnly.y + botOnly.h < bare.y + bare.h + 1e-9);
    // Pan and zoom in design pixels act the same in every format (camera ↔ frame is exact).
    const cam = m.camera, { k } = m.layout;
    const world = 512 * Math.pow(2, cam.zoom);
    const vp = designViewport(W, H);
    const panned = buildReplay(sample, { format: f, frame: frameFromCamera({ ...cam, lon: cam.lon + (60 / world) * 360 }, vp.width, vp.height) });
    panned.events.forEach((e, i) => { close(e.x, m.events[i].x - 60 * k, 1e-6, `${f} pan x`); close(e.y, m.events[i].y, 1e-6, `${f} pan y`); });
    const zoomed = buildReplay(sample, { format: f, frame: frameFromCamera({ ...cam, zoom: cam.zoom + 1 }, vp.width, vp.height) });
    zoomed.events.forEach((e, i) => { close(e.x - W / 2, 2 * (m.events[i].x - W / 2), 1e-5, `${f} zoom x`); close(e.y - H / 2, 2 * (m.events[i].y - H / 2), 1e-5, `${f} zoom y`); });
    // Lock Frame is just the settings value; rebuilding from it reproduces the camera.
    assert.deepEqual(buildReplay(sample, { format: f, frame: { ...frame } }).camera, m.camera);
  }
});

test("26. changing format keeps the centre and the old view; strikes stay geographically exact and unstretched", () => {
  const L = outputSize("landscape", "hd");
  const frame = fitFrame(sample.events, L.width, L.height);
  const centre = { lon: (frame.west + frame.east) / 2, y: (mercY(frame.north) + mercY(frame.south)) / 2 };
  for (const f of ["portrait", "square", "landscape"]) {
    const { width: W, height: H } = outputSize(f, "hd");
    const next = containFrame(frame, W, H);
    // Same centre; everything that was in view still is.
    close((next.west + next.east) / 2, centre.lon, 1e-9, `${f} centre lon`);
    close((mercY(next.north) + mercY(next.south)) / 2, centre.y, 1e-12, `${f} centre lat`);
    assert.ok(next.west <= frame.west + 1e-9 && next.east >= frame.east - 1e-9 && next.north >= frame.north - 1e-9 && next.south <= frame.south + 1e-9, `${f} contains the old frame`);
    close((mercX(next.east) - mercX(next.west)) / (mercY(next.south) - mercY(next.north)), W / H, 1e-9, `${f} aspect`);
    // The axis that is not limiting is exactly as wide as before (nothing was cropped or stretched).
    const wFrac = (mercX(next.east) - mercX(next.west)) / (mercX(frame.east) - mercX(frame.west));
    const hFrac = (mercY(next.south) - mercY(next.north)) / (mercY(frame.south) - mercY(frame.north));
    close(Math.min(wFrac, hFrac), 1, 1e-9, `${f} one axis is exactly kept`);
  }

  // Every format places each strike at its geographic coordinate (inverse projection round trip),
  // with the same east/north scale. Distance *ratios* between strikes are therefore identical
  // across formats: a portrait frame is a different window on the same map, never a stretched crop.
  const pts = sample.events.slice(0, 40);
  const models = FORMAT_IDS.map((f) => buildReplay(sample, { format: f, frame: containFrame(frame, ...Object.values(outputSize(f, "hd"))) }));
  for (const m of models) {
    m.events.slice(0, 40).forEach((e, i) => {
      const [lon, lat] = m.proj.unproject(e.x, e.y);
      close(lon, pts[i].lon, 1e-9, `${m.settings.format} lon`);
      close(lat, pts[i].lat, 1e-9, `${m.settings.format} lat`);
    });
    // Isotropy: 1 km east and 1 km north are the same number of pixels.
    const [lon0, lat0] = [32.85, 39.92];
    const dLat = 1 / 111.195, dLon = dLat / Math.cos((lat0 * Math.PI) / 180);
    const [x0, y0] = m.proj.project(lon0, lat0), [xe, ye] = m.proj.project(lon0 + dLon, lat0), [xn, yn] = m.proj.project(lon0, lat0 + dLat);
    close(Math.hypot(xe - x0, ye - y0) / Math.hypot(xn - x0, yn - y0), 1, 1e-3, `${m.settings.format} isotropic`);
    close(m.proj.metersPerPixel(lat0) * Math.hypot(xe - x0, ye - y0) / 1000, 1, 2e-3, `${m.settings.format} 1 km`);
  }
  const d = (m, a, b) => Math.hypot(m.events[a].x - m.events[b].x, m.events[a].y - m.events[b].y);
  const [ref, ...rest] = models;
  for (const m of rest) for (const [a, b, c] of [[0, 10, 20], [3, 77, 150]]) close(d(m, a, b) / d(m, a, c), d(ref, a, b) / d(ref, a, c), 1e-9, `${m.settings.format} distance ratio`);

  // Draft and Full HD are the same picture at two pixel densities: exactly 2× apart.
  for (const f of FORMAT_IDS) {
    const fr = containFrame(frame, ...Object.values(outputSize(f, "hd")));
    const hd = buildReplay(sample, { format: f, quality: "hd", frame: fr }), dr = buildReplay(sample, { format: f, quality: "draft", frame: fr });
    hd.events.forEach((e, i) => { close(e.x, 2 * dr.events[i].x, 1e-6, `${f} x`); close(e.y, 2 * dr.events[i].y, 1e-6, `${f} y`); });
    assert.deepEqual(hd.camera, dr.camera, `${f}: Draft and Full HD share the design camera`);
    for (const key of ["west", "south", "east", "north"]) close(hd.extent[key], dr.extent[key], 1e-9, `${f} extent ${key}`);
  }
});

// ---- overlay layout: a recording 2D context with a real (if simple) text box model ----

/** Everything drawFrame draws, with text boxes in output pixels (monospace-ish 0.62 em advance). */
function layoutRecord(m, t = 12) {
  const log = { boxes: [], bands: [], strokeRects: [], images: 0, arcs: 0 };
  let st = { tx: 0, ty: 0, sx: 1, size: 10, align: "left" };
  const stack = [];
  const target = { font: "", textAlign: "left", textBaseline: "alphabetic" };
  const ctx = new Proxy(target, {
    get: (o, k) => {
      // save/restore cover the transform and the text state, like a real canvas.
      if (k === "save") return () => stack.push({ st: { ...st }, text: { font: o.font, textAlign: o.textAlign, textBaseline: o.textBaseline, fillStyle: o.fillStyle } });
      if (k === "restore") return () => { const top = stack.pop(); st = top.st; Object.assign(o, top.text); };
      if (k === "translate") return (x, y) => { st.tx += x * st.sx; st.ty += y * st.sx; };
      if (k === "scale") return (a) => { st.sx *= a; };
      if (k === "measureText") return (s) => ({ width: String(s).length * fontSize(o.font) * advance(o.font) });
      if (k === "createLinearGradient") return (x0, y0, x1, y1) => { const g = { y0, y1, addColorStop() {} }; log.bands.push(g); return g; };
      if (k === "createRadialGradient") return () => ({ addColorStop() {} });
      if (k === "fillRect") return (x, y, w, h) => { const g = o.fillStyle; if (g?.y1 !== undefined) g.rect = [x, y, w, h]; };
      if (k === "fillText") return (s, x, y) => {
        const size = fontSize(o.font) * st.sx, w = String(s).length * size * advance(o.font);
        const left = o.textAlign === "right" ? x * st.sx + st.tx - w : o.textAlign === "center" ? x * st.sx + st.tx - w / 2 : x * st.sx + st.tx;
        const base = y * st.sx + st.ty;
        const [up, down] = o.textBaseline === "middle" ? [0.5, 0.5] : [0.8, 0.2]; // glyph extent above / below y
        log.boxes.push({ s: String(s), l: left, r: left + w, t: base - size * up, b: base + size * down, size });
      };
      if (k === "strokeRect") return (x, y, w, h) => log.strokeRects.push({ l: x, t: y, r: x + w, b: y + h });
      if (k === "drawImage") return () => { log.images++; };
      if (k === "arc") return () => { log.arcs++; };
      if (k in o) return o[k];
      return () => {};
    },
    set: (o, k, v) => { o[k] = v; if (k === "textAlign") st.align = v; return true; },
  });
  drawFrame(ctx, m, t);
  log.bands = log.bands.filter((g) => g.rect);
  return log;
}
const fontSize = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
const advance = (font) => (/Inter/.test(font) ? 0.56 : 0.62); // average glyph advance in em: Inter / JetBrains Mono
const overlaps = (a, b, pad = 0) => a.l < b.r + pad && b.l < a.r + pad && a.t < b.b + pad && b.t < a.b + pad;

const groupOf = (s, name) =>
  /^LIGHTNING REPLAY$/.test(s) || s === name || (s.endsWith("…") && name.startsWith(s.slice(0, -1))) || /storm → /.test(s) ? "title"
  : /^LOCAL TIME|^\d\d:\d\d:\d\d$|^\d{4}-\d\d-\d\d$/.test(s) ? "clock"
  : /^SYNTHETIC/.test(s) ? "syntheticNotice"
  : /OpenFreeMap/.test(s) ? "attribution"
  : /^STRIKES$|^LAST 10 MIN$|^\d+$|^ \/ \d+$/.test(s) ? "counter"
  : /^cloud-to-ground$|^intracloud$|^unclassified$|^trail \d+ min$/.test(s) ? "legend"
  : /^\d+ ?(km|m)$/.test(s) ? "scaleBar"
  : /^strikes \/ |^\d\d:\d\d$/.test(s) ? "activity"
  : "other";

test("27. overlay layout: no text overlaps, all text sits on a HUD band, portrait respects the safe areas", () => {
  for (const f of FORMAT_IDS) for (const q of ["hd", "draft"]) {
    const { width: W, height: H } = outputSize(f, q);
    const frame = fitFrame(sample.events, W, H);
    const m = buildReplay(sample, { format: f, quality: q, frame }, { mapImage: MAP });
    const L = m.layout, k = L.k;
    for (const t of [0.5, 6, 12, 19]) {
      const log = layoutRecord(m, t);
      const name = m.meta.name;
      const boxes = log.boxes.map((b) => ({ ...b, g: groupOf(b.s, name) }));
      assert.ok(boxes.every((b) => b.g !== "other"), `${f}/${q}: unexpected text ${boxes.filter((b) => b.g === "other").map((b) => b.s)}`);
      assert.equal(new Set(boxes.map((b) => b.g)).size, OVERLAYS.length, `${f}/${q}: every overlay drew something`);
      // 1. Inside the frame, and on a band (text always has its backing gradient behind it).
      const top = L.bands.top * k, bottom = H - L.bands.bottom * k;
      for (const b of boxes) {
        assert.ok(b.l >= 0 && b.r <= W && b.t >= 0 && b.b <= H, `${f}/${q}: "${b.s}" inside the frame (${b.l | 0}..${b.r | 0}, ${b.t | 0}..${b.b | 0})`);
        assert.ok(b.b <= top + 1 || b.t >= bottom - 1, `${f}/${q}: "${b.s}" sits on a HUD band`);
      }
      // 2. No two texts of different overlays overlap, with a little air.
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[i].g === boxes[j].g) continue;
        assert.ok(!overlaps(boxes[i], boxes[j], 1), `${f}/${q} t=${t}: "${boxes[i].s}" (${boxes[i].g}) collides with "${boxes[j].s}" (${boxes[j].g})`);
      }
      // 3. Same-overlay texts: only the activity chart's own caption may touch its ticks; others stay apart.
      // 4. Readability: nothing smaller than 9 design units (18 px at Full HD).
      for (const b of boxes) assert.ok(b.size >= 8.4 * k * (f === "landscape" ? 1 : 1.05), `${f}/${q}: "${b.s}" is ${b.size.toFixed(1)} px`);
      // 5. Portrait: no HUD text inside the platform's top / bottom interface areas.
      if (f === "portrait") for (const b of boxes) assert.ok(b.t >= L.safe.top * k - 1 && b.b <= H - L.safe.bottom * k + 1, `portrait "${b.s}" is inside the safe area (t ${b.t}, b ${b.b}, limits ${L.safe.top * k}..${H - L.safe.bottom * k}, ${W}x${H})`);
      // The synthetic notice frame belongs to the notice, inside the frame and clear of the other title rows.
      for (const r of log.strokeRects) assert.ok(r.l >= 0 && r.r <= W && r.b <= top + 1, `${f}/${q} notice box`);
    }
  }
});

test("28. portrait and square are laid out for their shape, landscape is the classic HUD", () => {
  const sizes = Object.fromEntries(FORMAT_IDS.map((f) => [f, layoutFor(...Object.values(outputSize(f, "hd")))]));
  // Landscape: exactly the v1 coordinates (in design units).
  const l = sizes.landscape;
  assert.deepEqual([l.k, l.Wu, l.Hu, l.bands.top, l.bands.bottom], [2, 960, 540, 100, 92]);
  assert.deepEqual([l.title.label.y, l.title.name.y, l.title.summary.y, l.clock.time.y, l.activity.x0, l.activity.x1, l.scaleBar.x, l.legend.x], [30, 52, 68, 56, 196, 936, 24, 600]);
  assert.deepEqual([l.fit.top, l.fit.bottom, l.fit.side], [98, 104, 40]);
  // Portrait: tall, stacked, safe areas reserved; the activity chart spans the width (not squeezed beside the counter).
  const p = sizes.portrait;
  assert.deepEqual([p.Wu, p.Hu, p.k], [540, 960, 2]);
  assert.ok(p.safe.top >= 85 && p.safe.bottom >= 120, "platform UI areas reserved (≈9 % top, ≈13 % bottom)");
  assert.ok(p.title.label.y > p.safe.top && p.attribution.y < p.Hu - p.safe.bottom + 1);
  assert.ok(p.activity.x1 - p.activity.x0 > 0.8 * p.Wu && p.counter.value.y < p.activity.top, "counter stacks above a full-width chart");
  assert.ok(p.counter.value.size > 22 && p.title.name.size > 17, "larger type for a phone screen");
  assert.equal(p.zone.attribution, "bottom", "credit line stays below the title block in portrait");
  // Square: compact bands, map dominant.
  const s = sizes.square;
  const area = (a) => 1 - (a.fit.top + a.fit.bottom) / a.Hu;
  assert.ok(area(s) > 0.55, `square keeps ${(area(s) * 100) | 0} % of the height for the map`);
  assert.ok(area(l) > 0.62);
  assert.ok(area(p) > 0.4, `portrait HUD-free height ${(area(p) * 100) | 0} %`);
  // Margins stay inside the layout on every format.
  for (const a of Object.values(sizes)) assert.ok(a.fit.top + a.fit.bottom < a.Hu * 0.65 && a.bands.top + a.bands.bottom < a.Hu * 0.7);
});

test("28b. portrait backing is a light, eased scrim around the text, not a dark footer; landscape and square keep the classic bands", () => {
  // Backing gradients as drawn: [offset, alpha] stops in output pixels, plus the halo state while the HUD draws.
  const record = (m) => {
    const grads = [], halos = new Set();
    const ctx = new Proxy({}, {
      get: (o, key) => {
        if (key === "createLinearGradient") return (x0, y0, x1, y1) => { const g = { y0, y1, stops: [], addColorStop: (f, c) => g.stops.push([y0 + f * (y1 - y0), Number(/,\s*([\d.]+)\)$/.exec(c)[1])]) }; grads.push(g); return g; };
        if (key === "measureText") return (s) => ({ width: String(s).length * 6 });
        if (key === "fillText") return () => halos.add(o.shadowBlur ?? 0);
        if (key in o) return o[key];
        return () => ({ addColorStop() {} });
      },
      set: (o, key, v) => { o[key] = v; return true; },
    });
    drawFrame(ctx, m, 12);
    return { grads, halos };
  };
  const { width: W, height: H } = outputSize("portrait", "hd");
  const m = buildReplay(sample, { format: "portrait", frame: fitFrame(sample.events, W, H) }, { mapImage: MAP });
  const L = m.layout, k = L.k;
  const { grads, halos } = record(m);
  assert.equal(grads.length, 2);
  const [top, bottom] = grads;
  const alphaAt = (g, y) => { const s = g.stops; for (let i = 1; i < s.length; i++) if (y <= s[i][0]) return s[i - 1][1] + ((y - s[i - 1][0]) / (s[i][0] - s[i - 1][0] || 1)) * (s[i][1] - s[i - 1][1]); return s.at(-1)[1]; };
  // The map stays visible behind the lower cluster: a moderate tint at most, nothing like the old ≥ 0.9 footer.
  assert.ok(Math.max(...bottom.stops.map((s) => s[1])) <= 0.55, "lower scrim peak");
  assert.ok(Math.max(...top.stops.map((s) => s[1])) <= 0.55, "upper scrim peak");
  // It eases out over the empty platform area instead of darkening it.
  assert.ok(alphaAt(bottom, H - 1) <= 0.2, `bottom edge alpha ${alphaAt(bottom, H - 1)}`);
  assert.ok(alphaAt(bottom, H - (L.safe.bottom / 2) * k) < alphaAt(bottom, H - L.safe.bottom * k), "lighter below the HUD than behind it");
  // No visible start edge: the tint starts at zero and rises in small, smooth steps.
  assert.equal(bottom.stops[0][1], 0);
  assert.equal(top.stops.at(-1)[1], 0);
  for (const g of [top, bottom]) for (let i = 1; i < g.stops.length; i++) assert.ok(Math.abs(g.stops[i][1] - g.stops[i - 1][1]) <= 0.08, "eased stops");
  // Text keeps a local halo instead of relying on the backing.
  assert.ok([...halos].every((b) => b > 0), "every HUD text has a halo");
  // Landscape and square: unchanged classic bands, no halo.
  for (const f of ["landscape", "square"]) {
    const s = outputSize(f, "hd");
    const r = record(buildReplay(sample, { format: f, frame: fitFrame(sample.events, s.width, s.height) }, { mapImage: MAP }));
    assert.deepEqual(r.grads.map((g) => g.stops.map((x) => x[1])), [[0.92, 0], [0, 0.9, 0.96]], `${f} bands`);
    assert.deepEqual([...r.halos], [0], `${f}: no halo`);
  }
});

test("29. Hide all: a completely clean frame in every format and quality; one overlay at a time stays on its own band", () => {
  for (const f of FORMAT_IDS) for (const q of ["hd", "draft"]) {
    const { width: W, height: H } = outputSize(f, q);
    const frame = fitFrame(sample.events, W, H);
    const clean = layoutRecord(buildReplay(sample, { format: f, quality: q, frame, overlays: noOverlays() }, { mapImage: MAP }));
    assert.deepEqual(clean.boxes, [], `${f}/${q}: no text`);
    assert.equal(clean.bands.length, 0, `${f}/${q}: no gradient bands`);
    assert.equal(clean.strokeRects.length, 0, `${f}/${q}: no badge frame`);
    assert.equal(clean.images, 1, "the map is still drawn");
    assert.ok(clean.arcs > 0, "the lightning is still drawn");
    // Each overlay alone: a band exists exactly where the layout says its text sits.
    const L = layoutFor(W, H);
    for (const o of OVERLAYS) {
      const m = buildReplay(sample, { format: f, quality: q, frame, overlays: { ...noOverlays(), [o.id]: true } }, { mapImage: MAP });
      const log = layoutRecord(m);
      const zone = L.zone[o.id];
      assert.equal(zoneVisible({ ...noOverlays(), [o.id]: true }, zone, L), true);
      assert.equal(log.bands.length, 1, `${f}/${q} ${o.id}: exactly one band`);
      const band = log.bands[0], onTop = band.y0 === 0 && band.y1 > 0 && band.rect[1] === 0;
      assert.equal(onTop, zone === "top", `${f}/${q} ${o.id}: band on the ${zone}`);
      for (const b of log.boxes) assert.ok(zone === "top" ? b.b <= L.bands.top * L.k + 1 : b.t >= H - L.bands.bottom * L.k - 1, `${f}/${q} ${o.id}: "${b.s}" is on its band`);
    }
  }
});

test("30. the basemap is baked at the output size; cache identity covers size, format, layers and provider", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-fmt-"));
  const cacheDir = join(dir, "cache");
  try {
    const known = [[32.8541, 39.9208], [32.4, 39.7], [33.3, 40.15]];
    const style = markerStyle(known);
    const bake = async (format, quality, extra = {}) => {
      const { width: W, height: H } = outputSize(format, quality);
      const frame = containFrame(fitFrame(sample.events, 1920, 1080), W, H);
      const vp = designViewport(W, H);
      const r = await renderBasemap({ frame, width: vp.width, height: vp.height, pixelRatio: vp.k, style, probes: known, cacheDir, ...extra });
      return { ...r, W, H, frame };
    };
    const ids = new Set();
    for (const f of FORMAT_IDS) for (const q of ["hd", "draft"]) {
      const r = await bake(f, q);
      assert.deepEqual(r.meta.output, [r.W, r.H], `${f}/${q} meta.output`);
      const file = join(dir, `${f}-${q}.png`);
      writeFileSync(file, r.png);
      const img = decodeRgb(file);
      assert.deepEqual([img.width, img.height], [r.W, r.H], `${f}/${q}: PNG pixels = output size (no up- or down-scaling)`);
      assert.equal(r.meta.format, f);
      assert.ok(r.meta.alignment.maxErrorPx < 1e-6, `${f}/${q} alignment ${r.meta.alignment.maxErrorPx}`);
      ids.add(r.meta.id);
      // Rings land on the replay's pixels for this format and density, to a fraction of a pixel.
      const model = buildReplay(sample, { format: f, quality: q, frame: r.frame });
      const proj = frameProjection(r.frame, r.W, r.H);
      for (const [lon, lat] of known) {
        const [x, y] = proj.project(lon, lat);
        const c = centroid(img, x, y, 40 * model.layout.k, isMagenta);
        assert.ok(c && c[2] > 50, `${f}/${q}: ring found`);
        // Output pixels; the ring is a 2.5 px stroke, so half a pixel is the raster's own quantisation.
        assert.ok(Math.hypot(c[0] - x, c[1] - y) < 0.75, `${f}/${q}: ring ${Math.hypot(c[0] - x, c[1] - y).toFixed(3)} px from the replay position`);
      }
      // The prepared map is accepted for its own format and quality, refused for any other.
      for (const f2 of FORMAT_IDS) for (const q2 of ["hd", "draft"]) {
        const other = buildReplay(sample, { format: f2, quality: q2, frame: r.frame });
        const problem = basemapMismatch(r.meta, other);
        if (f2 === f && q2 === q) assert.equal(problem, null, `${f}/${q} accepted`);
        else assert.ok(problem, `${f}/${q} map must not be used for ${f2}/${q2}`);
      }
    }
    assert.equal(ids.size, 6, "six different cache identities for three formats × two qualities");
    // Cache: identical request is served from disk, another layer set is a different identity.
    const again = await bake("portrait", "hd");
    assert.equal(again.cached, true);
    const layered = await bake("portrait", "hd", { layers: { roadsMinor: { visible: false } } });
    assert.equal(layered.cached, false);
    assert.notEqual(layered.meta.id, again.meta.id);
    assert.ok(existsSync(join(cacheDir, `${again.meta.id}.png`)));
    // Same frame size in CSS px but another pixel density is not the same map.
    const vp = designViewport(1080, 1920);
    const lo = await renderBasemap({ frame: again.frame, width: vp.width, height: vp.height, pixelRatio: 1, style, cacheDir });
    assert.notEqual(lo.meta.id, again.meta.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("31. the composition declares the selected size and embeds nothing that depends on 960 × 540", () => {
  for (const f of FORMAT_IDS) for (const q of ["hd", "draft"]) {
    const { width: W, height: H } = outputSize(f, q);
    const dir = mkdtempSync(join(tmpdir(), "lr-comp-"));
    try {
      const frame = fitFrame(sample.events, W, H);
      const { model } = buildComposition({ text: SAMPLE, filename: "sample.json", settings: { format: f, quality: q, frame }, outDir: dir });
      const html = readFileSync(join(dir, "index.html"), "utf8");
      assert.match(html, new RegExp(`data-width="${W}"[\\s\\S]*data-height="${H}"`));
      assert.match(html, new RegExp(`<canvas id="replay-canvas" width="${W}" height="${H}"`));
      assert.match(html, new RegExp(`html, body \\{ width: ${W}px; height: ${H}px`));
      const input = JSON.parse(readFileSync(join(dir, "replay-input.js"), "utf8").replace(/^window\.__REPLAY_INPUT = /, "").replace(/;\s*$/, ""));
      // Chrome rebuilds the same model from the embedded (normalised) settings.
      const rebuilt = buildReplay(parseDataset(input.text, input.filename), input.settings, input.geo);
      assert.deepEqual([rebuilt.settings.format, rebuilt.settings.quality, rebuilt.settings.width, rebuilt.settings.height], [f, q, W, H]);
      assert.deepEqual(rebuilt.events.map((e) => [e.x, e.y]), model.events.map((e) => [e.x, e.y]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("27b. stress: a very long title, three strike types and a five-digit count still do not collide", () => {
  const events = Array.from({ length: 12000 }, (_, i) => ({
    id: `e${i}`, timestamp: new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + i * 1500).toISOString(),
    lat: 39.9 + ((i * 7919) % 1000) / 5000, lon: 32.8 + ((i * 104729) % 1000) / 4000, type: ["CG", "IC", "unknown"][i % 3],
  }));
  const ds = parseDataset(JSON.stringify({ meta: { name: "Fictional test storm" }, events }), "big.json");
  assert.ok(ds.ok && ds.events.length === 12000);
  const title = "An exceptionally long storm title that keeps going well past any sensible headline width";
  for (const f of FORMAT_IDS) {
    const { width: W, height: H } = outputSize(f, "hd");
    const frame = fitFrame(ds.events, W, H);
    const m = buildReplay(ds, { format: f, frame, title }, { mapImage: MAP });
    const k = m.layout.k, log = layoutRecord(m, 10);
    const boxes = log.boxes.map((b) => ({ ...b, g: groupOf(b.s, title) }));
    assert.equal(new Set(boxes.map((b) => b.g)).size, OVERLAYS.length - 1, `${f}: every overlay but the notice drew`); // dataset is not synthetic
    const name = boxes.find((b) => b.s.startsWith("An exceptionally")), clock = boxes.find((b) => /^\d\d:\d\d:\d\d$/.test(b.s));
    assert.ok(name.r < clock.l, `${f}: the long title ends before the clock (shrunk, then shortened) instead of running into it`);
    for (const b of boxes) assert.ok(b.l >= 0 && b.r <= W, `${f}: "${b.s}" inside the frame`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
      if (boxes[i].g !== boxes[j].g) assert.ok(!overlaps(boxes[i], boxes[j], 1), `${f}: "${boxes[i].s}" collides with "${boxes[j].s}"`);
    // The legend never extends beyond its slot, however many types it lists.
    const legend = boxes.filter((b) => b.g === "legend");
    assert.ok(legend.every((b) => b.l >= 0 && b.r <= W - 8 * k), `${f}: legend inside the frame`);
    const chart = m.layout.activity, counter = boxes.filter((b) => b.g === "counter");
    assert.ok(counter.every((b) => f === "portrait" || b.r <= chart.x0 * k + 1 || b.b <= chart.top * k - 8 * k), `${f}: the five-digit counter stays clear of the chart`);
  }
});
