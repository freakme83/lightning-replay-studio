// One-off: convert Natural Earth 1:50m TopoJSON (npm world-atlas) into the compact
// basemap/ne-50m.json used offline by the preview and the renderer.
// Usage: node scripts/build-basemap.js
import { readFileSync, writeFileSync } from "node:fs";
import { feature, mesh } from "topojson-client";

const land = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/land-50m.json", import.meta.url)));
const countries = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/countries-50m.json", import.meta.url)));

const round = (v) => Math.round(v * 1e4) / 1e4;
const pack = (coords) => {
  let w = 180, s = 90, e = -180, n = -90;
  const c = coords.map(([lon, lat]) => {
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
    return [round(lon), round(lat)];
  });
  return { b: [round(w), round(s), round(e), round(n)], c };
};

const rings = [];
for (const f of feature(land, land.objects.land).features) {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const p of polys) rings.push(pack(p[0])); // outer rings; lakes are not drawn
}
const borderGeom = mesh(countries, countries.objects.countries, (a, b) => a !== b);
const borders = borderGeom.coordinates.map(pack);

const out = {
  source: "Natural Earth 1:50m (public domain) via world-atlas@2.0.2",
  land: rings,
  borders,
};
writeFileSync(new URL("../basemap/ne-50m.json", import.meta.url), JSON.stringify(out));
console.log(`land rings: ${rings.length}, border lines: ${borders.length}`);
