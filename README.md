# ✈ Nonstop — where can I fly direct?

Pick any airport and see every nonstop destination on a map: great-circle routes, distances, rough flight times and the airlines that fly them.

**Stack:** plain HTML/CSS/JS + [Leaflet](https://leafletjs.com), CARTO dark basemap, deployed as a static site on Vercel.

## Data
Routes and airports come from [OpenFlights](https://openflights.org/data) (Open Database License). The route set was last updated in 2014, so treat it as a snapshot: some routes have since started or stopped.

`scripts/build_data.py` turns the raw `.dat` files into `public/data/network.json`:

```bash
mkdir raw && for f in airports routes airlines; do
  curl -sSfo raw/$f.dat https://raw.githubusercontent.com/jpatokal/openflights/master/data/$f.dat
done
python3 scripts/build_data.py raw public/data
```

Only nonstop routes (`stops == 0`) between airports with IATA codes are kept.

## Run locally
```bash
npx serve public
```

## Ideas for next weekend
- Two-airport mode: "where can I go from A *and* B?" or one-stop connections
- Filter by airline or alliance
- Swap in a fresher route dataset
