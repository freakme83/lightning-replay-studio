# Lightning Replay Studio v1

A local tool that turns a timestamped lightning-strike dataset (CSV or JSON) into a
geographically accurate, time-compressed storm replay. You can preview it interactively
and export it as an H.264 MP4 through the local [HyperFrames](https://github.com/heygen-com/hyperframes) renderer.

Everything runs on your Mac. There are no API keys, no map tiles, no cloud rendering and no network calls at runtime.

![contact sheet](contact-sheet.png)

`demo.mp4` is a 20 s replay of the bundled **synthetic** Ankara storm. The storm is fictional: 200 strikes over 180 minutes, with no real detections.

---

## Requirements

- macOS with **Node.js 22+** (tested on Node 25.6.1)
- **FFmpeg / FFprobe** (`brew install ffmpeg`)
- **Google Chrome** (HyperFrames drives it headlessly to capture frames)

First time only, in this folder:

```bash
npm install
```

## Start the application

```bash
cd ~/Desktop/AI-Motion-Lab/lightning-replay
npm start
```

Open **http://127.0.0.1:4317**. The server listens on localhost only. Stop it with `Ctrl+C`.

## Use it after restarting the computer

Nothing needs to stay running between sessions. After a restart, open Terminal and run the two lines in
"Start the application" again. Datasets live in `data/`, and exports are written to `exports/`.
If you moved the folder or updated Node, run `npm install` once more.

## Import a new dataset

Click **Load CSV / JSON** in the sidebar, or drop a file onto it. To load one of the files in `data/`, pick it from the
list and click **Load sample**. You can also copy your own files into `data/` so they show up in that list.

**Required fields:** `timestamp`, `lat`, `lon`. **Optional fields:** `id`, `type` (`CG`, `IC` or `unknown`), `intensity`.

```json
[
  { "id": "strike-001", "timestamp": "2026-11-01T15:34:12+03:00", "lat": 39.921, "lon": 32.8541, "type": "CG", "intensity": 0.8 }
]
```

```csv
id,timestamp,lat,lon,type,intensity
strike-001,2026-11-01T15:34:12+03:00,39.9210,32.8541,CG,0.8
```

Accepted input and how it is handled:

- **JSON layout.** Either a plain array, or `{ "meta": {...}, "events": [...] }`. CSV files can carry the same
  metadata as `# key: value` lines above the header.
- **Column names.** Common aliases are accepted: `time`/`datetime`, `latitude`, `lng`/`longitude`, `amplitude`/`peak_current`.
- **Timestamps.** ISO 8601 with `Z` or `±HH:MM`, or epoch seconds/milliseconds. A timestamp with no offset is read as UTC,
  and the app shows a warning.
- **Invalid records.** Bad timestamps, latitudes outside −90…90 and longitudes outside −180…180 are rejected and listed.
  The remaining valid records still load. An empty file, or a file with no valid records, is refused with a message.
- **Ordering.** Events are sorted by time. Ties keep their original file order, and every original record is kept.
- **No deduplication.** Exact repeats (same time and position) are counted and reported but never removed.
- **Display time zone.** Taken from `meta.utcOffset`. If that is missing, the most common offset in the data is used.
- **Intensity.** It only changes marker size. It is used as-is only if `meta.intensityNormalized` is `true` (as in the
  synthetic samples). Otherwise the absolute values are rank-normalised within the dataset, so physical units such as kA
  are never assumed.
- **Observation window.** Optional `meta.windowStart` / `meta.windowEnd` declare the window the data covers
  (for the sample, 14:00–17:00). Without them, the replay runs from the first strike to the last.
- **Synthetic flag.** `meta.synthetic: true` shows a "SYNTHETIC DATA" badge in the app and in every exported frame.

## Select the video duration and other settings

All of these are in the sidebar:

| Control | Meaning |
| --- | --- |
| Video duration (s) | Length of the output video. The storm time maps linearly onto it. |
| Trail duration (storm min) | How long a residual marker stays after each strike, in *dataset* minutes |
| Marker size | Visual scale of the strike markers |
| Keep faint dot for earlier strikes | Leaves a dim dot for every past strike, so the storm's footprint builds up |
| Event time range | Optional start and end (ISO with offset). Strikes outside the range are excluded and counted. |
| Map: N/W/E/S + Apply bounds | Custom geographic bounds |
| Fit map to data | Returns to automatic bounds: every strike plus 12 % padding |

**Time mapping.** A strike at time *T* appears at
`leadIn + (T − start) / (end − start) × (duration − leadIn − tail)`. `leadIn` is 1.2 s and `tail` is 1.8 s; both
shrink for videos under 20 s. This keeps the relative spacing of strikes exact. Strikes that share a timestamp appear on the same frame.

## Preview an event

- Press **Play** or hit `Space` to play. Drag the scrubber to move freely. When paused, the preview snaps to the
  export frame grid (24 fps), so what you see is exactly an exported frame.
- Click any row in the **Strikes** table to jump to the first frame where that strike flashes. A crosshair marks it.
  The crosshair appears in the preview only, not in the export.
- `[` and `]` step to the previous or next strike. `←` and `→` step one frame at a time.
- Use the search box to filter strikes by id, local time or type.

## Export a new MP4

**From the app.** Choose a quality (Draft, Standard or High) and click **Export MP4**. The render runs locally, and a
20 s video takes about 7 s on an M4. The finished file is checked with ffprobe (codec, size, fps, duration, frame count) and
can be played and downloaded in the sidebar. Files are saved to `exports/`.

**From the command line,** using the same pipeline:

```bash
npm run render -- data/sample-ankara-storm.json -o demo.mp4 --duration 20 --quality delivery
```

```bash
npm run render -- my-storm.csv -o exports/my-storm-45s.mp4 --duration 45 --trail 15 --scale 1.2
```

```bash
npm run render -- my-storm.csv -o exports/zoomed.mp4 --bounds 32.6,39.75,33.1,40.05 --start 2026-11-01T15:00:00+03:00
```

Other CLI options: `--fps`, `--width`/`--height` (16:9 recommended), `--title`, `--keep` (keeps the
generated HyperFrames project in `work/`).

To build a contact sheet from any MP4:

```bash
node scripts/contact-sheet.js demo.mp4 contact-sheet.png
```

## Tests

```bash
npm test
```

There are seven focused tests:

1. Timeline positions are correct.
2. Events are sorted chronologically and invalid input is rejected.
3. Geographic projection is consistent.
4. Strikes with the same timestamp appear on the same frame.
5. The preview and the export use identical time mapping.
6. A real 4 s HyperFrames render, plus `demo.mp4`, match the requested duration, fps and size.

## Project layout

```
app/                 interactive preview (HTML/CSS/JS, no build step)
src/core/            parse.js · timeline.js · projection.js · replay.js · draw.js
                     shared by the preview AND the exported video (copied byte-identical)
src/export/          composition.js (writes the HyperFrames project) · render.js (render + ffprobe)
server.js            local server: static files + /api/export
scripts/             render.js (CLI) · generate-sample.js · contact-sheet.js · build-basemap.js
basemap/             ne-50m.json (Natural Earth 1:50m coastlines/borders) · places.json (approx. reference places)
data/                synthetic sample datasets (JSON + CSV)
assets/fonts/        Inter + JetBrains Mono (OFL) used by both preview and export
tests/               node:test files
```

To regenerate derived data: `npm run sample` rebuilds the synthetic datasets (fixed seed, byte-identical output), and
`npm run basemap` rebuilds the basemap from the `world-atlas` package.
