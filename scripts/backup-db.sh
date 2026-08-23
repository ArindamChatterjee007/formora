#!/usr/bin/env bash
# ============================================================
# Formora — full Supabase export. RUN THIS BEFORE ANY destructive DB op
# (wipe, migration, RLS change). Dumps every public table to a timestamped
# folder as JSON. Uses the PUBLIC anon key from config.js (no secrets).
#
#   ./scripts/backup-db.sh
#
# Restore a table later with scripts/restore-table.sh (or re-insert the JSON).
# NOTE: auth.users is NOT exported here (needs the dashboard/service role) —
# but all member content (posts, profiles, DMs, etc.) is.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

ANON="$(grep -oE 'window.SUPABASE_ANON_KEY = "[^"]+"' js/config.js | sed -E 's/.*"(.*)"/\1/')"
URL="$(grep -oE 'window.SUPABASE_URL = "[^"]+"' js/config.js | sed -E 's/.*"(.*)"/\1/')"
BASE="${URL%/}/rest/v1"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="backups/$STAMP"
mkdir -p "$OUT"

TABLES="profiles posts comments stories requests messages notifications accounts"
echo "Backing up $URL"
echo "→ $OUT"
total=0
for t in $TABLES; do
  code=$(curl -s -o "$OUT/$t.json" -w "%{http_code}" "$BASE/$t?select=*" \
    -H "apikey: $ANON" -H "Authorization: Bearer $ANON")
  if [ "$code" = "200" ]; then
    n=$(python3 -c "import json,sys;print(len(json.load(open('$OUT/$t.json'))))" 2>/dev/null || echo "?")
    printf "  %-14s %s rows\n" "$t" "$n"
    [ "$n" != "?" ] && total=$((total + n)) || true
  else
    printf "  %-14s HTTP %s (skipped — RLS may block anon; export via dashboard)\n" "$t" "$code"
  fi
done
# tiny manifest so a restore knows what/when
python3 - "$OUT" "$STAMP" "$total" <<'PY'
import json,sys,os
out,stamp,total=sys.argv[1],sys.argv[2],sys.argv[3]
files={f:os.path.getsize(os.path.join(out,f)) for f in os.listdir(out) if f.endswith('.json')}
json.dump({"stamp":stamp,"total_rows":int(total),"files":files},open(os.path.join(out,"_manifest.json"),"w"),indent=2)
PY
echo "Done — $total rows saved to $OUT"
