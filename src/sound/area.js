// The listening area: the rectangle whose latitude is cut into note bands and whose longitude is the
// stereo field. Two choices, switchable at any time:
//   data  - the dataset's own capture area (meta: bounds / bbox / area, or centerLat + centerLon + sideKm
//           / radiusKm), or, when it has none, an area suggested once from its strikes. It does not move
//           when you pan or zoom the map.
//   frame - the video's map frame: the top edge of the picture is the highest note, left = left ear.
import { boundsError, suggestBounds } from "./geo.js";

/** @typedef {import("./geo.js").GeoBounds} GeoBounds */

export const AREA_CHOICES = ["data", "frame"];

const toNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Case-insensitive lookup of the first present key. */
function pick(o, keys) {
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), o[k]]));
  for (const k of keys) {
    const v = lower.get(k);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** A box of half-size `halfKm` around a point (flat-earth approximation, as everywhere in the sound). */
function boxAround(lat, lon, halfKm) {
  const dLat = halfKm / 111.2,
    dLon = halfKm / Math.max(1, 111.32 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

const BOUNDS_KEYS = ["bounds", "bbox", "capturearea", "capture_area", "area", "boundingbox"];

/** The capture area stated in a dataset's metadata, or null. */
export function metaArea(meta) {
  if (!isObj(meta)) return null;
  const v = pick(meta, BOUNDS_KEYS);
  let b = null;
  if (Array.isArray(v) && v.length === 4 && v.every((x) => toNumber(x) !== null)) {
    const [w, s, e, n] = v.map(Number); // GeoJSON bbox order
    b = { south: s, north: n, west: w, east: e };
  } else if (isObj(v)) {
    const g = (keys) => toNumber(pick(v, keys));
    const south = g(["south", "minlat", "min_lat", "s"]),
      north = g(["north", "maxlat", "max_lat", "n"]);
    const west = g(["west", "minlon", "min_lon", "w"]),
      east = g(["east", "maxlon", "max_lon", "e"]);
    if (south !== null && north !== null && west !== null && east !== null) b = { south, north, west, east };
    else {
      const c = pick(v, ["center", "centre"]);
      const r = toNumber(pick(v, ["radiuskm", "radius_km", "radius"]));
      const cLat = isObj(c) ? toNumber(pick(c, ["lat", "latitude"])) : null;
      const cLon = isObj(c) ? toNumber(pick(c, ["lon", "lng", "long", "longitude"])) : null;
      if (cLat !== null && cLon !== null && r !== null && r > 0) b = boxAround(cLat, cLon, r);
    }
  } else {
    // flat fields: centerLat / centerLon plus sideKm (square) or radiusKm (as in Blitzortung captures)
    const lat = toNumber(pick(meta, ["centerlat", "center_lat"])),
      lon = toNumber(pick(meta, ["centerlon", "center_lon", "centerlng"]));
    const side = toNumber(pick(meta, ["sidekm", "side_km"])),
      radius = toNumber(pick(meta, ["radiuskm", "radius_km"]));
    const half = side !== null && side > 0 ? side / 2 : radius !== null && radius > 0 ? radius : null;
    if (lat !== null && lon !== null && half !== null) b = boxAround(lat, lon, half);
  }
  return b && !boundsError(b) ? b : null;
}

/**
 * The dataset's own listening area: stated in its metadata, else suggested once from all its valid strikes.
 * @returns {{bounds: GeoBounds, origin: "file"|"suggested"}}
 */
export function dataArea(dataset) {
  const b = metaArea(dataset?.meta);
  if (b) return { bounds: b, origin: "file" };
  return { bounds: suggestBounds(dataset.events), origin: "suggested" };
}

/**
 * The listening area for a choice. "frame" needs a map frame; without one it falls back to the data area
 * (reported in `origin`).
 * @param {"data"|"frame"} choice
 * @param {{west:number, south:number, east:number, north:number}|null} frame the video's map frame
 * @returns {{bounds: GeoBounds, origin: "file"|"suggested"|"frame", choice: "data"|"frame", fallback: boolean}}
 */
export function listeningArea(choice, dataset, frame) {
  if (choice === "frame" && frame) {
    const b = { south: frame.south, north: frame.north, west: frame.west, east: frame.east };
    if (!boundsError(b)) return { bounds: b, origin: "frame", choice, fallback: false };
  }
  return { ...dataArea(dataset), choice, fallback: choice === "frame" };
}
