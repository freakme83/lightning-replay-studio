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
