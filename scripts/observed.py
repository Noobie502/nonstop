"""Extract observed airline flights from one day of adsb.lol readsb history.

Reads the day's tar archive as a stream on stdin (the release parts concatenated),
turns each aircraft track into flight legs, and writes one JSON file:

  curl -sL .../X.tar.aa .../X.tar.ab | python3 scripts/observed.py airports.json out/2026-11-06.json

Output:
  legs:  [dep_candidates, arr_candidates, callsign, icao_type, takeoff_unix]
  tails: flights still airborne at the end of the UTC day:   [hex, callsign, type, dep_candidates, takeoff_unix]
  heads: flights already airborne at the start of the UTC day: [hex, callsign, arr_candidates]
  types: ICAO type -> readsb description

Candidates are up to 3 airport IATA codes, nearest first. A track end seen on the ground or
below 4,000 ft gets airports within 10 km; one first/last seen higher (patchy receiver
coverage) gets airports within 60 km, and the build step keeps only combinations that are
known routes. Tails and heads are joined across consecutive days by the build step.
"""
import gzip, json, math, re, sys, tarfile
from collections import Counter
from multiprocessing import Pool

LOW_FT, MID_FT = 4000, 15000
NEAR_KM, FAR_KM = 10, 60
GAP_S = 45 * 60          # a gap this long at low altitude splits legs
EDGE_S = 6 * 60          # this close to 00:00 / 24:00 UTC counts as cut by the day boundary
CALLSIGN = re.compile(r"^([A-Z]{3})(\d[0-9A-Z]{0,4})$")

AIRPORTS = None          # list of (iata, lat, lon)
GRID = None              # (lat_cell, lon_cell) -> [airport idx]


def load_airports(path):
    global AIRPORTS, GRID
    data = json.load(open(path, encoding="utf-8"))
    AIRPORTS = [(a["iata"], float(a["latitude"]), float(a["longitude"]))
                for a in data.values() if a.get("latitude") and a.get("longitude")]
    GRID = {}
    for i, (_, la, lo) in enumerate(AIRPORTS):
        GRID.setdefault((int(math.floor(la)), int(math.floor(lo))), []).append(i)


def candidates(la, lo, max_km):
    ci, cj = int(math.floor(la)), int(math.floor(lo))
    found = []
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            for i in GRID.get((ci + di, (cj + dj + 180) % 360 - 180), ()):
                _, la2, lo2 = AIRPORTS[i]
                x = math.radians(lo2 - lo) * math.cos(math.radians((la + la2) / 2))
                d = 6371 * math.hypot(x, math.radians(la2 - la))
                if d < max_km:
                    found.append((d, AIRPORTS[i][0]))
    return [c for _, c in sorted(found)[:3]]


def alt(p):
    a = p[3]
    return 0 if a == "ground" else a if isinstance(a, (int, float)) else None


def end_airports(p):
    """Airport candidates for a track end, or None if it is too high to tell."""
    a = alt(p)
    if a is None:
        return None
    if a < LOW_FT:
        return candidates(p[1], p[2], NEAR_KM)
    if a < MID_FT:
        return candidates(p[1], p[2], FAR_KM)
    return None


def takeoff_time(s):
    first = s[0]
    a = alt(first) or 0
    if a < LOW_FT:
        return next((p[0] for p in s if (alt(p) or 0) > 500), first[0])
    return first[0] - a / 2000 * 60  # first seen mid-climb: back off at ~2,000 ft/min


def legs_from(raw):
    """Parse one trace file -> (legs, tails, heads, (type, desc))."""
    try:
        try:
            d = json.loads(gzip.decompress(raw))
        except OSError:
            d = json.loads(raw)
    except Exception:
        return [], [], [], None
    t, hexid = d.get("t"), str(d.get("icao", ""))
    tr = d.get("trace") or []
    if not t or len(tr) < 10 or hexid.startswith("~"):
        return [], [], [], None
    base = d.get("timestamp", 0)

    segs, cur = [], []
    for p in tr:
        if cur and ((p[6] or 0) & 2 or (p[0] - cur[-1][0] > GAP_S and (alt(p) or 0) < LOW_FT)):
            segs.append(cur)
            cur = []
        cur.append(p)
    if cur:
        segs.append(cur)

    legs, tails, heads = [], [], []
    for s in segs:
        if len(s) < 5 or not any((alt(p) or 0) > 8000 for p in s):
            continue
        calls = Counter((p[8].get("flight") or "").strip() for p in s if isinstance(p[8], dict) and p[8].get("flight"))
        if not calls:
            continue
        cs = calls.most_common(1)[0][0]
        if not CALLSIGN.match(cs):
            continue
        dep, arr = end_airports(s[0]), end_airports(s[-1])
        cut_start = s[0][0] < EDGE_S and not dep
        cut_end = s[-1][0] > 86400 - EDGE_S and not arr
        if dep and arr:
            if s[-1][0] - s[0][0] >= 15 * 60:
                legs.append([dep, arr, cs, t, int(base + takeoff_time(s))])
        elif dep and cut_end:
            tails.append([hexid, cs, t, dep, int(base + takeoff_time(s))])
        elif arr and cut_start:
            heads.append([hexid, cs, arr])
    return legs, tails, heads, (t, d.get("desc") or "")


def members(stream):
    tf = tarfile.open(fileobj=stream, mode="r|")
    try:
        for m in tf:
            if m.isfile() and "/traces/" in "/" + m.name.lstrip("./"):
                yield tf.extractfile(m).read()
    except (tarfile.ReadError, EOFError) as e:
        print("archive ended early:", e, file=sys.stderr)


def main():
    ap_path, out_path = sys.argv[1], sys.argv[2]
    load_airports(ap_path)
    legs, tails, heads, types, n = [], [], [], {}, 0
    with Pool(initializer=load_airports, initargs=(ap_path,)) as pool:
        for lg, tl, hd, ty in pool.imap_unordered(legs_from, members(sys.stdin.buffer), chunksize=64):
            n += 1
            legs += lg; tails += tl; heads += hd
            if ty and ty[1] and (lg or tl):
                types.setdefault(ty[0], ty[1])
            if n % 25000 == 0:
                print(f"{n} tracks, {len(legs)} legs", file=sys.stderr, flush=True)
    json.dump({"legs": legs, "tails": tails, "heads": heads, "types": types},
              open(out_path, "w"), separators=(",", ":"))
    print(f"done: {n} tracks, {len(legs)} legs, {len(tails)} tails, {len(heads)} heads", file=sys.stderr)


if __name__ == "__main__":
    main()
