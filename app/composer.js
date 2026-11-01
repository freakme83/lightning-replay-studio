// Map Composer: an interactive MapLibre map with a video-frame guide. It only chooses the
// frame; the replay itself is always drawn by src/core on the canvas (preview and export).
//
// The guide is a rectangle with the output aspect ratio, centred in the map, so the map's
// centre is the frame's centre and the guide's width W_g (CSS px) stands for the output
// width W: the output camera is the map camera with zoom + log2(W / W_g).
import * as maplibregl from "/vendor/maplibre/maplibre-gl.mjs";
import { cameraOf, frameFromCamera, frameProjection } from "/src/core/projection.js";
import { loadProviderStyle, offlineStyle } from "/src/map/providers.js";

const GUIDE_MARGIN = 0.07; // fraction of the stage kept around the guide, for context

export async function createComposer({ container, guide, width, height, basemap, onChange = () => {}, onStatus = () => {} }) {
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
    // HUD bands of the replay (see drawFrame): strikes under them are hard to read.
    guide.style.setProperty("--hud-top", `${(100 / 540) * g.h}px`);
    guide.style.setProperty("--hud-bottom", `${(92 / 540) * g.h}px`);
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
  };
}
