// Convert Natural Earth (world-atlas) TopoJSON to compact GeoJSON for the map.
// Usage: node scripts/build_world.mjs node_modules/world-atlas/countries-50m.json public/data/world.json
// Rings that cross the antimeridian are unwrapped so they don't paint a band across the whole map.
import fs from "fs"; import { feature } from "topojson-client";
const [src, out] = process.argv.slice(2);
const t = JSON.parse(fs.readFileSync(src));
const g = feature(t, t.objects.countries);
const ring = (r) => {
  let prev = r[0][0];
  return r.map(([x, y]) => {
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    prev = x;
    return [+x.toFixed(2), +y.toFixed(2)];
  });
};
const poly = (p) => p.map(ring);
const feats = g.features
  .filter((f) => f.geometry && f.properties.name !== "Antarctica")
  .map((f) => ({
    type: "Feature", properties: {},
    geometry: f.geometry.type === "Polygon"
      ? { type: "Polygon", coordinates: poly(f.geometry.coordinates) }
      : { type: "MultiPolygon", coordinates: f.geometry.coordinates.map(poly) },
  }));
fs.writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features: feats }));
console.log(feats.length, "countries");
