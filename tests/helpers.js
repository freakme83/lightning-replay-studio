// Shared helpers for the map tests (pixel decoding and an offline marker basemap).
import { execFileSync } from "node:child_process";

/** Decode a PNG to raw RGB with the FFmpeg the project already requires. */
export function decodeRgb(file) {
  const out = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64e6 });
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).toString().trim();
  const [width, height] = probe.split(",").map(Number);
  return { width, height, data: out };
}

/** Weighted centroid of pixels matching `pick` within radius r of (cx, cy). */
export function centroid(img, cx, cy, r, pick) {
  let sx = 0, sy = 0, n = 0;
  for (let y = Math.max(0, Math.round(cy - r)); y <= Math.min(img.height - 1, Math.round(cy + r)); y++)
    for (let x = Math.max(0, Math.round(cx - r)); x <= Math.min(img.width - 1, Math.round(cx + r)); x++) {
      const i = (y * img.width + x) * 3;
      if (pick(img.data[i], img.data[i + 1], img.data[i + 2])) { sx += x + 0.5; sy += y + 0.5; n++; }
    }
  return n ? [sx / n, sy / n, n] : null;
}

/** Offline MapLibre style: black background plus a magenta ring at each point. */
export function markerStyle(points) {
  return {
    version: 8,
    sources: { pts: { type: "geojson", data: { type: "FeatureCollection", features: points.map(([lon, lat]) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] } })) } } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#000000" } },
      { id: "ring", type: "circle", source: "pts", paint: { "circle-radius": 14, "circle-opacity": 0, "circle-stroke-color": "#ff00ff", "circle-stroke-width": 2.5 } },
    ],
  };
}
export const isMagenta = (r, g, b) => r > 150 && b > 150 && g < 90;

/**
 * Offline style named like the real provider's layers: left of `lon` a blue "water" fill,
 * right of it a green "landuse_park" fill, a magenta "boundary_state" line down the middle.
 * Layer groups (src/map/layers.js) find them by id, so toggles show up as pixel changes.
 */
export function layerStyle(lon) {
  const box = (w, e) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, -80], [e, -80], [e, 80], [w, 80], [w, -80]]] } });
  const src = (f) => ({ type: "geojson", data: { type: "FeatureCollection", features: [f] } });
  return {
    version: 8,
    sources: {
      sea: src(box(-179, lon)),
      park: src(box(lon, 179)),
      border: { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[lon, -80], [lon, 80]] } } },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#000000" } },
      { id: "water", type: "fill", source: "sea", paint: { "fill-color": "#0000ff" } },
      { id: "landuse_park", type: "fill", source: "park", paint: { "fill-color": "#00ff00" } },
      { id: "boundary_state", type: "line", source: "border", paint: { "line-color": "#ff00ff", "line-width": 6 } },
    ],
  };
}

/** RGB of one pixel (x, y) in a decoded image from decodeRgb(). */
export const pixel = (img, x, y) => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
