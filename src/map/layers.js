// Map layer groups: the few user-facing switches (roads, labels, boundaries, water, land)
// mapped declaratively onto the provider's style layers. One pure function turns a style
// plus the user's settings into per-layer patches, and both the interactive Map Composer
// (via MapLibre's setLayoutProperty / setPaintProperty) and the headless basemap bake
// (via applyLayers) use those same patches, so the preview map and the exported map
// cannot drift apart. Runs in the browser, in headless Chrome and in Node.
//
// Groups match style layers by id pattern (and layer type). A provider whose style has no
// matching layer simply reports the group as unavailable; nothing throws.

export const LAYER_GROUPS = [
  {
    id: "roadsMajor",
    label: "Major roads",
    hint: "Motorways and main roads",
    ids: /^highway_(major|motorway)_/,
    types: ["line"],
    default: { visible: true, opacity: 1 },
  },
  {
    id: "roadsMinor",
    label: "Minor roads",
    hint: "Streets, tracks and paths",
    ids: /^(highway_(minor|path)|road_(area_)?pier)/,
    types: ["line", "fill"],
    default: { visible: true, opacity: 0.6 },
    minZoom: 12, // OpenMapTiles carries minor roads from zoom 12; nothing to draw below it
  },
  {
    id: "labels",
    label: "Place names",
    hint: "Cities, towns, districts, regions",
    ids: /^place_/,
    types: ["symbol"],
    default: { visible: true, opacity: 1, textCase: "original" },
    // The stock style upper-cases every place name with `text-transform: uppercase`; the tiles
    // carry natural-case names (İstanbul, Şanlıurfa), so "natural" just switches the transform off.
    textCase: true,
  },
  {
    id: "boundaries",
    label: "Boundaries",
    hint: "Country, province and state borders",
    ids: /^boundary_/,
    types: ["line"],
    default: { visible: true, opacity: 0.6 },
  },
  {
    id: "water",
    label: "Water",
    hint: "Seas, lakes, rivers",
    ids: /^water(way)?$/, // `water` (fill: oceans, seas, lakes) and `waterway` (line: rivers, canals)
    types: ["fill", "line"],
    default: { visible: true, opacity: 1, colorMode: "original", customColor: "#1e4d7b", brightness: 0 },
    appearance: true, // colour preset, custom colour and brightness (see WATER_PRESETS)
  },
  {
    id: "land",
    label: "Land cover & parks",
    hint: "Forests, parks, built-up areas",
    ids: /^(landcover|landuse)_/,
    types: ["fill"],
    default: { visible: true, opacity: 1 },
  },
];

const OPACITY_PROPS = { fill: ["fill-opacity"], line: ["line-opacity"], symbol: ["text-opacity", "icon-opacity"] };
const GROUP_IDS = LAYER_GROUPS.map((g) => g.id);

export const TEXT_CASES = ["original", "natural"];

/**
 * Water colour presets. "original" keeps the provider's (tuned) colours; the others replace the colour of every
 * water layer. Presets are dark enough for the cinematic look yet clearly separate from the near-black land.
 */
export const WATER_PRESETS = {
  original: { label: "Original" },
  blue: { label: "Ocean blue", color: "#12304f" },
  teal: { label: "Deep teal", color: "#0e3b40" },
  custom: { label: "Custom" },
};
export const WATER_COLOR_MODES = Object.keys(WATER_PRESETS);
export const WATER_BRIGHTNESS = { min: -50, max: 50, step: 5 }; // percent; ±50 = half / double the lightness
const BRIGHT_CEILING = 0.45; // brightening never pushes a colour past this lightness (no washed-out water)
const RIVER_LIFT = 1.2; // rivers are drawn a little lighter than the surface, as in the provider's own style

// ---- colour helpers (sRGB hex ⇄ HSL), enough for the water tones ----
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function normalizeHex(v) {
  const m = HEX.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}
/** [r, g, b] (0–255) of "#rrggbb", "rgb(r g b)" / "rgb(r, g, b)" / "rgba(...)"; null for anything else. */
function parseColor(c) {
  if (typeof c !== "string") return null;
  const hex = normalizeHex(c);
  if (hex) return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c.trim());
  return m ? [m[1], m[2], m[3]].map((x) => Math.min(255, Math.max(0, Math.round(Number(x))))) : null;
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, sat, l];
}
function hslToHex([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
/** Lightness × 2^(brightness / 50): symmetric, ±50 % = half / double. Brightening stops at BRIGHT_CEILING (or the colour's own lightness if already above it). */
function shade(rgb, brightness, lift = 1) {
  if (brightness === 0 && lift === 1) return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`; // exact, no HSL round trip
  const [h, s, l] = rgbToHsl(rgb);
  const f = Math.pow(2, brightness / 50) * lift;
  const l2 = f > 1 ? Math.min(l * f, Math.max(l, BRIGHT_CEILING)) : l * f;
  return hslToHex([h, s, l2]);
}

export const defaultLayers = () => Object.fromEntries(LAYER_GROUPS.map((g) => [g.id, { ...g.default }]));

/**
 * Complete, validated layer settings from any input. Unknown groups are ignored; a missing
 * or invalid field falls back to that group's default; opacity is clamped to 0…1 (2 decimals).
 * Never throws, so a hand-edited request cannot break a bake.
 */
export function normalizeLayers(input) {
  const out = defaultLayers();
  if (!input || typeof input !== "object") return out;
  for (const g of LAYER_GROUPS) {
    const v = input[g.id];
    if (!v || typeof v !== "object") continue;
    if (typeof v.visible === "boolean") out[g.id].visible = v.visible;
    const o = typeof v.opacity === "string" && v.opacity.trim() === "" ? NaN : Number(v.opacity);
    if (Number.isFinite(o)) out[g.id].opacity = Math.round(Math.min(1, Math.max(0, o)) * 100) / 100;
    if (g.textCase && TEXT_CASES.includes(v.textCase)) out[g.id].textCase = v.textCase;
    if (g.appearance) {
      if (WATER_COLOR_MODES.includes(v.colorMode)) out[g.id].colorMode = v.colorMode;
      const hex = normalizeHex(v.customColor);
      if (hex) out[g.id].customColor = hex;
      const b = typeof v.brightness === "string" && v.brightness.trim() === "" ? NaN : Number(v.brightness);
      if (Number.isFinite(b)) out[g.id].brightness = Math.round(Math.min(WATER_BRIGHTNESS.max, Math.max(WATER_BRIGHTNESS.min, b)));
    }
  }
  return out;
}

/** Colour part of a group's identity: empty for the provider's own appearance, so existing cache entries stay valid. */
function appearanceKey(id, v) {
  if (!LAYER_GROUPS.find((g) => g.id === id).appearance || (v.colorMode === "original" && v.brightness === 0)) return "";
  const color = v.colorMode === "custom" ? v.customColor : v.colorMode === "original" ? "" : WATER_PRESETS[v.colorMode].color;
  return `/${v.colorMode}${v.colorMode === "custom" ? ":" + color : ""}${v.brightness ? `${v.brightness > 0 ? "+" : ""}${v.brightness}` : ""}`;
}

/** Stable identity of a (normalised) settings object; part of the basemap cache key. */
export function layersKey(layers) {
  const n = normalizeLayers(layers);
  return GROUP_IDS.map((id) => `${id}:${n[id].visible ? 1 : 0}@${n[id].opacity}${n[id].textCase ? `/${n[id].textCase}` : ""}${appearanceKey(id, n[id])}`).join("|");
}

export const layersAreDefault = (layers) => layersKey(layers) === layersKey(defaultLayers());

/**
 * Parse a CLI spec such as "roadsMinor=off,labels=40,labelCase=natural,water=on,waterColor=blue,waterBrightness=20"
 * (percent 0–100; waterColor is original, blue, teal or a #rrggbb colour).
 * @returns {object} partial settings for normalizeLayers()
 */
export function parseLayerSpec(spec) {
  const out = {};
  for (const part of String(spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, raw = ""] = part.split("=").map((s) => s.trim());
    if (id === "labelCase") {
      if (!TEXT_CASES.includes(raw)) throw new Error(`labelCase must be ${TEXT_CASES.join(" or ")}, got "${raw}".`);
      out.labels = { ...out.labels, textCase: raw };
      continue;
    }
    if (id === "waterColor") {
      const hex = normalizeHex(raw);
      if (!hex && !WATER_COLOR_MODES.includes(raw)) throw new Error(`waterColor must be ${WATER_COLOR_MODES.filter((m) => m !== "custom").join(", ")} or a #rrggbb colour, got "${raw}".`);
      out.water = { ...out.water, colorMode: hex ? "custom" : raw, ...(hex ? { customColor: hex } : {}) };
      continue;
    }
    if (id === "waterBrightness") {
      const b = Number(raw.replace(/%$/, ""));
      if (!Number.isFinite(b) || b < WATER_BRIGHTNESS.min || b > WATER_BRIGHTNESS.max) throw new Error(`waterBrightness must be ${WATER_BRIGHTNESS.min} to ${WATER_BRIGHTNESS.max}, got "${raw}".`);
      out.water = { ...out.water, brightness: b };
      continue;
    }
    if (!GROUP_IDS.includes(id)) throw new Error(`Unknown map layer "${id}". Layers: ${GROUP_IDS.join(", ")}, waterColor, waterBrightness.`);
    const v = raw.toLowerCase();
    if (v === "off" || v === "false" || v === "0") out[id] = { ...out[id], visible: false };
    else if (v === "on" || v === "true" || v === "") out[id] = { ...out[id], visible: true };
    else {
      const pct = Number(v.replace(/%$/, ""));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error(`Layer "${id}": expected on, off or a percentage 0–100, got "${raw}".`);
      out[id] = { ...out[id], visible: true, opacity: pct / 100 };
    }
  }
  return out;
}

const groupOf = (layer) => LAYER_GROUPS.find((g) => g.ids.test(layer.id) && g.types.includes(layer.type)) ?? null;

/** How many style layers each group controls in this style (0 = group unavailable). */
export function availableGroups(style) {
  const counts = Object.fromEntries(GROUP_IDS.map((id) => [id, 0]));
  for (const l of style?.layers ?? []) {
    const g = groupOf(l);
    if (g) counts[g.id]++;
  }
  return counts;
}

/** Scale an opacity paint value (number, or zoom/data expression) by factor f ≤ 1. */
function scaleOpacity(base, f) {
  if (base === undefined) return f;
  if (typeof base === "number") return Math.round(base * f * 1e4) / 1e4;
  if (!Array.isArray(base)) return f;
  if (f === 1) return base;
  const scaleOut = (v) => (typeof v === "number" ? Math.round(v * f * 1e4) / 1e4 : ["*", f, v]);
  // Zoom curves must stay top-level interpolate/step expressions, so scale their outputs.
  if (base[0] === "interpolate" || base[0] === "interpolate-hcl" || base[0] === "interpolate-lab")
    return base.map((x, i) => (i >= 4 && i % 2 === 0 ? scaleOut(x) : x));
  if (base[0] === "step") return base.map((x, i) => (i >= 2 && i % 2 === 0 ? scaleOut(x) : x));
  return ["*", f, base];
}

/** The colour a water layer gets: the style's own value for Original at brightness 0, else the shaded preset / custom / provider colour. */
function waterColor(original, v, river) {
  const base = v.colorMode === "original" ? parseColor(original) : parseColor(v.colorMode === "custom" ? v.customColor : WATER_PRESETS[v.colorMode].color);
  if (v.colorMode === "original" && v.brightness === 0) return original;
  if (!base) return original; // an expression or unknown format cannot be shaded: leave the provider's colour
  return shade(base, v.brightness, river && v.colorMode !== "original" ? RIVER_LIFT : 1);
}

/**
 * Per-layer changes that realise `layers` on `style`, always computed from the style's own
 * values (so re-applying after a change never compounds).
 * @returns {{id, visibility: "visible"|"none", paint: Object<string, any>, layout: Object<string, any>}[]}
 */
export function layerPatches(style, layers) {
  const n = normalizeLayers(layers);
  const patches = [];
  for (const l of style?.layers ?? []) {
    const g = groupOf(l);
    if (!g) continue;
    const { visible, opacity } = n[g.id];
    const paint = {};
    for (const prop of OPACITY_PROPS[l.type] ?? []) paint[prop] = scaleOpacity(l.paint?.[prop], opacity);
    // Other layout properties: label letter case (the stock style forces uppercase).
    const layout = {};
    if (g.textCase && l.type === "symbol") layout["text-transform"] = n[g.id].textCase === "natural" ? "none" : (l.layout?.["text-transform"] ?? "none");
    // Water appearance: the colour is always written (the provider's own value for "original"), so
    // switching a live map back to Original restores it exactly.
    if (g.appearance) {
      const prop = l.type === "fill" ? "fill-color" : "line-color";
      const color = waterColor(l.paint?.[prop], n[g.id], l.type === "line");
      if (color !== undefined) paint[prop] = color;
    }
    patches.push({ id: l.id, visibility: visible && opacity > 0 ? "visible" : "none", paint, layout });
  }
  return patches;
}

/** A copy of `style` with the layer settings applied (the headless bake path). */
export function applyLayers(style, layers) {
  const out = structuredClone(style);
  const byId = new Map(out.layers.map((l) => [l.id, l]));
  for (const p of layerPatches(style, layers)) {
    const l = byId.get(p.id);
    l.layout = { ...l.layout, ...p.layout, visibility: p.visibility };
    l.paint = { ...l.paint, ...p.paint };
  }
  return out;
}
