#!/usr/bin/env bash
set -uo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$HOME/.flock-maxfix/keys-$STAMP.log"; : > "$LOG"
log(){ printf '%s\n' "$*" | tee -a "$LOG"; }
hdr(){ log ""; log "════════════════════════════════════════════════════════════════════"; log "$*"; log "════════════════════════════════════════════════════════════════════"; }

hdr "flock-keys-fix $STAMP"

# ── 1. correct mise daemons invocation ────────────────────────────────────
hdr "1. mise daemons — correct name"
mise daemons ls 2>&1 | grep -i flock | tee -a "$LOG" || true

# ── 2. extract the *client* key from config.json ──────────────────────────
hdr "2. client key from config.json"
CFG="$HOME/.flock-data/config.json"
CLIENT_KEY=""
if [ -f "$CFG" ] && command -v jq >/dev/null 2>&1; then
  # Try common shapes
  CLIENT_KEY=$(jq -r '
    (.clients // .api_keys // .proxy_api_keys // .auth.client_keys // [])
    | if type=="array" then .[0] | if type=="object" then (.key // .value // .id) else . end
      elif type=="object" then (to_entries[0].value | if type=="object" then (.key // .value) else . end)
      else empty end
  ' "$CFG" 2>/dev/null)
  log "  jq candidate: ${CLIENT_KEY:0:14}…"
fi

# Fallback: any string starting with 'flock_' in config.json
if [ -z "$CLIENT_KEY" ]; then
  CLIENT_KEY=$(grep -oE '"flock_[A-Za-z0-9_-]{16,}"' "$CFG" 2>/dev/null | head -1 | tr -d '"')
  log "  grep candidate: ${CLIENT_KEY:0:14}…"
fi

# Fallback: ~/.secrets under FLOCK_CLIENT_KEY
if [ -z "$CLIENT_KEY" ] && [ -r "$HOME/.secrets" ]; then
  CLIENT_KEY=$(grep -m1 -E '^(FLOCK_CLIENT_KEY|FLOCK_KEY)=' "$HOME/.secrets" | cut -d= -f2- | tr -d '"')
  log "  secrets candidate: ${CLIENT_KEY:0:14}…"
fi

# ── 3. show ALL keys in config.json for manual pick ───────────────────────
hdr "3. all client keys found in $CFG (for inspection)"
if [ -f "$CFG" ]; then
  grep -oE '"flock_[A-Za-z0-9_-]{16,}"' "$CFG" 2>/dev/null | sort -u | tee -a "$LOG" || true
  grep -oE '"sk-[A-Za-z0-9_-]{16,}"' "$CFG" 2>/dev/null | sort -u | tee -a "$LOG" || true
fi

# ── 4. probe with whatever we found ──────────────────────────────────────
hdr "4. probe /v1/models with each candidate"
for K in "$CLIENT_KEY" \
         "$(grep -m1 '^FLOCK_API_KEY=' "$HOME/estate/config/flock-ssot/flock.env" 2>/dev/null | cut -d= -f2-)" \
; do
  [ -z "$K" ] && continue
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H "Authorization: Bearer $K" http://127.0.0.1:25193/v1/models)
  log "  ${K:0:16}…  →  HTTP $code"
done

# ── 5. canonical ops ──────────────────────────────────────────────────────
hdr "5. canonical ops (the correct names)"
log "  mise daemons ls                      # list all"
log "  mise daemons status estate/flock     # not 'flock'"
log "  mise daemons restart estate/flock"
log "  mise daemons logs estate/flock"
log "  mise daemons stop estate/flock"

hdr "DONE — $LOG"
