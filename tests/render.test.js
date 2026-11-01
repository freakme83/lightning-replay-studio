// 6. MP4 duration, frame rate and resolution match the requested settings; 6c checks map alignment in the MP4.
// Renders a short draft clip through HyperFrames (~30 s), and checks demo.mp4 when present.
//   npm run test:render
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildComposition, ROOT } from "../src/export/composition.js";
import { renderComposition, probeVideo, checkVideo } from "../src/export/render.js";

test("6a. a short custom-duration render matches the request", { timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-render-"));
  try {
    const out = join(dir, "short.mp4");
    const text = readFileSync(join(ROOT, "data", "sample-istanbul-squall.csv"), "utf8");
    const { model } = buildComposition({ text, filename: "sample-istanbul-squall.csv", settings: { duration: 4 }, outDir: join(dir, "comp") });
    await renderComposition({ dir: join(dir, "comp"), output: out, fps: 24, quality: "draft" });
    const probe = probeVideo(out);
    assert.deepEqual(checkVideo(probe, model.settings), []);
    assert.equal(probe.frames, 96);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6b. demo.mp4 is 960×540, 24 fps, 20 s H.264", { skip: !existsSync(join(ROOT, "demo.mp4")) }, () => {
  const probe = probeVideo(join(ROOT, "demo.mp4"));
  assert.deepEqual(checkVideo(probe, { duration: 20, fps: 24, width: 960, height: 540 }), []);
});

test("6c. exported MP4: basemap features and strikes stay geographically aligned", { timeout: 300000 }, async (t) => {
  const { renderBasemap } = await import("../src/map/render-basemap.js");
  const { markerStyle, isMagenta, centroid, decodeRgb } = await import("./helpers.js");
  const { frameProjection } = await import("../src/core/projection.js");
  const dir = mkdtempSync(join(tmpdir(), "lr-maprender-"));
  try {
    // Three cloud-to-ground strikes at known places; a basemap with a ring at each of them.
    const known = [[32.8541, 39.9208], [32.55, 39.80], [33.15, 40.05]];
    const text = JSON.stringify(known.map(([lon, lat], i) => ({ id: `k${i}`, timestamp: `2026-11-01T14:${String(i * 10).padStart(2, "0")}:00+03:00`, lat, lon, type: "CG" })));
    const frame = frameProjection({ west: 32.2, south: 39.55, east: 33.5, north: 40.3 }, 960, 540).extentOf({ x: 0, y: 0, w: 960, h: 540 });
    const settings = { duration: 3, trailMinutes: 120, frame, quality: "draft" };
    const mapImage = await renderBasemap({ frame, width: 960, height: 540, pixelRatio: 1, style: markerStyle(known) });
    const { model } = buildComposition({ text, filename: "known.json", settings, outDir: join(dir, "comp"), mapImage });
    const out = join(dir, "aligned.mp4");
    await renderComposition({ dir: join(dir, "comp"), output: out, fps: 24, quality: "draft" });
    assert.deepEqual(checkVideo(probeVideo(out), model.settings), []);
    // Last frame: every strike shows its residual marker, every ring is on the basemap.
    execFileSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.1", "-i", out, "-frames:v", "1", join(dir, "last.png")]);
    const img = decodeRgb(join(dir, "last.png"));
    const isMarker = (r, g, b) => r > 190 && g > 110 && g < 200 && b < 150; // residual CG marker (orange)
    for (const e of model.events) {
      const ring = centroid(img, e.x, e.y, 22, isMagenta);
      const dot = centroid(img, e.x, e.y, 8, isMarker);
      assert.ok(ring && dot, `${e.id}: ring ${!!ring}, marker ${!!dot}`);
      t.diagnostic(`${e.id}: ring ${Math.hypot(ring[0] - e.x, ring[1] - e.y).toFixed(2)} px, strike marker ${Math.hypot(dot[0] - e.x, dot[1] - e.y).toFixed(2)} px from the projected coordinate`);
      assert.ok(Math.hypot(ring[0] - e.x, ring[1] - e.y) < 1, `${e.id}: basemap ring at ${ring}, expected ${e.x},${e.y}`);
      assert.ok(Math.hypot(dot[0] - e.x, dot[1] - e.y) < 1, `${e.id}: strike marker at ${dot}, expected ${e.x},${e.y}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6d. exported MP4 shows exactly the selected map layers", { timeout: 300000 }, async () => {
  const { renderBasemap } = await import("../src/map/render-basemap.js");
  const { layerStyle, decodeRgb, pixel } = await import("./helpers.js");
  const { frameProjection, cameraOf } = await import("../src/core/projection.js");
  const dir = mkdtempSync(join(tmpdir(), "lr-layerrender-"));
  try {
    const text = JSON.stringify([
      { id: "a", timestamp: "2026-11-01T14:00:00+03:00", lat: 39.9, lon: 32.8, type: "IC" },
      { id: "b", timestamp: "2026-11-01T14:30:00+03:00", lat: 39.95, lon: 32.9, type: "IC" },
    ]);
    const frame = frameProjection({ west: 32.2, south: 39.55, east: 33.5, north: 40.3 }, 960, 540).extentOf({ x: 0, y: 0, w: 960, h: 540 });
    const cam = cameraOf(frameProjection(frame, 960, 540), 960, 540);
    // Non-default layers: water off, parks at 50 %, boundaries hidden.
    const layers = { water: { visible: false }, land: { opacity: 0.5 }, boundaries: { visible: false } };
    const mapImage = await renderBasemap({ frame, width: 960, height: 540, pixelRatio: 1, style: layerStyle(cam.lon), layers });
    const { model } = buildComposition({ text, filename: "layers.json", settings: { duration: 2, frame, quality: "draft" }, outDir: join(dir, "comp"), mapImage });
    const out = join(dir, "layers.mp4");
    await renderComposition({ dir: join(dir, "comp"), output: out, fps: 24, quality: "draft" });
    assert.deepEqual(checkVideo(probeVideo(out), model.settings), []);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.1", "-i", out, "-frames:v", "1", join(dir, "last.png")]);
    const img = decodeRgb(join(dir, "last.png"));
    // Left half (sea) is the plain background, right half (park) is half-strength green; no border line.
    const left = pixel(img, 960 * 0.2, 270), right = pixel(img, 960 * 0.8, 270), mid = pixel(img, 480, 160);
    assert.ok(left[2] < 40, `sea hidden, got ${left}`);
    assert.ok(right[1] > 90 && right[1] < 160, `park at ~50 %, got ${right}`);
    assert.ok(mid[0] < 40 && mid[2] < 40, `boundary hidden, got ${mid}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6e. exported MP4: clean frame with all overlays off, mixed overlays, credits kept with the file", { timeout: 300000 }, async () => {
  const { renderBasemap } = await import("../src/map/render-basemap.js");
  const { layerStyle, decodeRgb, pixel } = await import("./helpers.js");
  const { frameProjection, cameraOf } = await import("../src/core/projection.js");
  const { noOverlays, defaultOverlays, attributionLines } = await import("../src/core/overlays.js");
  const dir = mkdtempSync(join(tmpdir(), "lr-overlayrender-"));
  try {
    const text = JSON.stringify([
      { id: "a", timestamp: "2026-11-01T14:00:00+03:00", lat: 39.9, lon: 32.8, type: "IC" },
      { id: "b", timestamp: "2026-11-01T14:30:00+03:00", lat: 39.95, lon: 32.9, type: "IC" },
    ]);
    const frame = frameProjection({ west: 32.2, south: 39.55, east: 33.5, north: 40.3 }, 960, 540).extentOf({ x: 0, y: 0, w: 960, h: 540 });
    const cam = cameraOf(frameProjection(frame, 960, 540), 960, 540);
    // Left half of the map is solid blue "water", so any HUD band or text over it is easy to see.
    const mapImage = await renderBasemap({ frame, width: 960, height: 540, pixelRatio: 1, style: layerStyle(cam.lon), layers: { land: { visible: false }, boundaries: { visible: false } } });
    const lastFrame = async (name, overlays) => {
      const { model } = buildComposition({ text, filename: "o.json", settings: { duration: 2, frame, overlays, quality: "draft" }, outDir: join(dir, name), mapImage });
      const out = join(dir, `${name}.mp4`);
      await renderComposition({ dir: join(dir, name), output: out, fps: 24, quality: "draft" });
      assert.deepEqual(checkVideo(probeVideo(out), model.settings), []);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.1", "-i", out, "-frames:v", "1", join(dir, `${name}.png`)]);
      return { img: decodeRgb(join(dir, `${name}.png`)), out };
    };
    const isBlue = (p) => p[2] > 200 && p[0] < 40 && p[1] < 40;
    // Probe points inside the top band (title / clock area) and the bottom band (counter area), over the blue half.
    const top = [[60, 20], [200, 40], [120, 60]], bottom = [[60, 480], [120, 500], [60, 515]];
    const clean = await lastFrame("clean", noOverlays());
    for (const [x, y] of [...top, ...bottom]) assert.ok(isBlue(pixel(clean.img, x, y)), `clean frame shows the bare map at ${x},${y}: ${pixel(clean.img, x, y)}`);
    const full = await lastFrame("full", defaultOverlays());
    assert.ok(top.every(([x, y]) => !isBlue(pixel(full.img, x, y))) && bottom.every(([x, y]) => !isBlue(pixel(full.img, x, y))), "default overlays darken both bands");
    // Mixed: top overlays off, bottom ones on.
    const mixed = await lastFrame("mixed", { ...noOverlays(), counter: true, activity: true });
    assert.ok(top.every(([x, y]) => isBlue(pixel(mixed.img, x, y))), "top band absent");
    assert.ok(bottom.every(([x, y]) => !isBlue(pixel(mixed.img, x, y))), "bottom band present");
    // Credits travel with the file when they are not in the frame.
    const { tagCredits } = await import("../src/export/render.js");
    const credits = attributionLines({ mapAttribution: mapImage.meta.attribution, meta: {} }).join("\n");
    const before = probeVideo(clean.out);
    tagCredits(clean.out, credits);
    const after = probeVideo(clean.out);
    assert.deepEqual([after.frames, after.width, after.height, after.codec], [before.frames, before.width, before.height, before.codec]);
    assert.match(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=comment", "-of", "csv=p=0", clean.out]).toString(), /OpenFreeMap/);
    assert.match(readFileSync(clean.out.replace(/\.mp4$/, ".credits.txt"), "utf8"), /OpenStreetMap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6f. Full HD MP4 in all three formats: size, fps, frames, H.264 profile, strike alignment, clean Hide all", { timeout: 900000 }, async (t) => {
  const { renderBasemap } = await import("../src/map/render-basemap.js");
  const { markerStyle, isMagenta, centroid, decodeRgb, layerStyle } = await import("./helpers.js");
  const { outputSize, designViewport, QUALITIES } = await import("../src/core/format.js");
  const { frameProjection, cameraOf } = await import("../src/core/projection.js");
  const { fitFrame } = await import("../src/core/replay.js");
  const { parseDataset } = await import("../src/core/parse.js");
  const { noOverlays, defaultOverlays } = await import("../src/core/overlays.js");
  const dir = mkdtempSync(join(tmpdir(), "lr-fullhd-"));
  const known = [[32.8541, 39.9208], [32.55, 39.80], [33.15, 40.05]];
  const text = JSON.stringify(known.map(([lon, lat], i) => ({ id: `k${i}`, timestamp: `2026-11-01T14:${String(i * 10).padStart(2, "0")}:00+03:00`, lat, lon, type: "CG" })));
  const events = parseDataset(text, "known.json").events;
  const lastFrame = (video, png) => execFileSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.1", "-i", video, "-frames:v", "1", png]);
  try {
    for (const format of ["landscape", "portrait", "square"]) {
      const { width: W, height: H } = outputSize(format, "hd");
      const vp = designViewport(W, H);
      const frame = fitFrame(events, W, H);
      const encode = QUALITIES.hd.encode;

      // (a) Strikes and basemap features land on the same output pixels in the MP4.
      const ringMap = await renderBasemap({ frame, width: vp.width, height: vp.height, pixelRatio: vp.k, style: markerStyle(known) });
      assert.deepEqual(ringMap.meta.output, [W, H], `${format}: the basemap is baked at the output size`);
      const a = buildComposition({ text, filename: "known.json", settings: { duration: 3, trailMinutes: 120, frame, format, quality: "hd" }, outDir: join(dir, `${format}-a`), mapImage: ringMap });
      const outA = join(dir, `${format}-a.mp4`);
      await renderComposition({ dir: join(dir, `${format}-a`), output: outA, fps: 24, quality: encode });
      const probe = probeVideo(outA);
      assert.deepEqual(checkVideo(probe, a.model.settings), [], `${format}: ffprobe matches the request`);
      assert.deepEqual([probe.width, probe.height, probe.frames, probe.fps], [W, H, 72, 24]);
      assert.equal(probe.pixFmt, "yuv420p");
      assert.match(probe.profile, /^(High|Main)$/, "broadly compatible H.264 profile");
      const level = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=level", "-of", "csv=p=0", outA]).toString());
      assert.ok(level <= 42, `H.264 level ${level / 10}`);
      lastFrame(outA, join(dir, `${format}-a.png`));
      const img = decodeRgb(join(dir, `${format}-a.png`));
      assert.deepEqual([img.width, img.height], [W, H], "decoded frames have the output size");
      const isMarker = (r, g, b) => r > 190 && g > 110 && g < 200 && b < 150;
      for (const e of a.model.events) {
        const ring = centroid(img, e.x, e.y, 44, isMagenta), dot = centroid(img, e.x, e.y, 16, isMarker);
        assert.ok(ring && dot, `${format} ${e.id}: ring ${!!ring}, marker ${!!dot}`);
        t.diagnostic(`${format} ${W}×${H} ${e.id}: basemap ring ${Math.hypot(ring[0] - e.x, ring[1] - e.y).toFixed(2)} px, strike marker ${Math.hypot(dot[0] - e.x, dot[1] - e.y).toFixed(2)} px from the projected coordinate`);
        assert.ok(Math.hypot(ring[0] - e.x, ring[1] - e.y) < 1, `${format} ${e.id}: ring offset`);
        // The marker's centroid comes from a thresholded, partly faded disc, so allow 1.5 output px (0.75 design px).
        assert.ok(Math.hypot(dot[0] - e.x, dot[1] - e.y) < 1.5, `${format} ${e.id}: marker offset`);
      }

      // (b) Hide all gives the bare map in the HUD bands; the default overlays do not.
      const cam = cameraOf(frameProjection(frame, vp.width, vp.height), vp.width, vp.height);
      const blue = await renderBasemap({ frame, width: vp.width, height: vp.height, pixelRatio: vp.k, style: layerStyle(cam.lon + 5), layers: { land: { visible: false }, boundaries: { visible: false } } });
      const bands = async (name, overlays) => {
        const built = buildComposition({ text, filename: "o.json", settings: { duration: 2, frame, format, quality: "hd", overlays }, outDir: join(dir, `${format}-${name}`), mapImage: blue });
        const out = join(dir, `${format}-${name}.mp4`);
        await renderComposition({ dir: join(dir, `${format}-${name}`), output: out, fps: 24, quality: "draft" });
        lastFrame(out, join(dir, `${format}-${name}.png`));
        const im = decodeRgb(join(dir, `${format}-${name}.png`));
        const L = built.model.layout, k = L.k;
        // Left third of the frame is the plain blue map; count pixels that differ from it inside each band.
        const dev = (y0, y1) => {
          let n = 0, worst = 0;
          const ref = [0, 0, (im.data[(Math.round(H / 2) * W + Math.round(W * 0.1)) * 3 + 2])];
          for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(W * 0.03); x < Math.round(W * 0.33); x++) {
            const i = (y * W + x) * 3, d = Math.max(Math.abs(im.data[i] - ref[0]), Math.abs(im.data[i + 1] - ref[1]), Math.abs(im.data[i + 2] - ref[2]));
            worst = Math.max(worst, d);
            if (d > 40) n++;
          }
          return { n, worst };
        };
        return { top: dev(0, L.bands.top * k), bottom: dev(H - L.bands.bottom * k, H) };
      };
      const clean = await bands("clean", noOverlays()), full = await bands("full", defaultOverlays());
      t.diagnostic(`${format}: pixels differing from the bare map in the HUD bands — Hide all top ${clean.top.n} / bottom ${clean.bottom.n}; all overlays top ${full.top.n} / bottom ${full.bottom.n}`);
      assert.equal(clean.top.n + clean.bottom.n, 0, `${format}: Hide all leaves nothing but the map in the bands (worst diff ${Math.max(clean.top.worst, clean.bottom.worst)})`);
      assert.ok(full.top.n > 500 && full.bottom.n > 500, `${format}: the default overlays are drawn in both bands`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
