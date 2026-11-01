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
    const settings = { duration: 3, trailMinutes: 120, frame };
    const mapImage = await renderBasemap({ frame, width: 960, height: 540, style: markerStyle(known) });
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
