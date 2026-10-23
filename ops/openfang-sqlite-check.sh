#!/usr/bin/env bash
# ops/openfang-sqlite-check.sh — OpenFang SQLite startup integrity (WS2, ferrous-warden).
#
# Runs BEFORE the OpenFang kernel starts (hooked into ops/openfang-run.sh).
# Verifies:
#   1. DB exists and is non-empty  (a green /health over a 0-byte DB is how
#      silent data loss happens — 2026-09-20: ~/.openfang/openfang.db was 0B)
#   2. PRAGMA integrity_check == "ok"
#   3. schema present: >= 1 table; records schema hash + schema_version (when a
#      version table exists) so schema drift is observable
# On success: takes a bounded snapshot (keep 5) into ~/.openfang/backups/ —
# this is what makes the NEXT boot self-healable. Event-driven (boot only),
# never a timer.
# On failure with a usable backup: restores the newest backup atomically,
# re-verifies, alerts fleet. On failure with NO backup: refuses boot (exit 1)
# UNLESS the DB was never initialized (missing/empty + zero backups = first
# boot), in which case it alerts and allows boot so the kernel can create it.
set -euo pipefail

DB="${OPENFANG_DB:-/home/toxic/.openfang/openfang.db}"
BKDIR="$(dirname "$DB")/backups"
KEEP="${OPENFANG_DB_BACKUPS_KEEP:-5}"
SQUAWK_ROOT="${SQUAWK_ROOT:-/home/toxic/.fleet-bus/squawk-root}"

log() { printf '[openfang-sqlite-check] %s\n' "$*" >&2; }

_squawk() {
  local title="$1" body="$2"
  [ -d "$SQUAWK_ROOT/fleet" ] || return 0
  (
    hodos -x 200
    local seq
    seq="$(python3 -c "
import re, glob
ms=[re.match(r'(\d+)-', f.split('/')[-1]) for f in glob.glob('$SQUAWK_ROOT/fleet/*.md')]
ns=[int(m.group(1)) for m in ms if m]
print((max(ns)+1) if ns else 1)")"
    {
      printf 'seq: %s\nfrom: openfang-sqlite-check\nto: all\nchannel: fleet\nts: %s\nstatus: discussion\ntitle: %s\n---\n' \
        "$seq" "$(date -Iseconds)" "$title"
      printf '%s\n' "$body"
    } > "$SQUAWK_ROOT/fleet/${seq}-openfang-sqlite.md"
  ) 200>"$BKDIR/.sqlite-check.lock" 2>/dev/null || true
}

schema_version() {
  # opportunistic: a schema_version / migrations / version table if the kernel keeps one
  local v=""
  for t in schema_version migrations db_version version; do
    v="$(sqlite3 "$1" "SELECT MAX(version) FROM $t;" 2>/dev/null || true)"
    [ -n "$v" ] && { echo "$v"; return 0; }
  done
  echo "unknown"
}

healthy() {
  [ -s "$1" ] || return 1
  [ "$(sqlite3 "$1" "PRAGMA integrity_check;" 2>/dev/null)" = "ok" ] || return 1
  [ "$(sqlite3 "$1" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null)" -ge 1 ] || return 1
  return 0
}

snapshot() {
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  cp -p "$DB" "$BKDIR/openfang.db.$ts"
  sqlite3 "$DB" ".schema" 2>/dev/null | sha256sum | awk '{print $1}' > "$BKDIR/openfang.db.$ts.schema"
  schema_version "$DB" > "$BKDIR/openfang.db.$ts.version" 2>/dev/null || true
  # prune beyond KEEP (newest first)
  ls -t "$BKDIR"/openfang.db.20[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" "$old.schema" "$old.version"
  done
  log "healthy — snapshot $ts (schema v$(cat "$BKDIR/openfang.db.$ts.version" 2>/dev/null || echo ?))"
}

latest_backup() { ls -t "$BKDIR"/openfang.db.20[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | head -1 || true; }

mkdir -p "$BKDIR"

if healthy "$DB"; then
  snapshot
  exit 0
fi

# --- unhealthy: try self-heal from the newest backup --------------------------
LB="$(latest_backup)"
if [ -n "$LB" ] && [ -s "$LB" ]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  cp -p "$DB" "$BKDIR/openfang.db.corrupt-$ts" 2>/dev/null || true
  tmp="$DB.restore.$$"
  if cp -p "$LB" "$tmp" && mv "$tmp" "$DB" && healthy "$DB"; then
    log "SELF-HEALED from $(basename "$LB")"
    _squawk "openfang-sqlite: self-healed from backup" \
      "openfang.db failed integrity at boot; atomically restored from backup $(basename "$LB"). Corrupt copy preserved as openfang.db.corrupt-$ts."
    exit 0
  fi
  log "FATAL: backup $(basename "$LB") also failed verification"
  _squawk "openfang-sqlite: FATAL — db corrupt, backup unusable" \
    "openfang.db failed integrity AND the newest backup $(basename "$LB") is unusable. Refusing OpenFang boot. Corrupt copy: openfang.db.corrupt-$ts. Manual recovery required."
  exit 1
fi

# --- no usable backup ----------------------------------------------------------
if [ ! -e "$DB" ] || [ ! -s "$DB" ]; then
  log "DB missing/empty and no backups exist — first boot, allowing kernel to initialize"
  _squawk "openfang-sqlite: empty db, no backups yet" \
    "openfang.db is empty and no backups exist — treating as first boot. A snapshot will be taken on the next healthy boot; after that, corruption self-heals."
  exit 0
fi

log "FATAL: openfang.db corrupt and no backups exist"
_squawk "openfang-sqlite: FATAL — db corrupt, no backups" \
  "openfang.db failed integrity and no backups exist. Refusing OpenFang boot. Manual recovery required."
exit 1
