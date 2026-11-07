# ✈ Nonstop — where can I fly direct?

Pick any airport and see every nonstop destination on a map. Or search an airline to map its whole network. Click any route to see who flies it, the flight numbers seen this week, typical takeoff times and the aircraft used.

**Stack:** plain HTML/CSS/JS + [Leaflet](https://leafletjs.com), a bundled [Natural Earth](https://www.naturalearthdata.com) world map (no tile service or API key), deployed as a static site on Vercel. Data refreshes weekly via GitHub Actions.

## Data

| What | Source | Freshness |
|---|---|---|
| Routes, carriers, scheduled flight time | [Jonty/airline-route-data](https://github.com/Jonty/airline-route-data) (scraped from FlightsFrom.com; operating carriers only, no codeshares) | weekly |
| Flights seen, aircraft types, takeoff times | [adsb.lol](https://www.adsb.lol) ADS-B history (ODbL) | last 7 days |
| Aircraft for routes not seen in tracking | [OpenFlights](https://openflights.org/data) (ODbL) | 2014, labelled as such |

How flights are derived from tracking (`scripts/observed.py`):
- Each aircraft's daily track is split into legs; a leg's ends are matched to airports (within 10 km if seen low, 60 km if first/last seen mid-climb because of patchy receiver coverage).
- The callsign (e.g. `THA661`) gives the airline; `scripts/airline_icao_extra.json` maps regional operators to the brands they fly for (e.g. Envoy → American).
- A flight only counts if it matches a known route for that airline, which weeds out positioning and training flights.
- Flights airborne at midnight UTC are stitched across consecutive days.
- Takeoff times are local to the departure airport. Gate departure is usually 10–25 minutes earlier.

Limits: coverage depends on volunteer receivers, so some regions (parts of Africa, Central Asia, oceans) have gaps; those routes fall back to 2014 aircraft data or show "not seen".

## Building the data

```bash
mkdir -p data-src/openflights
curl -sSfLo data-src/airline_routes.json https://raw.githubusercontent.com/Jonty/airline-route-data/main/airline_routes.json
for f in airports routes airlines planes; do
  curl -sSfLo data-src/openflights/$f.dat https://raw.githubusercontent.com/jpatokal/openflights/master/data/$f.dat
done
scripts/fetch_observed.sh data-src/airline_routes.json data-src/observed 7   # ~4 GB per day, streamed
python3 scripts/build_data.py data-src/airline_routes.json data-src/observed data-src/openflights public/data
```

The world map only needs rebuilding if you change it:

```bash
npm i world-atlas@2 topojson-client@3
node scripts/build_world.mjs node_modules/world-atlas/countries-50m.json public/data/world.json
```

`.github/workflows/refresh-data.yml` runs all of this every Monday and commits the result, which Vercel then deploys. You can also run it by hand from the Actions tab.

## Run locally
```bash
npx serve public
```

## Ideas
- Two-airport mode: "where can we both fly?" or one-stop connections
- Filter by alliance or aircraft type ("where can I fly on an A380?")
- Live "in the air now" layer from the adsb.lol API
