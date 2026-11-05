// Geographic helpers for the sound (ported from Lightning Sound Lab v1.3). Pure functions only:
// nothing here remembers earlier events, so the mapping from a position to a note can never drift
// while the music plays.

/** @typedef {{south:number, north:number, west:number, east:number}} GeoBounds */

/** Stereo never goes fully hard left/right, so far-away strikes stay comfortable on headphones. */
export const GEO_PAN_MAX = 0.8;
/** The suggested listening area is never smaller than this, so a tiny cluster is not stretched over the whole ladder. */
export const MIN_AREA_KM = 20;

const KM_PER_DEG_LAT = 111.2;
const kmPerDegLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ---------- bounds ---------- */

/** null = fine, otherwise a plain-language reason. */
export function boundsError(b) {
  const v = [b.south, b.north, b.west, b.east];
  if (v.some((x) => typeof x !== "number" || !Number.isFinite(x))) return "bounds must be four numbers";
  if (b.south < -90 || b.north > 90) return "latitude must be between -90 and 90";
  if (b.west < -180 || b.east > 180) return "longitude must be between -180 and 180";
  if (b.north <= b.south) return "north must be greater than south";
  if (b.east <= b.west) return "east must be greater than west (areas crossing the 180° meridian are not supported)";
  return null;
}

/** Approximate size of the area in km (flat-earth approximation, fine for listening areas). */
export function boundsSizeKm(b) {
  return {
    height: (b.north - b.south) * KM_PER_DEG_LAT,
    width: (b.east - b.west) * kmPerDegLon((b.north + b.south) / 2),
  };
}

export const isInside = (lat, lon, b) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/* ---------- the two mapping rules ---------- */

/**
 * Rule 1: latitude -> a step on the note ladder (0 = lowest note, n-1 = highest).
 * The area is cut into n equal horizontal bands. Positions outside the area use the nearest edge note.
 * Non-decreasing in latitude, so northern events can never sound lower than southern ones.
 */
export function geoNoteIndex(lat, b, n) {
  if (n <= 1) return 0;
  const f = clamp01((lat - b.south) / (b.north - b.south));
  return Math.min(n - 1, Math.floor(f * n));
}

/** Rule 2: longitude -> stereo position, -GEO_PAN_MAX (west) .. +GEO_PAN_MAX (east). */
export function geoPan(lon, b) {
  const f = clamp01((lon - b.west) / (b.east - b.west));
  return (2 * f - 1) * GEO_PAN_MAX;
}

/* ---------- suggested listening area ---------- */

const roundUpKm = (km) => (km < 100 ? Math.ceil(km / 5) * 5 : Math.ceil(km / 10) * 10);
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * A starting listening area for data that did not bring its own: centred on the events, 25 % larger than their
 * spread, but never smaller than MIN_AREA_KM in either direction. It is computed once per file, never while playing.
 */
export function suggestBounds(points) {
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }
  const cLat = (minLat + maxLat) / 2,
    cLon = (minLon + maxLon) / 2;
  const hKm = roundUpKm(Math.max(MIN_AREA_KM, (maxLat - minLat) * KM_PER_DEG_LAT * 1.25));
  const wKm = roundUpKm(Math.max(MIN_AREA_KM, (maxLon - minLon) * kmPerDegLon(cLat) * 1.25));
  const dLat = hKm / KM_PER_DEG_LAT / 2;
  const dLon = wKm / Math.max(1, kmPerDegLon(cLat)) / 2;
  return {
    south: round4(Math.max(-90, cLat - dLat)),
    north: round4(Math.min(90, cLat + dLat)),
    west: round4(Math.max(-180, cLon - dLon)),
    east: round4(Math.min(180, cLon + dLon)),
  };
}

/* ---------- flashes ---------- */

const BURST_GAP = 0.2; // seconds: strokes closer together than this count as one flash
const BURST_MAX = 6;

/** Groups very close events into flashes: position inside the flash and the flash size, for each event. */
export function groupBursts(times) {
  const index = [];
  let k = 0;
  times.forEach((t, i) => {
    k = i > 0 && t - times[i - 1] <= BURST_GAP && k + 1 < BURST_MAX ? k + 1 : 0;
    index.push(k);
  });
  const size = new Array(times.length).fill(1);
  for (let s = 0; s < times.length; ) {
    let e = s;
    while (e + 1 < times.length && index[e + 1] > 0) e++;
    for (let j = s; j <= e; j++) size[j] = e - s + 1;
    s = e + 1;
  }
  return { index, size };
}

export function formatBounds(b) {
  const f = (x) => x.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
  return `S ${f(b.south)}° – N ${f(b.north)}° · W ${f(b.west)}° – E ${f(b.east)}°`;
}
