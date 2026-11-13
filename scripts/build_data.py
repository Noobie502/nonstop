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

# One everyday name per country (the source mixes "USA"/"United States", official long forms, etc.)
COUNTRY = {
    "USA": "United States", "Macau SAR": "Macau", "Macao": "Macau", "Hong Kong SAR": "Hong Kong",
    "Lao People's Democratic Republic": "Laos", "Democratic People's Republic of Korea": "North Korea",
    "Republic of Korea": "South Korea", "Republic of Moldova": "Moldova", "Republic of Serbia": "Serbia",
    "Republic of Yemen": "Yemen", "Syrian Arab Republic": "Syria", "Viet Nam": "Vietnam",
    "The Democratic Republic of The Congo": "DR Congo", "Congo": "Republic of the Congo",
    "United Republic of Tanzania": "Tanzania", "Brunei Darussalam": "Brunei", "East Timor": "Timor-Leste",
    "Svalbard & Jan Mayen Island": "Svalbard", "Wallis and Futuna Islands": "Wallis and Futuna",
    "Cote d'Ivoire": "Côte d'Ivoire", "Reunion": "Réunion", "Aland": "Åland", "Saint Barthelemy": "Saint Barthélemy",
    "Turkiye": "Türkiye", "St. Helena": "Saint Helena", "St. Pierre and Miquelon": "Saint Pierre and Miquelon",
    "St. Kitts and Nevis": "Saint Kitts and Nevis", "Czech Republic": "Czechia",
}
country = lambda a: COUNTRY.get(a.get("country") or "", a.get("country") or "")

def gc_km(a, b):
    import math
    la1, lo1, la2, lo2 = map(math.radians, (float(a["latitude"]), float(a["longitude"]), float(b["latitude"]), float(b["longitude"])))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(h)))

# Cleaned routes: (src, dst) -> {"min": scheduled minutes or 0 if unknown, "als": set of airline IATA}
CR, clean_log = {}, Counter()
for s_, a_ in ap_ok.items():
    for r in a_.get("routes", []):
        d_ = r.get("iata")
        if d_ not in ap_ok or d_ == s_: continue
        als_ = {c["iata"] for c in r.get("carriers", []) if c.get("iata")}
        if not als_: clean_log["dropped: no airline listed"] += 1; continue
        e = CR.setdefault((s_, d_), {"min": 0, "als": set()})
        if e["als"]: clean_log["merged duplicate route entries"] += 1
        e["als"] |= als_
        m_ = int(r.get("min") or 0)
        if m_ and (not e["min"] or m_ < e["min"]): e["min"] = m_
speed = lambda k, m: k / (m / 60) if m else None
plausible = lambda k, m: bool(m) and m <= 120 + k / 2 and (k < 50 or (speed(k, m) <= 1000 and (speed(k, m) >= 100 or k < 300)))  # short hops are mostly taxiing
dropped_routes = []
for (s_, d_), e in list(CR.items()):
    k, m_ = gc_km(ap_ok[s_], ap_ok[d_]), e["min"]
    if not m_: continue
    v = speed(k, m_)
    if v > 1000 and k > 2500:
        # faster than any airliner over a long distance: the source points at the wrong airport
        dropped_routes.append((s_, d_, round(k), m_)); del CR[(s_, d_)]; clean_log["dropped: impossible (wrong airport code in source)"] += 1
for (s_, d_), e in CR.items():
    k, m_ = gc_km(ap_ok[s_], ap_ok[d_]), e["min"]
    if not m_ or plausible(k, m_): continue
    back = CR.get((d_, s_))
    e["fix"] = back["min"] if back and plausible(k, back["min"]) else 0  # 0 = show an estimate instead
    clean_log["fixed: impossible flight time"] += 1
for e in CR.values():
    if "fix" in e: e["min"] = e.pop("fix")
for (s_, d_), e in CR.items():
    back = CR.get((d_, s_))
    if s_ < d_ and back and e["min"] and back["min"] and abs(e["min"] - back["min"]) > max(75, 0.45 * min(e["min"], back["min"])):
        # usually a time-zone slip in the source on one direction; the average cancels it out
        e["min"] = back["min"] = round((e["min"] + back["min"]) / 2 / 5) * 5
        clean_log["evened out: outbound/return times far apart"] += 1

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
    cap = lambda w: "-".join(x.capitalize() if x.isalpha() and x.isupper() and len(x) > 3 else x for x in w.split("-"))
    s = " ".join(cap(w) for w in s.split())
    s = re.sub(r"^DE Havilland", "De Havilland", s)
    s = s.replace("Mcdonnell", "McDonnell").replace("McDonnell-Douglas", "McDonnell Douglas")
    s = s.replace("De Havilland Canada", "De Havilland")
    return s

# Aircraft that don't fly scheduled airline routes (training, private and business flying)
NOT_AIRLINE = re.compile(r"Piper|Cirrus|Diamond|Mooney|Robinson|Bell |Eurocopter|Helicopter|Agusta|Sikorsky|Learjet|Gulfstream|"
                         r"Falcon|Challenger|Global \d|BD-700|Hawker|Phenom|Praetor|Legacy|PC-24|Thrush|Cherokee|Sailplane|"
                         r"Bonanza|Baron|Beechjet|Premier|Honda|Hercules|C-130|Aztec|Navajo|Seminole|Tecnam|Cub|Citation|Beech 35|Beech 55|Beech 58", re.I)
CESSNA_OK = re.compile(r"Cessna (208|402|404|408)|Caravan|SkyCourier|Businessliner", re.I)
# Allowlist: makers/models that airlines actually fly (anything else, e.g. gliders or microlights, is ignored)
AIRLINER = re.compile(r"Airbus(?! Helicopters)|Boeing|Embraer|Bombardier|Canadair|ATR|Aerospatiale|De Havilland|DHC-|Dash|Saab|Fokker|"
                      r"McDonnell|Douglas|Comac|Sukhoi|Antonov|Ilyushin|Tupolev|Yakovlev|BAe|British Aerospace|Avro|Dornier|"
                      r"Fairchild|Let L|Xian|Harbin|Beech(craft)? 1900|King Air|Caravan|Cessna 4\d\d|SkyCourier|PC-12|"
                      r"Britten-Norman|Islander|Trislander|Twin Otter|Beaver|Jetstream|Metro|Swearingen|Convair|Mitsubishi|Tecnam P-?2012", re.I)
def airline_type(name):
    if re.search(r"\bCessna\b", name, re.I) and not CESSNA_OK.search(name): return False
    return bool(AIRLINER.search(name)) and not NOT_AIRLINE.search(name)
# rough maximum range (km) by aircraft group, used to catch mis-tagged aircraft
RANGES = [
    (r"PC-12|Caravan|Cessna 4\d\d|King Air|Beech (1900|200|300|99)|Twin Otter|DHC-6|Islander|BN-2|Let L-410|Metro|Jetstream|EMB.?1[12]0|Y12|Dornier 228|Saab 340|SF340", 1300),
    (r"ATR|Dash 8|DHC-8|Saab 2000|Dornier 328|Fokker 50|AN-24|AN-140|An-24|IL114|MA60|Xian", 2000),
    (r"CRJ|Regional Jet|ERJ-1[34]5|EMB-1[34]5|ERJ-1[79]0-[12]00|ERJ-170|Embraer 1[79]\d|Avro|RJ\d|BAe 146|Fokker (70|100)|Superjet|ARJ", 5000),
    (r"A220|ERJ-190-[34]00|E2", 7000),
    (r"A31[89]|A32[01]|737|717|MD-8|MD-9|DC-9|C-?919|757", 8800),
]
def max_range(name):
    for pat, r in RANGES:
        if re.search(pat, name, re.I): return r
    return 99999

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
carriers_of = {k: e["als"] for k, e in CR.items()}
label_iata = {}  # callsign -> IATA used for its flight-number label

def resolve(deps, arrs, cs):
    """Pick the (dep, arr, airline) that is a known route flown by an airline this callsign maps to.
    If nearby airports make it ambiguous (e.g. SYD vs WSI, both served by the airline), skip the flight."""
    cands = icao_map.get(cs[:3])
    if not cands: return None
    hits = []
    for dep in deps:
        for arr in arrs:
            if dep == arr: continue
            cars = carriers_of.get((dep, arr))
            if not cars: continue
            al = next((a for a in cands if a in cars), None)
            if al: hits.append((dep, arr, al))
    if len({(h[0], h[1]) for h in hits}) != 1: return None
    dep, arr, al = hits[0]
    return dep, arr, al, cands[0]

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
    """'THA661' -> 'TG 661'. Alphanumeric radio call signs (e.g. 'AUA3A') aren't flight numbers, so they keep a '*'."""
    m = re.match(r"^[A-Z]{3}(\d+)$", cs)
    return f"{label_iata.get(cs, cs[:3])} {int(m.group(1))}" if m else cs + "*"

def good_types(e, k):
    """Aircraft types for one flight on a k-km route, dropping one-off mis-tags and aircraft that can't fly that far."""
    top = e["types"].most_common(1)[0][1] if e["types"] else 0
    out_ = []
    for t, c in e["types"].most_common():
        name = pretty_type(type_desc.get(t), t)
        if not airline_type(name): stats_t["light/private aircraft"] += c; continue
        if k > max_range(name) * 1.1: stats_t["beyond range"] += c; continue
        if c < 2 and c < 0.25 * top: stats_t["one-off mis-tag"] += c; continue
        out_.append((t, name))
    return out_
stats_t = Counter()

# ---------- aircraft families for the filter (airliners only) ----------
FAMILY_CODES = [
    ("Airbus A380", "A388"), ("Airbus A350", "A359 A35K"), ("Airbus A340", "A342 A343 A345 A346"),
    ("Airbus A330neo", "A338 A339"), ("Airbus A330", "A332 A333"), ("Airbus A300/A310", "A306 A30B A310"),
    ("Airbus A320neo family", "A19N A20N A21N"), ("Airbus A320 family", "A318 A319 A320 A321"),
    ("Airbus A220", "BCS1 BCS3"),
    ("Boeing 747", "B742 B743 B744 B748"), ("Boeing 777X", "B778 B779"), ("Boeing 777", "B772 B77L B773 B77W"),
    ("Boeing 787 Dreamliner", "B788 B789 B78X"), ("Boeing 767", "B762 B763 B764"), ("Boeing 757", "B752 B753"),
    ("Boeing 737 MAX", "B37M B38M B39M B3XM"), ("Boeing 737 (NG & Classic)", "B732 B733 B734 B735 B736 B737 B738 B739"),
    ("Boeing 717", "B712"), ("McDonnell Douglas MD-11", "MD11"),
    ("McDonnell Douglas MD-80/90 & DC-9", "MD81 MD82 MD83 MD87 MD88 MD90 DC91 DC93 DC95"),
    ("Embraer E-Jet E2", "E290 E295"), ("Embraer E-Jet", "E170 E75L E75S E190 E195"),
    ("Embraer ERJ-135/145", "E135 E145 E45X"), ("Bombardier CRJ", "CRJ1 CRJ2 CRJ7 CRJ9 CRJX"),
    ("ATR 42/72", "AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76"), ("De Havilland Dash 8", "DH8A DH8B DH8C DH8D"),
    ("COMAC C919", "C919"), ("COMAC ARJ21", "AJ27"), ("Sukhoi Superjet 100", "SU95"),
    ("Fokker 50/70/100", "F50 F70 F100"), ("BAe 146 / Avro RJ", "B461 B462 B463 RJ70 RJ85 RJ1H"),
    ("Saab 340/2000", "SF34 SB20"), ("Dornier 328", "D328 J328"), ("De Havilland Twin Otter", "DHC6"),
]
FAMILY_OF = {c: name for name, codes in FAMILY_CODES for c in codes.split()}

# ---------- assemble ----------
used = sorted({s for s, _ in CR} | {d for _, d in CR})
idx = {a: i for i, a in enumerate(used)}
al_names = {}
for a in ap_ok.values():
    for r in a.get("routes", []):
        for c in r.get("carriers", []):
            if c.get("iata"): al_names.setdefault(c["iata"], c["name"])
al_names = {k: v for k, v in al_names.items() if any(k in e["als"] for e in CR.values())}
al_list = sorted(al_names, key=lambda k: al_names[k])
al_idx = {k: i for i, k in enumerate(al_list)}
type_names, type_idx = [], {}
def tix(name):
    if name not in type_idx:
        type_idx[name] = len(type_names); type_names.append(name)
    return type_idx[name]

routes = [[] for _ in used]
fam_pairs = defaultdict(set)  # family -> {(s, d, airline)}
details = defaultdict(dict)
stats = Counter()
for (s, d), ce in sorted(CR.items()):
        if d not in idx: continue
        als = sorted(ce["als"])
        k_route = gc_km(ap_ok[s], ap_ok[d])
        entry = [idx[d], ce["min"]] + [al_idx[a] for a in als]
        routes[idx[s]].append(entry)
        stats["routes"] += 1
        # details: per airline -> [source, flights or fallback]
        det = []
        any_obs = False
        for a in als:
            fl = seen.get((s, d, a))
            rows = []
            if fl:
                for cs, e in fl.items():
                    num = re.match(r"^[A-Z]{3}(\d+)$", cs)
                    if num and int(num.group(1)) >= 5000 and len(e["days"]) == 1:
                        stats_t["one-off charter/positioning flight"] += 1; continue  # not a bookable timetable flight
                    gt = good_types(e, k_route)
                    if not gt: continue  # only light/mis-tagged aircraft: not a real airline flight
                    rows.append([flight_label(cs), typical_minute(e["times"]), len(e["days"]), [tix(n) for _, n in gt[:3]]])
                    for t, _ in gt:
                        if t in FAMILY_OF: fam_pairs[FAMILY_OF[t]].add((idx[s], idx[d], al_idx[a]))
                if not rows:
                    fl = None
            if fl and rows:
                any_obs = True
                rows.sort(key=lambda x: (x[1] if x[1] >= 0 else 9999))
                det.append([al_idx[a], 1, rows[:14]])
                stats["airline_routes_observed"] += 1
            elif any(airline_type(n) and k_route <= max_range(n) * 1.1 for n in of2014.get((s, d, a), ())):
                det.append([al_idx[a], 2, [tix(n) for n in sorted(of2014[(s, d, a)]) if airline_type(n) and k_route <= max_range(n) * 1.1]])
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
    "airports": [[a, ap_ok[a]["name"], ap_ok[a].get("city_name") or "", country(ap_ok[a]),
                  round(float(ap_ok[a]["latitude"]), 4), round(float(ap_ok[a]["longitude"]), 4)] for a in used],
    "airlines": [[al_names[k], k, iata_country.get(k, "")] for k in al_list],
    "routes": routes,
}, open(os.path.join(out, "network.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
for s, det in details.items():
    json.dump(det,
              open(os.path.join(out, "detail", f"{s}.json"), "w", encoding="utf-8"), separators=(",", ":"))
json.dump(type_names, open(os.path.join(out, "types.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
fams = sorted(fam_pairs, key=lambda f: -len(fam_pairs[f]))
json.dump({
    "families": [[f, len({(x[0], x[1]) for x in fam_pairs[f]})] for f in fams],
    # flat [s, d, airline, s, d, airline, ...] per family
    "pairs": [[v for t in sorted(fam_pairs[f]) for v in t] for f in fams],
}, open(os.path.join(out, "aircraft.json"), "w", encoding="utf-8"), separators=(",", ":"))
print("route cleaning:", dict(clean_log))
print("  dropped (wrong airport in source):", dropped_routes)
print("aircraft observations removed:", dict(stats_t))
print("aircraft families:", ", ".join(f"{f} ({len(fam_pairs[f])})" for f in fams))
print(f"{len(used)} airports, {len(al_list)} airlines, {stats['routes']} routes; "
      f"{stats['routes_observed']} routes with flights seen over {len(days)} day(s); airline-routes: "
      f"{stats['airline_routes_observed']} seen, {stats['airline_routes_2014']} 2014 fallback, {stats['airline_routes_none']} no aircraft data")
