"""Build the site's data from three sources.

  1. Routes + scheduled flight times: Jonty/airline-route-data (weekly, from FlightsFrom.com).
     Operating carriers only, so no codeshares.
  2. Flights actually seen (flight numbers, aircraft, takeoff times): adsb.lol ADS-B history
     (ODbL), pre-processed per day by scripts/observed.py into <observed_dir>/*.json.
  3. Fallback aircraft for routes not seen in (2): OpenFlights routes.dat (2014, ODbL).

Usage:
  python3 scripts/build_data.py <airline_routes.json> <observed_dir> <openflights_dir> <out_dir>

Writes:
  out/network.json        airports, airlines and the route list (loaded on page start)
  out/detail/<IATA>.json  per-origin flight details (loaded when a popup opens)
"""
import csv, glob, json, os, re, statistics, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

routes_path, obs_dir, of_dir, out = sys.argv[1:5]
N = lambda v: None if v in ("\\N", "", "-", "N/A") else v

# ---------- 1. routes ----------
R = json.load(open(routes_path, encoding="utf-8"))
ap_ok = {k: a for k, a in R.items() if a.get("latitude") and a.get("longitude") and a.get("iata")}

# ---------- OpenFlights: airline ICAO -> IATA, country; 2014 aircraft ----------
icao2iata, iata_country = {}, {}
for r in csv.reader(open(os.path.join(of_dir, "airlines.dat"), encoding="utf-8")):
    iata, icao, active = N(r[3]), N(r[4]), r[7] == "Y"
    if iata and len(iata) == 2:
        if active or iata not in iata_country:
            iata_country[iata] = N(r[6]) or ""
    if iata and icao and len(icao) == 3 and (active or icao not in icao2iata):
        icao2iata[icao] = iata
of_airline_iata = {r[0]: N(r[3]) for r in csv.reader(open(os.path.join(of_dir, "airlines.dat"), encoding="utf-8"))}
of_planes = {}
for r in csv.reader(open(os.path.join(of_dir, "planes.dat"), encoding="utf-8")):
    if N(r[1]): of_planes[r[1]] = r[0]
of2014 = defaultdict(set)  # (src, dst, airline IATA) -> plane names
for r in csv.reader(open(os.path.join(of_dir, "routes.dat"), encoding="utf-8")):
    if len(r) < 9 or r[7] != "0" or r[6] == "Y": continue
    al = of_airline_iata.get(r[1]) or r[0]
    for p in r[8].split():
        if p in of_planes: of2014[(r[2], r[4], al)].add(of_planes[p])

# ---------- 2. observed flights ----------
def pretty_type(desc, code):
    if not desc: return code
    s = re.sub(r"\bA-(\d{3})", r"A\1", desc)
    s = " ".join(w.capitalize() if w.isalpha() and w.isupper() and len(w) > 3 else w for w in s.split())
    s = s.replace("Mcdonnell", "McDonnell").replace("De Havilland Canada", "De Havilland")
    return s

obs_files = sorted(glob.glob(os.path.join(obs_dir, "*.json")))
type_desc = {}
# (dep, arr, airline IATA) -> callsign -> {"days": set, "times": [local minutes], "types": Counter}
seen = defaultdict(lambda: defaultdict(lambda: {"days": set(), "times": [], "types": Counter()}))
tzc = {}
def tz(iata):
    if iata not in tzc:
        name = (R.get(iata) or {}).get("timezone")
        try: tzc[iata] = ZoneInfo(name) if name else None
        except Exception: tzc[iata] = None
    return tzc[iata]

# callsign prefix -> IATA codes it may be listed under (operator first, then brands)
icao_map = {k: [v] for k, v in icao2iata.items()}
extra = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "airline_icao_extra.json")))
icao_map.update({k: v for k, v in extra.items() if not k.startswith("_")})
carriers_of = {(s, r["iata"]): {c["iata"] for c in r["carriers"]}
               for s, a in R.items() for r in a.get("routes", [])}
label_iata = {}  # callsign -> IATA used for its flight-number label

def resolve(deps, arrs, cs):
    """Pick the (dep, arr, airline) that is a known route flown by an airline this callsign maps to."""
    cands = icao_map.get(cs[:3])
    if not cands: return None
    for dep in deps:
        for arr in arrs:
            if dep == arr: continue
            cars = carriers_of.get((dep, arr))
            if not cars: continue
            for al in cands:
                if al in cars:
                    return dep, arr, al, cands[0]
    return None

loaded = []
for f in obs_files:
    d = json.load(open(f))
    for k, v in d.get("types", {}).items(): type_desc.setdefault(k, v)
    loaded.append((os.path.basename(f)[:-5], d))

def all_legs():
    """Each day's legs, plus flights that crossed midnight UTC stitched from a day's tails to the next day's heads."""
    for i, (day, d) in enumerate(loaded):
        for dep, arr, cs, t, ts in d["legs"]:
            yield day, dep, arr, cs, t, ts
        if i + 1 < len(loaded):
            heads = {(h[0], h[1]): h[2] for h in loaded[i + 1][1].get("heads", [])}
            for hexid, cs, t, dep, ts in d.get("tails", []):
                arr = heads.get((hexid, cs))
                if arr: yield day, dep, arr, cs, t, ts

n_legs = n_ok = 0
for day, deps, arrs, cs, t, ts in all_legs():
    n_legs += 1
    hit = resolve(deps, arrs, cs)
    if not hit: continue
    dep, arr, al, primary = hit
    n_ok += 1
    e = seen[(dep, arr, al)][cs]
    label_iata[cs] = primary
    e["days"].add(day)
    z = tz(dep)
    if z:
        lt = datetime.fromtimestamp(ts, timezone.utc).astimezone(z)
        e["times"].append(lt.hour * 60 + lt.minute)
    e["types"][t] += 1
print(f"observed: {n_legs} flights, {n_ok} matched to a known route and airline")

def typical_minute(ms):
    """Median takeoff time, handling flights that straddle midnight."""
    if not ms: return -1
    ref = statistics.median(ms)
    adj = [m + 1440 if m - ref < -720 else m - 1440 if m - ref > 720 else m for m in ms]
    return int(round(statistics.median(adj))) % 1440

def flight_label(cs):
    m = re.match(r"^[A-Z]{3}(\d+)$", cs)
    return f"{label_iata.get(cs, cs[:3])} {int(m.group(1))}" if m else cs

# ---------- assemble ----------
used = sorted(k for k, a in ap_ok.items() if a.get("routes"))
idx = {a: i for i, a in enumerate(used)}
al_names = {}
for a in ap_ok.values():
    for r in a.get("routes", []):
        for c in r["carriers"]:
            al_names.setdefault(c["iata"], c["name"])
al_list = sorted(al_names, key=lambda k: al_names[k])
al_idx = {k: i for i, k in enumerate(al_list)}
type_names, type_idx = [], {}
def tix(name):
    if name not in type_idx:
        type_idx[name] = len(type_names); type_names.append(name)
    return type_idx[name]

routes = [[] for _ in used]
details = defaultdict(dict)
stats = Counter()
for s in used:
    for r in ap_ok[s].get("routes", []):
        d = r["iata"]
        if d not in idx or d == s: continue
        als = sorted({c["iata"] for c in r["carriers"]})
        entry = [idx[d], int(r.get("min") or 0)] + [al_idx[a] for a in als]
        routes[idx[s]].append(entry)
        stats["routes"] += 1
        # details: per airline -> [source, flights or fallback]
        det = []
        any_obs = False
        for a in als:
            fl = seen.get((s, d, a))
            if fl:
                any_obs = True
                rows = []
                for cs, e in fl.items():
                    rows.append([flight_label(cs), typical_minute(e["times"]), len(e["days"]),
                                 [tix(pretty_type(type_desc.get(t), t)) for t, _ in e["types"].most_common(3)]])
                rows.sort(key=lambda x: (x[1] if x[1] >= 0 else 9999))
                det.append([al_idx[a], 1, rows[:14]])
                stats["airline_routes_observed"] += 1
            elif (s, d, a) in of2014:
                det.append([al_idx[a], 2, [tix(n) for n in sorted(of2014[(s, d, a)])]])
                stats["airline_routes_2014"] += 1
            else:
                det.append([al_idx[a], 0, []])
                stats["airline_routes_none"] += 1
        stats["routes_observed"] += any_obs
        details[s][d] = det

os.makedirs(os.path.join(out, "detail"), exist_ok=True)
for f in glob.glob(os.path.join(out, "detail", "*.json")): os.remove(f)
days = [os.path.basename(f)[:-5] for f in obs_files]
meta = {
    "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    "observedDays": days,
}
json.dump({
    "meta": meta,
    "airports": [[a, ap_ok[a]["name"], ap_ok[a].get("city_name") or "", ap_ok[a].get("country") or "",
                  round(float(ap_ok[a]["latitude"]), 4), round(float(ap_ok[a]["longitude"]), 4)] for a in used],
    "airlines": [[al_names[k], k, iata_country.get(k, "")] for k in al_list],
    "routes": routes,
}, open(os.path.join(out, "network.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
for s, det in details.items():
    json.dump(det,
              open(os.path.join(out, "detail", f"{s}.json"), "w", encoding="utf-8"), separators=(",", ":"))
json.dump(type_names, open(os.path.join(out, "types.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(used)} airports, {len(al_list)} airlines, {stats['routes']} routes; "
      f"{stats['routes_observed']} routes with flights seen over {len(days)} day(s); airline-routes: "
      f"{stats['airline_routes_observed']} seen, {stats['airline_routes_2014']} 2014 fallback, {stats['airline_routes_none']} no aircraft data")
