# ✈ Nonstop — where can I fly direct?

Pick any airport and see every nonstop destination on a map. Or search an airline to map its whole network. Click any route to see who flies it, the flight numbers seen this week, typical takeoff times and the aircraft used.

**Stack:** plain HTML/CSS/JS + [Leaflet](https://leafletjs.com), a bundled [Natural Earth](https://www.naturalearthdata.com) world map (no tile service or API key), deployed as a static site on Vercel. Data refreshes weekly via GitHub Actions.

## Accessibility

- Everything on the map is also in the panel: lists are real buttons, route details are a readable page with proper tables, so the site works by keyboard and screen reader.
- Search is an ARIA combobox (arrow keys + Enter); result counts are announced; focus moves to each new heading; Esc or the browser Back button goes back.
- Text sized in rem (browser zoom works), WCAG AA contrast, visible focus rings, 44px touch targets, honours reduced-motion.
- Settings for km/miles and 12/24-hour time (remembered per browser). On phones the list and map switch with tabs.
- Checked with axe-core (WCAG 2.1 AA + best practices): no violations.

## Security

- No third-party code: Leaflet 1.9.4 and the fonts are served from `public/vendor/` (copied from npm), so nothing outside this site can run on the page.
- `vercel.json` sets a Content-Security-Policy that only allows this site's own files, plus `nosniff`, referrer, permissions and anti-framing headers.
- Data files can only be read by pages on nonstop-gamma.vercel.app (CORS + Cross-Origin-Resource-Policy). This stops other sites using them in their visitors' browsers; it can't stop someone downloading them directly.
- To test header changes, push to a branch first: Vercel builds a private preview.

## Licence

Site code: © 2026 Noobie502, all rights reserved (`LICENSE`). Built data in `public/data/`: ODbL 1.0 (`DATA-LICENSE.md`). Leaflet (BSD-2) and the fonts (OFL) keep their own licences.

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

Data checks done on every build (`scripts/build_data.py` prints a report):
- **Routes:** routes with no airline are dropped; duplicate entries merged; routes faster than any airliner over long distances are dropped (the source occasionally points at the wrong airport, e.g. a Myanmar route tagged with Noosa, Australia); impossible flight times are replaced by the return flight's time or an estimate; outbound/return times that disagree wildly (usually a time-zone slip) are averaged.
- **Countries:** one everyday name per country (the source mixes "USA" and "United States", which broke the "international only" filter).
- **Aircraft:** light aircraft, helicopters and business jets are ignored; an aircraft type is dropped if the route is beyond its range or it was a one-off mis-tag (e.g. a single Dash 8 sighting on a 787 route); one-day flights numbered 5000+ (charters, positioning) are skipped.
- Flights whose radio call sign isn't a flight number (e.g. `RYR8HG`) are shown as call signs.
- Takeoff times were spot-checked against published timetables (SQ 308, TG 916, TG 102): they match actual takeoff, 20–40 min after the timetable departure.

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
