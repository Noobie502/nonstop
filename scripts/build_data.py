"""Build compact JSON from OpenFlights airports.dat / routes.dat / airlines.dat.
Usage: python3 scripts/build_data.py <raw_dir> <out_dir>"""
import csv, json, sys, os
from collections import defaultdict
raw, out = sys.argv[1], sys.argv[2]
N = lambda v: None if v in ("\\N", "") else v

airlines = {}
with open(os.path.join(raw, "airlines.dat"), encoding="utf-8") as f:
    for r in csv.reader(f):
        airlines[r[0]] = (r[1], N(r[3]) or N(r[4]) or "")

ap = {}
with open(os.path.join(raw, "airports.dat"), encoding="utf-8") as f:
    for r in csv.reader(f):
        iata = N(r[4])
        if not iata or len(iata) != 3: continue
        ap[iata] = dict(iata=iata, name=r[1], city=r[2], country=r[3],
                        lat=round(float(r[6]), 4), lon=round(float(r[7]), 4))

pairs = defaultdict(set)
with open(os.path.join(raw, "routes.dat"), encoding="utf-8") as f:
    for r in csv.reader(f):
        if len(r) < 9 or r[7] != "0": continue
        s, d = r[2], r[4]
        if s in ap and d in ap and s != d:
            al = airlines.get(r[1])
            pairs[(s, d)].add(al[0] if al else r[0])

used = sorted({a for p in pairs for a in p})
idx = {a: i for i, a in enumerate(used)}
airports = [[ap[a][k] for k in ("iata","name","city","country","lat","lon")] for a in used]
dest = defaultdict(list)
al_names = sorted({n for s in pairs.values() for n in s})
al_idx = {n: i for i, n in enumerate(al_names)}
for (s, d), als in sorted(pairs.items()):
    dest[idx[s]].append([idx[d]] + sorted(al_idx[n] for n in als))
routes = [dest.get(i, []) for i in range(len(used))]
json.dump({"airports": airports, "airlines": al_names, "routes": routes},
          open(os.path.join(out, "network.json"), "w", encoding="utf-8"),
          ensure_ascii=False, separators=(",", ":"))
print(len(airports), "airports,", len(pairs), "directed routes,", len(al_names), "airlines")
top = sorted(range(len(used)), key=lambda i: -len(routes[i]))[:8]
print("top:", [(used[i], len(routes[i])) for i in top])
