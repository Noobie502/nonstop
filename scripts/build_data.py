"""Build compact JSON from OpenFlights airports/routes/airlines/planes .dat files.
Usage: python3 scripts/build_data.py <raw_dir> <out_dir>

network.json:
  airports: [iata, name, city, country, lat, lon]
  airlines: [name, iata, country]
  planes:   [code, name]
  routes[i] (one list per airport): [dest, [airline, codeshare(0/1), plane...], ...]
"""
import csv, json, sys, os
from collections import defaultdict
raw, out = sys.argv[1], sys.argv[2]
N = lambda v: None if v in ("\\N", "", "-") else v
rd = lambda f: csv.reader(open(os.path.join(raw, f), encoding="utf-8"))

airlines = {r[0]: (r[1], N(r[3]) or N(r[4]) or "", N(r[6]) or "") for r in rd("airlines.dat")}
planes = {}
for r in rd("planes.dat"):
    if N(r[1]): planes[r[1]] = r[0]
    if N(r[2]): planes.setdefault(r[2], r[0])

# Common IATA type codes that planes.dat doesn't name (family / variant codes).
EXTRA = {
    "313": "Airbus A310-300", "32A": "Airbus A320 (sharklets)", "32B": "Airbus A321 (sharklets)",
    "32C": "Airbus A319 (sharklets)", "32S": "Airbus A318/A319/A320/A321", "33X": "Airbus A330-200F",
    "73C": "Boeing 737-300 (winglets)", "73H": "Boeing 737-800 (winglets)", "73J": "Boeing 737-900 (winglets)",
    "73M": "Boeing 737-200 Combi", "73N": "Boeing 737-300", "73Q": "Boeing 737-400", "73R": "Boeing 737-700C",
    "73W": "Boeing 737-700 (winglets)", "74E": "Boeing 747-400 Combi", "74H": "Boeing 747-8I",
    "74M": "Boeing 747 Combi", "74N": "Boeing 747-8F", "74Y": "Boeing 747-400F",
    "75T": "Boeing 757-300 (winglets)", "75W": "Boeing 757-200 (winglets)", "76F": "Boeing 767 Freighter",
    "76W": "Boeing 767-300 (winglets)", "77X": "Boeing 777-200F", "AB4": "Airbus A300B4", "ARJ": "Avro RJ",
    "BE1": "Beechcraft 1900", "BE9": "Beechcraft King Air", "BEC": "Beechcraft (light)", "BET": "Beechcraft (twin)",
    "CN2": "Cessna (piston twin)", "CNA": "Cessna (light)", "CNC": "Cessna (turboprop)", "CNT": "Cessna (twin)",
    "CRA": "Bombardier CRJ-705", "CRJ": "Bombardier CRJ", "DC9": "McDonnell Douglas DC-9", "DH8": "De Havilland Dash 8",
    "EMJ": "Embraer E-Jet", "ERJ": "Embraer ERJ", "IL9": "Ilyushin Il-96", "L4T": "Let L-410",
    "M1F": "McDonnell Douglas MD-11F", "M80": "McDonnell Douglas MD-80", "MA6": "Xian MA600",
    "SFB": "Saab 340B", "SWM": "Fairchild Metro", "YN7": "Xian Y-7",
}
for k, v in EXTRA.items(): planes.setdefault(k, v)

ap = {}
for r in rd("airports.dat"):
    iata = N(r[4])
    if iata and len(iata) == 3:
        ap[iata] = [iata, r[1], r[2], r[3], round(float(r[6]), 4), round(float(r[7]), 4)]

# (src, dst) -> airline key -> [codeshare, set(planes)]
pairs = defaultdict(dict)
for r in rd("routes.dat"):
    if len(r) < 9 or r[7] != "0": continue
    s, d = r[2], r[4]
    if s not in ap or d not in ap or s == d: continue
    al = airlines.get(r[1])
    key = (al[0], al[1], al[2]) if al else (r[0], r[0], "")
    cs = 1 if r[6] == "Y" else 0
    e = pairs[(s, d)].setdefault(key, [cs, set()])
    e[0] = min(e[0], cs)
    e[1].update(x for x in r[8].split() if x)

used = sorted({a for p in pairs for a in p})
idx = {a: i for i, a in enumerate(used)}
al_list = sorted({k for v in pairs.values() for k in v})
al_idx = {k: i for i, k in enumerate(al_list)}
pl_list = sorted({p for v in pairs.values() for e in v.values() for p in e[1]})
pl_idx = {p: i for i, p in enumerate(pl_list)}

routes = [[] for _ in used]
for (s, d), als in sorted(pairs.items()):
    entry = [idx[d]]
    for k, (cs, pls) in sorted(als.items(), key=lambda kv: (kv[1][0], kv[0][0])):
        entry.append([al_idx[k], cs] + sorted(pl_idx[p] for p in pls))
    routes[idx[s]].append(entry)

json.dump({
    "airports": [ap[a] for a in used],
    "airlines": [list(k) for k in al_list],
    "planes": [[p, planes.get(p, "")] for p in pl_list],
    "routes": routes,
}, open(os.path.join(out, "network.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
unk = [p for p in pl_list if p not in planes]
print(len(used), "airports,", len(pairs), "routes,", len(al_list), "airlines,", len(pl_list), "aircraft types; unnamed:", unk[:20])
