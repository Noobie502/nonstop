# ✈ Nonstop — where can I fly direct?

Pick any airport and see every nonstop destination on a map: great-circle routes, distances, rough flight times, the airlines that fly them and on which aircraft. Or search an airline to map its whole network.

**Stack:** plain HTML/CSS/JS + [Leaflet](https://leafletjs.com), a bundled [Natural Earth](https://www.naturalearthdata.com) world map (no tile service or API key), deployed as a static site on Vercel.

## Data
Routes and airports come from [OpenFlights](https://openflights.org/data) (Open Database License). The route set was last updated in 2014, so treat it as a snapshot: some routes have since started or stopped.

`scripts/build_data.py` turns the raw `.dat` files into `public/data/network.json`:

```bash
mkdir raw && for f in airports routes airlines planes; do
  curl -sSfo raw/$f.dat https://raw.githubusercontent.com/jpatokal/openflights/master/data/$f.dat
done
python3 scripts/build_data.py raw public/data

# world map
npm i world-atlas@2 topojson-client@3
node scripts/build_world.mjs node_modules/world-atlas/countries-50m.json public/data/world.json
```

Departure times aren't in any open dataset, so each route links to Google Flights for live schedules.

Only nonstop routes (`stops == 0`) between airports with IATA codes are kept.

## Run locally
```bash
npx serve public
```

## Ideas for next weekend
- Two-airport mode: "where can I go from A *and* B?" or one-stop connections
- Filter by alliance
- Real timetables via a flight-schedule API (e.g. AeroDataBox)
- Swap in a fresher route dataset
