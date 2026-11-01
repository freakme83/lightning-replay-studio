# Experiment C: Lightning Replay Studio v1 (report)

**Date:** 2026-11-01 · **Model:** Claude Opus 5.5 (high reasoning) · **Machine:** Apple M4, 16 GB, macOS 15.6

## Outcome

All seven completion criteria pass and were verified directly:

| # | Criterion | Evidence |
| - | --- | --- |
| 1 | Sample dataset loads | Loaded in the app (JSON and CSV), plus `tests/core.test.js` #2 |
| 2 | Correct location and chronological order | Tests #1–#4. Positions come from lat/lon through Web Mercator, nothing is placed in screen pixels. |
| 3 | Interactive time-compressed replay | Play, scrub, frame-step, previous/next strike and click-to-seek were used in the browser pane |
| 4 | Output duration can be changed | UI export at 8 s gave 8.00 s / 192 frames. Test #6a renders 4 s / 96 frames. |
| 5 | Complete MP4 generated locally | `demo.mp4`, rendered by local HyperFrames with system Chrome |
| 6 | Video inspected and verified | `contact-sheet.png` (decoded frames), full-resolution frame review, ffprobe below |
| 7 | Reusable with another dataset | The İstanbul squall CSV (different region, UTC timestamps, no intensity) loads, previews and renders with no code changes |

ffprobe output for `demo.mp4`:

```
codec_name=h264  profile=High  pix_fmt=yuv420p
width=960  height=540  r_frame_rate=24/1  nb_frames=480
duration=20.000000  size=1126576 (1.1 MB)
```

## HyperFrames capabilities actually used

- **Composition contract.** A root `index.html` with `data-composition-id`, `data-duration`, `data-width`/`height` and
  `data-fps`, and one paused GSAP timeline registered as `window.__timelines["main"]` *after* the async setup
  (font loading).
- **Seekable, deterministic rendering.** The whole frame is one `<canvas>` drawn by a pure function of time. It is
  driven both by a linear GSAP proxy tween (`onUpdate`) and by the `hf-seek` event, the canvas protocol described in
  `references/runtimes.md`. There is no `Date.now()`, no randomness, no timers and no rAF in the composition.
- **CLI:** `lint` and `check --json` (0 errors), `snapshot --at …` for inspecting representative moments,
  and `render --fps 24 --quality draft|looks|delivery --strict` for local MP4 output (H.264, yuv420p).
- `doctor --json` for the environment check.
- **Not used, deliberately:** registry blocks (none fit a data-driven geo canvas), media-use (no media assets were needed;
  sound effects were skipped, see below), cloud, lambda and publish (forbidden by the brief), and the HyperFrames Studio editor.

## Architecture decisions

1. **One drawing pipeline for preview and export.** `src/core/` (parse → buildReplay → drawFrame) is plain ES
   modules with no dependencies. The browser preview imports them directly. The export copies the same files
   *byte-identically* into the generated HyperFrames project, and that project embeds the **raw dataset text** and the
   normalised settings, so Chrome re-parses and rebuilds the model exactly as the preview does. Test #5 checks the file
   hashes and the equality of per-event times and positions.
2. **Canvas 2D rather than DOM/SVG elements per strike.** It scales to large datasets with a binary search over the
   time-sorted events, and every frame is independent of the previous one, which suits HyperFrames' seek-per-frame model.
   The trade-off is that the scene is one canvas, so the HyperFrames editor cannot edit individual strikes.
3. **Linear time transform with fixed holds.** Strike times map linearly into
   `[leadIn, duration − tail]` (1.2 s and 1.8 s). There is no easing and no re-timing, so quiet and busy periods
   look the way they do because of the data itself. Strike *visuals* (flash 0.1 s, halo, 0.7 s expo-out ring, spring-settled residual)
   run in video time. Trail persistence is set in *storm minutes* and converted with the same rate.
4. **Geography.** Web Mercator is conformal, so north is up and local east and north scales are equal. Test #3 checks a
   5 km square to within 1 %. Bounds are fitted with a uniform scale (no aspect distortion), and the scale bar comes
   from metres per pixel. The basemap is **Natural Earth 1:50m** coastlines and country borders, bundled offline from
   the `world-atlas` npm package. Ankara is inland, so that view shows only a labelled coordinate grid plus approximate
   reference places (±1 km, labelled "places approx."). No roads, provinces or coastlines were invented.
5. **Local server.** A small `node:http` server bound to `127.0.0.1`. It runs one export at a time and spawns the
   locally installed, pinned `hyperframes` binary. There is no framework and no build step.
6. **Bundled fonts** (Inter and JetBrains Mono, from @fontsource, latin + latin-ext for Turkish characters), loaded explicitly
   before the first frame in both the preview and the export, so text metrics match.

## Synthetic data

`scripts/generate-sample.js` uses the mulberry32 PRNG with seed `20261101`, so output is byte-identical on every run.
It produces 200 strikes in the 14:00–17:00 (+03:00) window from three moving Gaussian storm cells with triangular
activity profiles (A: south-west → city, B: after a lull around 15:10–15:30, south of Gölbaşı → north-east;
C: short-lived, east), plus 14 isolated strikes. One pair of strikes is deliberately given the same timestamp. The dataset
is labelled `synthetic: true` with a description stating that it is fictional, and the "SYNTHETIC DATA · FICTIONAL STORM ·
NOT REAL DETECTIONS" badge is drawn into every frame. A second, smaller fictional İstanbul dataset exists to test reuse.

## Validation phase: the three most significant defects

From the draft render's contact sheet and a full-resolution frame review:

1. **Weak spatial reference.** Ankara is inland, so the 1:50m basemap draws nothing there, and the coordinate grid was
   nearly invisible (7 % alpha). Fix: grid at 13 % alpha, with brighter labels.
2. **Inconsistent strike-type encoding.** The legend said CG = orange, but after the 0.1 s flash CG markers
   turned turquoise, so the two types could no longer be told apart. Fix: residual CG markers are now soft-orange filled
   dots, IC markers are turquoise rings, and unknown types are turquoise filled dots. The legend now lists only the types present.
3. **Small, low-contrast HUD text** (7.5–8.5 px grey) that would smear in H.264. Fix: a minimum of about 9 px and higher contrast.

An earlier pass, before the first preview render, had already shrunk the over-large pulse rings and added the faint
storm footprint, so that cell movement is readable.

One improvement pass was applied, then the final render was made. There were no further polish loops.

## Tools and versions

| Tool | Version |
| --- | --- |
| HyperFrames CLI | 0.8.226 (pinned as a devDependency) |
| Node.js / npm | 25.6.1 / 11.9.0 |
| FFmpeg / FFprobe | 8.0.1 (Homebrew) |
| Google Chrome (render browser) | 156.0.8078.74 |
| gsap | 3.13.0 (local copy, no CDN) |
| world-atlas / topojson-client | 2.0.2 / 3.1.0 (build-time only) |
| @fontsource/inter, @fontsource/jetbrains-mono | 5.2.6 |
| HyperFrames skills | hyperframes, hyperframes-cli, hyperframes-registry, media-use (from `skills-lock.json`, all read) |

## Measured times

| Task | Time |
| --- | --- |
| Total session, from environment inspection (≈17:15) to final verified render (17:34), plus docs | ≈25 min |
| `demo.mp4`, 20 s at delivery quality | 6.2 s render, 7.2 s end-to-end including build and ffprobe |
| Draft preview render, 20 s | 6.3 s |
| UI export, 8 s draft | 4 s |
| Test suite, including the 4 s render | about 5–20 s |

## Known limitations

- There is **no real basemap detail for inland areas**: no roads, provinces or terrain, because none of these are
  available offline without external services. Place markers are approximate and limited to a Türkiye list in
  `basemap/places.json`. Other regions show only coastlines, country borders and the grid.
- **Antimeridian-crossing datasets** are not supported by the projection. Polar latitudes are clamped to ±85.05°.
- **Lakes and islands inside land polygons** at 1:50m are drawn as land. Only outer rings are filled.
- **Canvas-only scene.** The HyperFrames editor can play the composition but cannot edit individual strikes.
  `hyperframes check` reports a `dead_stretch` warning because it cannot see canvas changes; the snapshots and the
  decoded video confirm the frames do change.
- **Time-range inputs** must be ISO strings with an offset. There is no date picker.
- **Output size** in the UI is fixed at 960×540 at 24 fps. Other sizes are available from the CLI only.
- **Very large datasets** (more than about 100k strikes) are untested. The preview event table renders every row.
- Mixed UTC offsets are displayed in a single offset (the most common one), with a warning.

## Features not completed

- **Optional synthesized sound effects were not implemented.** The brief made them optional, and the work went into data
  correctness and visual fidelity instead. The video is silent, and HyperFrames' `film_silent` warning was knowingly accepted.
- There is no in-app editor for reference places, and no per-dataset gazetteer field beyond the bundled list.
