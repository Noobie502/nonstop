#!/usr/bin/env bash
# Process the last N days of adsb.lol history into data-src/observed/<date>.json
# Usage: scripts/fetch_observed.sh <airports.json> <out_dir> [days=7]
set -uo pipefail
AP="$1"; OUT="$2"; DAYS="${3:-7}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
done_days=0
for back in $(seq 1 $((DAYS + 4))); do
  [ "$done_days" -ge "$DAYS" ] && break
  day=$(date -u -d "-$back day" +%Y.%m.%d)
  out="$OUT/${day//./-}.json"
  if [ -s "$out" ]; then done_days=$((done_days+1)); continue; fi
  tag="v${day}-planes-readsb-prod-0"
  base="https://github.com/adsblol/globe_history_${day%%.*}/releases/download/$tag/$tag.tar"
  parts=()
  for p in aa ab ac ad ae af; do
    code=$(curl -sIL -o /dev/null -w "%{http_code}" "$base.$p")
    [ "$code" = "200" ] && parts+=("$base.$p") || break
  done
  if [ ${#parts[@]} -eq 0 ]; then echo "no release for $day"; continue; fi
  echo "== $day: ${#parts[@]} parts"
  if curl -sSfL "${parts[@]}" | python3 -I "$HERE/observed.py" "$AP" "$out.tmp"; then
    mv "$out.tmp" "$out"; done_days=$((done_days+1))
  else
    echo "failed $day"; rm -f "$out.tmp"
  fi
done
# keep only the newest DAYS files
ls -1 "$OUT"/*.json 2>/dev/null | sort | head -n -"$DAYS" | xargs -r rm -f
echo "observed days: $(ls -1 "$OUT"/*.json | wc -l)"
