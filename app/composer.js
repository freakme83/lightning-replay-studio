// Map Composer: an interactive MapLibre map with a video-frame guide. It only chooses the
// frame; the replay itself is always drawn by src/core on the canvas (preview and export).
//
// The guide is a rectangle with the output aspect ratio, centred in the map, so the map's
// centre is the frame's centre and the guide's width W_g (CSS px) stands for the output
// width W: the output camera is the map camera with zoom + log2(W / W_g).
import * as maplibregl from "/vendor/maplibre/maplibre-gl.mjs";
import { cameraOf, frameFromCamera, frameProjection } from "/src/core/projection.js";
import { loadProviderStyle, offlineStyle } from "/src/map/providers.js";
import { availableGroups, layerPatches, normalizeLayers } from "/src/map/layers.js";

const GUIDE_MARGIN = 0.07; // fraction of the stage kept around the guide, for context

export async function createComposer({ container, guide, width: initialWidth, height: initialHeight, basemap, layers: initialLayers = null, onChange = () => {}, onStatus = () => {} }) {
  const config = await fetch("/api/map-config").then((r) => r.json());
  let online = true;
  let style;
  try {
    style = await loadProviderStyle(config.provider, { styleUrl: config.styleUrl });
  } catch (e) {
    online = false;
    style = offlineStyle(basemap);
    onStatus({ online, message: `Online map unavailable — showing offline outlines. ${e.message}` });
  }

  const map = new maplibregl.Map({
    container,
    style,
    center: [32.85, 39.92],
    zoom: 7,
    minZoom: 1,
    maxZoom: 16,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    keyboard: false, // the studio owns the keyboard (space, arrows, [ ])
    // Online: the provider style carries its own attribution; offline: credit Natural Earth.
    attributionControl: { compact: true, customAttribution: online ? undefined : "Natural Earth (offline fallback)" },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  let strikes = { type: "FeatureCollection", features: [] };
  let tileErrors = 0;
  const addStrikeLayer = () => {
    if (map.getSource("strikes")) return;
    map.addSource("strikes", { type: "geojson", data: strikes });
    map.addLayer({
      id: "strikes",
      type: "circle",
      source: "strikes",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.2, 12, 4.5],
        "circle-color": ["match", ["get", "type"], "CG", "#ff8a3d", "#3fe0cc"],
        "circle-opacity": 0.9,
        "circle-stroke-color": "#06080b",
        "circle-stroke-width": 0.6,
      },
    });
  };
  // Layer groups (roads, labels, …) are applied with the very patches the headless bake uses
  // (src/map/layers.js), always computed from the unmodified tuned style.
  let layers = normalizeLayers(initialLayers);
  const layerGroups = availableGroups(style);
  const applyLayerSettings = () => {
    for (const p of layerPatches(style, layers)) {
      if (!map.getLayer(p.id)) continue;
      map.setLayoutProperty(p.id, "visibility", p.visibility);
      for (const [prop, value] of Object.entries(p.layout)) map.setLayoutProperty(p.id, prop, value);
      for (const [prop, value] of Object.entries(p.paint)) map.setPaintProperty(p.id, prop, value);
    }
  };
  map.on("style.load", addStrikeLayer);
  map.on("error", (e) => {
    if (!online) return;
    tileErrors++;
    onStatus({ online, message: `Map tiles failed to load (${tileErrors}). Framing still works; preparing the export map may fail.` });
    console.warn("map error", e.error ?? e);
  });
  // Ready once the style is in; tiles keep streaming in the background.
  await new Promise((resolve) => (map.isStyleLoaded() ? resolve() : map.once("style.load", resolve)));
  addStrikeLayer();
  applyLayerSettings();

  // The design viewport of the selected format (960×540, 540×960 or 540×540): its aspect shapes the
  // guide, and the camera is expressed in it, exactly as the headless basemap bake does.
  let width = initialWidth, height = initialHeight;
  let hud = { top: 100 / 540, bottom: 92 / 540, safe: false }; // hatched HUD bands, as fractions of the frame height

  const guideRect = () => {
    const sw = container.clientWidth, sh = container.clientHeight;
    const aspect = width / height;
    const gw = Math.min(sw * (1 - 2 * GUIDE_MARGIN), sh * (1 - 2 * GUIDE_MARGIN) * aspect);
    const gh = gw / aspect;
    return { x: (sw - gw) / 2, y: (sh - gh) / 2, w: gw, h: gh };
  };
  const placeGuide = () => {
    const g = guideRect();
    Object.assign(guide.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
    // HUD bands of the replay (see drawFrame) and, in portrait, the platform safe areas: strikes under them are hard to read.
    guide.style.setProperty("--hud-top", `${hud.top * g.h}px`);
    guide.style.setProperty("--hud-bottom", `${hud.bottom * g.h}px`);
    guide.classList.toggle("safe", hud.safe);
  };

  /** The output-frame camera ({lon, lat, zoom} at width × height) the guide currently shows. */
  const camera = () => {
    const c = map.getCenter();
    return { lon: c.lng, lat: c.lat, zoom: map.getZoom() + Math.log2(width / guideRect().w) };
  };
  const frame = () => frameFromCamera(camera(), width, height);

  map.on("move", () => onChange(frame(), camera()));
  new ResizeObserver(() => {
    if (!container.clientWidth || !container.clientHeight) return;
    const keep = frame();
    map.resize();
    placeGuide();
    showFrame(keep);
  }).observe(container);
  placeGuide();

  /** Move the map so the guide shows exactly `f` (normalised to the output aspect). */
  function showFrame(f) {
    const cam = cameraOf(frameProjection(f, width, height), width, height);
    map.jumpTo({ center: [cam.lon, cam.lat], zoom: cam.zoom - Math.log2(width / guideRect().w), bearing: 0, pitch: 0 });
  }

  return {
    map,
    online: () => online,
    /** How many style layers each group controls (0 = not in this map style). */
    layerGroups,
    setLayers(next) {
      layers = normalizeLayers(next);
      applyLayerSettings();
    },
    frame,
    camera,
    showFrame,
    setStrikes(events) {
      strikes = { type: "FeatureCollection", features: events.map((e) => ({ type: "Feature", properties: { type: e.type }, geometry: { type: "Point", coordinates: [e.lon, e.lat] } })) };
      map.getSource("strikes")?.setData(strikes);
    },
    /** Pixel position of a coordinate inside the guide, scaled to output pixels (for checks). */
    toFramePx(lon, lat) {
      const p = map.project([lon, lat]), g = guideRect();
      return [((p.x - g.x) / g.w) * width, ((p.y - g.y) / g.h) * height];
    },
    setInteractive(on) {
      for (const h of ["dragPan", "scrollZoom", "boxZoom", "doubleClickZoom", "touchZoomRotate"]) on ? map[h].enable() : map[h].disable();
    },
    resize() {
      map.resize();
      placeGuide();
    },
    /** Hatched bands under the HUD, as fractions of the frame height ({top, bottom, safe}). */
    setHud(next) {
      hud = { ...hud, ...next };
      placeGuide();
    },
    /**
     * Switch to another output shape. The map centre stays; `showFrame(frame)` (called next by the
     * studio) then zooms so the new aspect shows the area the old frame covered.
     */
    setViewport(w, h) {
      width = w;
      height = h;
      placeGuide();
    },
  };
}
