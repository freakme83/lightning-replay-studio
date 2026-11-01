// Web Mercator projection fitted to a viewport. Conformal, so local shapes and the
// east/north scale ratio are preserved; north is up. Antimeridian-crossing bounds
// are not supported (documented limitation).

const EARTH_CIRCUMFERENCE_M = 40075016.686;
const MAX_LAT = 85.05112878;

export function mercX(lon) {
  return (lon + 180) / 360;
}
export function mercY(lat) {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
}
function invMercY(y) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Bounds that contain every event, padded by `padFraction` of the span on each side,
 * with a minimum span so a single strike still gets a sensible map (~11 km).
 */
export function autoBounds(events, { padFraction = 0.12, minSpanDeg = 0.1 } = {}) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const e of events) {
    if (e.lon < west) west = e.lon;
    if (e.lon > east) east = e.lon;
    if (e.lat < south) south = e.lat;
    if (e.lat > north) north = e.lat;
  }
  if (!Number.isFinite(west)) return null;
  const grow = (lo, hi) => {
    const mid = (lo + hi) / 2;
    const half = Math.max(hi - lo, minSpanDeg) / 2;
    const pad = half * 2 * padFraction;
    return [mid - half - pad, mid + half + pad];
  };
  [west, east] = grow(west, east);
  [south, north] = grow(south, north);
  return {
    west: Math.max(-180, west), east: Math.min(180, east),
    south: Math.max(-MAX_LAT, south), north: Math.min(MAX_LAT, north),
  };
}

export function validateBounds(b) {
  if (!b) return "Bounds are missing.";
  for (const k of ["west", "south", "east", "north"]) if (!Number.isFinite(b[k])) return `Bound "${k}" is not a number.`;
  if (b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90) return "Bounds are outside valid coordinates.";
  if (b.west >= b.east) return "West must be less than east.";
  if (b.south >= b.north) return "South must be less than north.";
  return null;
}

/**
 * Fit `bounds` inside the pixel rectangle `rect` ({x, y, w, h}) with uniform scale,
 * centred. Returns a projection whose visible area may extend beyond `bounds` on the
 * axis with spare room (aspect ratio is never distorted).
 */
export function createProjection(bounds, rect) {
  const x0 = mercX(bounds.west), x1 = mercX(bounds.east);
  const y0 = mercY(bounds.north), y1 = mercY(bounds.south);
  const scale = Math.min(rect.w / (x1 - x0), rect.h / (y1 - y0)); // px per world unit
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ox = rect.x + rect.w / 2, oy = rect.y + rect.h / 2;
  const project = (lon, lat) => [ox + (mercX(lon) - cx) * scale, oy + (mercY(lat) - cy) * scale];
  const unproject = (px, py) => [((px - ox) / scale + cx) * 360 - 180, invMercY((py - oy) / scale + cy)];
  return {
    bounds,
    rect,
    scale,
    project,
    unproject,
    /** Ground metres represented by one pixel at latitude `lat`. */
    metersPerPixel: (lat) => (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / scale,
    /** Geographic extent of a pixel rectangle (e.g. the full canvas). */
    extentOf: (r) => {
      const [west, north] = unproject(r.x, r.y);
      const [east, south] = unproject(r.x + r.w, r.y + r.h);
      return { west, south, east, north };
    },
  };
}
