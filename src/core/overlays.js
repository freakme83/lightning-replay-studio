// Video overlays: every informational element the replay renderer draws above the map and
// the strikes. One declarative list drives the settings model, the studio panel, the CLI and
// the renderer (src/core/draw.js), so the preview and the exported MP4 cannot disagree.
// Strikes, flashes, rings, trails and the map itself are the core animation, never overlays.
//
// `zone` says which HUD backing band (the dark gradient that keeps text readable over the
// map) an overlay needs; a band is only drawn while at least one overlay in it is visible, so
// with everything off the frame holds nothing but the map and the lightning.

export const OVERLAYS = [
  { id: "title", label: "Title", hint: "Replay title and storm summary, upper left", zone: "top", default: true },
  { id: "clock", label: "Clock / timestamp", hint: "Local time and date, upper right", zone: "top", default: true },
  { id: "counter", label: "Lightning counter", hint: "Running strike count, lower left", zone: "bottom", default: true },
  { id: "activity", label: "Activity indicator", hint: "Strikes-over-time chart with playhead, bottom", zone: "bottom", default: true },
  { id: "scaleBar", label: "Scale bar", hint: "Distance scale, lower left", zone: "bottom", default: true },
  { id: "legend", label: "Legend", hint: "Strike types and trail length, lower right", zone: "bottom", default: true },
  { id: "syntheticNotice", label: "Synthetic-data notice", hint: "“Synthetic data” badge, shown only for fictional datasets", zone: "top", default: true },
  { id: "attribution", label: "Attribution", hint: "Map and data credit line, upper right", zone: "top", default: true },
];

const IDS = OVERLAYS.map((o) => o.id);

export const defaultOverlays = () => Object.fromEntries(OVERLAYS.map((o) => [o.id, o.default]));
export const noOverlays = () => Object.fromEntries(OVERLAYS.map((o) => [o.id, false]));

/**
 * Complete overlay settings from any input: unknown keys are ignored, and anything that is
 * not a real boolean (or "true" / "false") falls back to that overlay's default.
 */
export function normalizeOverlays(input) {
  const out = defaultOverlays();
  if (!input || typeof input !== "object") return out;
  for (const o of OVERLAYS) {
    const v = input[o.id];
    if (v === true || v === "true") out[o.id] = true;
    else if (v === false || v === "false") out[o.id] = false;
  }
  return out;
}

/** Does any visible overlay need the top / bottom HUD backing band? */
export const zoneVisible = (overlays, zone) => OVERLAYS.some((o) => o.zone === zone && overlays[o.id]);

/**
 * CLI spec: "all", "none", or a comma list of the overlays to keep ("title,clock").
 * @returns {object} complete overlay settings
 */
export function parseOverlaySpec(spec) {
  const s = String(spec ?? "all").trim().toLowerCase();
  if (s === "all" || s === "") return defaultOverlays();
  if (s === "none") return noOverlays();
  const keep = new Set();
  for (const part of String(spec).split(",").map((p) => p.trim()).filter(Boolean)) {
    const id = IDS.find((i) => i.toLowerCase() === part.toLowerCase());
    if (!id) throw new Error(`Unknown overlay "${part}". Overlays: ${IDS.join(", ")} (or all / none).`);
    keep.add(id);
  }
  return Object.fromEntries(IDS.map((id) => [id, keep.has(id)]));
}

/**
 * The credit lines for a video, from the sources actually used: the prepared map's own
 * attribution (or the bundled Natural Earth outlines), and the dataset's recorded source.
 * Nothing is invented: a dataset without a recorded provider gets no data line.
 */
export function attributionLines({ mapAttribution = null, outline = false, meta = {} } = {}) {
  const lines = [];
  if (mapAttribution) lines.push(`Map: ${mapAttribution}`);
  else if (outline) lines.push("Map: coastlines and borders from Natural Earth 1:50m (naturalearthdata.com)");
  if (meta.synthetic) lines.push("Lightning data: synthetic, fictional events (not real detections)");
  else if (meta.provider || meta.source) lines.push(`Lightning data: ${meta.provider ?? meta.source} (as recorded in the dataset)`);
  return lines;
}
