// 6. MP4 duration, frame rate and resolution match the requested settings.
// Renders a short draft clip through HyperFrames (~30 s), and checks demo.mp4 when present.
//   npm run test:render
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
