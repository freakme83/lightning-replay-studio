// Map providers for the Map Composer and the prepared (baked) basemap.
// Runs in the browser (studio composer, headless basemap renderer) and in Node (tests).
// Swapping provider means adding an entry here: the replay engine only ever sees a
// finished basemap image plus its attribution line.

export const PROVIDERS = {
  "openfreemap-dark": {
    label: "OpenFreeMap · Dark",
    // Free public instance: no API key, no registration (https://openfreemap.org).
    styleUrl: "https://tiles.openfreemap.org/styles/dark",
    // Required credit (OpenFreeMap terms; OpenMapTiles schema; OSM ODbL).
    attribution: "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors",
    tune: tuneDark,
  },
};

export const DEFAULT_PROVIDER = "openfreemap-dark";

export function getProvider(id = DEFAULT_PROVIDER) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown map provider "${id}".`);
  return { id, ...p };
}

/** Fetch a provider's style JSON and apply its tuning. Throws with a readable message. */
export async function loadProviderStyle(id = DEFAULT_PROVIDER, { fetchImpl = fetch, styleUrl } = {}) {
  const p = getProvider(id);
  const url = styleUrl ?? p.styleUrl;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    throw new Error(`Could not reach the map provider (${url}): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Map style request failed (${res.status}) for ${url}`);
  const style = await res.json();
  return p.tune ? p.tune(style) : style;
}

// ---------- dark style tuning ----------
// The stock OpenFreeMap "dark" style is neutral grey. Re-tint it towards the replay's
// near-black navy, lift roads just enough to read, keep place names, drop clutter.

const HIDE = /^(road_oneway|highway_name|water_name|aeroway|railway|building|landcover_glacier|landcover_ice)/;

function parseColor(c) {
  if (typeof c !== "string") return null;
  let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  m = c.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) {
    const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    };
    return [f(0), f(8), f(4), m[4] === undefined ? 1 : +m[4]];
  }
  return null;
}

const rgba = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;

/** Grey → navy-tinted grey of similar lightness, scaled by `lift`. */
function navy(c, lift = 1) {
  const p = parseColor(c);
  if (!p) return c;
  const L = ((p[0] + p[1] + p[2]) / 3) * lift;
  return rgba([L * 0.78 + 1, L * 0.95 + 3, L * 1.2 + 6, p[3]]);
}

/** Apply fn to every colour literal in a paint value (plain or inside an expression). */
function mapColors(v, fn) {
  if (typeof v === "string") return parseColor(v) ? fn(v) : v;
  if (Array.isArray(v)) return v.map((x) => mapColors(x, fn));
  return v;
}

export function tuneDark(style) {
  const out = structuredClone(style);
  out.layers = out.layers.filter((l) => !HIDE.test(l.id));
  for (const l of out.layers) {
    const paint = (l.paint ??= {});
    const isRoad = l["source-layer"] === "transportation";
    const isPlace = l["source-layer"] === "place";
    for (const key of Object.keys(paint)) {
      if (!key.endsWith("-color")) continue;
      paint[key] = mapColors(paint[key], (c) => navy(c, isRoad ? 1.5 : l["source-layer"] === "boundary" ? 1.4 : 1));
    }
    // Provider quirks that read as gaps or weak lines on a dark replay frame:
    // - Province borders: the stock filter (admin_level == 4) drops every segment shared with a
    //   level-3 region border (common in Türkiye), and the dashes (scaled by line width) open
    //   persistent gaps when zoomed in. Draw levels 3–4 as a solid line.
    // - Minor streets/paths: stock #181818 lifts to almost the background; raise them to a
    //   readable navy-grey, still well below the major roads.
    if (l.id === "boundary_state") {
      l.filter = ["all", [">=", ["get", "admin_level"], 3], ["<=", ["get", "admin_level"], 4]];
      delete paint["line-dasharray"];
    }
    if (l.id === "highway_minor" || l.id === "highway_path") paint["line-color"] = "rgb(54, 68, 92)";
    if (l.type === "background") paint["background-color"] = "#070a10";
    if (l.id === "water") paint["fill-color"] = "#0b1520";
    if (l.id === "waterway") paint["line-color"] = "#0d1824";
    if (isPlace && l.type === "symbol") {
      const major = /city|state|country/.test(l.id);
      paint["text-color"] = major ? "#a9b8c4" : "#76889a";
      paint["text-halo-color"] = "rgba(4, 7, 11, 0.9)";
      paint["text-halo-width"] = 1.2;
      paint["text-halo-blur"] = 0.6;
      if (paint["icon-opacity"] !== undefined) paint["icon-opacity"] = 0.45;
    }
  }
  return out;
}

// ---------- offline fallback ----------
/**
 * A network-free MapLibre style from the bundled Natural Earth outlines
 * (basemap/ne-50m.json), so framing still works when the online map is unavailable.
 */
export function offlineStyle(ne) {
  const feature = (geometry) => ({ type: "Feature", properties: {}, geometry });
  return {
    version: 8,
    sources: {
      land: { type: "geojson", data: { type: "FeatureCollection", features: (ne?.land ?? []).map((f) => feature({ type: "Polygon", coordinates: [f.c] })) } },
      borders: { type: "geojson", data: { type: "FeatureCollection", features: (ne?.borders ?? []).map((f) => feature({ type: "LineString", coordinates: f.c })) } },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#06080b" } },
      { id: "land", type: "fill", source: "land", paint: { "fill-color": "#0b1117", "fill-outline-color": "#22323d" } },
      { id: "borders", type: "line", source: "borders", paint: { "line-color": "#2a3944", "line-dasharray": [4, 3], "line-width": 0.8 } },
    ],
  };
}
