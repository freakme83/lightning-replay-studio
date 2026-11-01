// Video formats (aspect ratio) and output quality (resolution), two independent settings.
//
//   format   landscape 16:9 · portrait 9:16 · square 1:1
//   quality  hd = Full HD (1920×1080, 1080×1920, 1080×1080) · draft = half of that, for quick tests
//
// A third notion, the *design viewport*, is what the map and the HUD are laid out in: 960×540
// (landscape) or 540×960 / 540×540 (portrait / square) CSS px. Both qualities share it, so Draft
// and Full HD show the same map detail and the same composition, and only the pixel density differs
// (see layoutFor() in layout.js for the scale factor k = output px per design px).

export const FORMATS = Object.freeze({
  landscape: { id: "landscape", label: "Landscape", ratio: "16:9", hd: [1920, 1080] },
  portrait: { id: "portrait", label: "Portrait", ratio: "9:16", hd: [1080, 1920] },
  square: { id: "square", label: "Square", ratio: "1:1", hd: [1080, 1080] },
});

export const QUALITIES = Object.freeze({
  draft: { id: "draft", label: "Draft", scale: 0.5, encode: "draft" }, // fast x264 preset, for checking a composition
  hd: { id: "hd", label: "Full HD", scale: 1, encode: "looks" }, // x264 medium preset, CRF-based
});

export const DEFAULT_FORMAT = "landscape";
export const DEFAULT_QUALITY = "hd";

/** Output pixel size of a preset pair. */
export function outputSize(format = DEFAULT_FORMAT, quality = DEFAULT_QUALITY) {
  const f = FORMATS[format], q = QUALITIES[quality];
  if (!f) throw new Error(`Unknown video format "${format}". Formats: ${Object.keys(FORMATS).join(", ")}.`);
  if (!q) throw new Error(`Unknown video quality "${quality}". Qualities: ${Object.keys(QUALITIES).join(", ")}.`);
  return { width: Math.round(f.hd[0] * q.scale), height: Math.round(f.hd[1] * q.scale) };
}

/** Layout family of any width × height: wide, tall or (nearly) square. */
export function formatOfSize(width, height) {
  const r = width / height;
  return r >= 1.2 ? "landscape" : r <= 0.83 ? "portrait" : "square";
}

/** The preset a size belongs to, or the layout family with quality "custom". */
export function presetOfSize(width, height) {
  for (const f of Object.keys(FORMATS))
    for (const q of Object.keys(QUALITIES)) {
      const s = outputSize(f, q);
      if (s.width === width && s.height === height) return { format: f, quality: q };
    }
  return { format: formatOfSize(width, height), quality: "custom" };
}

/** "1920 × 1080 · 16:9 · Full HD", for the UI and the reports. */
export function describeSize(format, quality) {
  const { width, height } = outputSize(format, quality);
  return `${width} × ${height} · ${FORMATS[format].ratio} · ${QUALITIES[quality].label}`;
}

/**
 * The design viewport (CSS px) of an output size: the viewport the basemap is laid out in and the
 * unit the HUD is drawn in. `k` is output px per design px (2 for Full HD, 1 for Draft).
 */
export function designViewport(width, height) {
  const kind = formatOfSize(width, height);
  const k = kind === "landscape" ? width / 960 : width / 540;
  return { kind, k, width: width / k, height: height / k };
}
