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
    ids: /^water(way)?$/,
    types: ["fill", "line"],
    default: { visible: true, opacity: 1 },
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
  }
  return out;
}

/** Stable identity of a (normalised) settings object; part of the basemap cache key. */
export function layersKey(layers) {
  const n = normalizeLayers(layers);
  return GROUP_IDS.map((id) => `${id}:${n[id].visible ? 1 : 0}@${n[id].opacity}${n[id].textCase ? `/${n[id].textCase}` : ""}`).join("|");
}

export const layersAreDefault = (layers) => layersKey(layers) === layersKey(defaultLayers());

/**
 * Parse a CLI spec such as "roadsMinor=off,labels=40,labelCase=natural,water=on" (percent 0–100).
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
    if (!GROUP_IDS.includes(id)) throw new Error(`Unknown map layer "${id}". Layers: ${GROUP_IDS.join(", ")}.`);
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
