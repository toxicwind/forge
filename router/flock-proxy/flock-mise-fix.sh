#!/usr/bin/env bash
# flock-mise-fix.sh — restore mise.toml, correctly merge _.file, start flock.
set -uo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN="$HOME/.flock-maxfix/mise-fix-$STAMP"
mkdir -p "$RUN"; LOG="$RUN/fix.log"; : > "$LOG"
log(){ printf '%s\n' "$*" | tee -a "$LOG"; }
hdr(){ log ""; log "════════════════════════════════════════════════════════════════════"; log "$*"; log "════════════════════════════════════════════════════════════════════"; }

hdr "flock-mise-fix $STAMP"

MISE="$HOME/estate/mise.toml"
LATEST_BAK=$(ls -1t "$MISE".bak.* 2>/dev/null | head -1)

# ── 1. restore mise.toml from the most recent backup ────────────────────────
hdr "1. restore mise.toml"
if [ -n "$LATEST_BAK" ]; then
  cp -a "$LATEST_BAK" "$MISE"
  log "  restored from $LATEST_BAK"
else
  log "  ✗ no backup found — inspect $MISE manually at line 23"
  exit 1
fi

# ── 2. verify it parses now ────────────────────────────────────────────────
hdr "2. verify mise.toml parses"
if mise ls >/dev/null 2>&1; then
  log "  ✓ mise parses $MISE cleanly"
else
  log "  ✗ still broken — showing lines 15–30:"
  sed -n '15,30p' "$MISE" | tee -a "$LOG"
  exit 1
fi

# ── 3. correctly merge _.file (append-only, handles string OR array) ───────
hdr "3. merge _.file"
python3 - "$MISE" "$HOME" <<'PYEOF' | tee -a "$LOG"
import sys, pathlib, re
mp = pathlib.Path(sys.argv[1]); home = sys.argv[2]
s = mp.read_text()
want = [f"{home}/.secrets", f"{home}/estate/config/flock-ssot/flock.env"]

# find the [env] block
m = re.search(r'(?ms)^\[env\]\s*\n(.*?)(?=^\[|\Z)', s)
if not m:
    s += '\n[env]\n_.file = [' + ', '.join(f'"{p}"' for p in want) + ']\n'
    mp.write_text(s); print("  appended fresh [env] block"); raise SystemExit

body = m.group(1)

# case A: _.file = "single"   (string form)
sm = re.search(r'(?m)^_\s*\.\s*file\s*=\s*"([^"]*)"\s*$', body)
if sm:
    cur = [sm.group(1)]
    for p in want:
        if p not in cur: cur.append(p)
    new_line = '_.' + 'file = [' + ', '.join(f'"{x}"' for x in cur) + ']'
    body2 = body[:sm.start()] + new_line + body[sm.end():]
    s = s[:m.start(1)] + body2 + s[m.end(1):]
    mp.write_text(s); print(f"  string→array: {cur}"); raise SystemExit

# case B: _.file = [ "a", "b" ]   (array form)
am = re.search(r'(?m)^_\s*\.\s*file\s*=\s*\[([^\]]*)\]\s*$', body)
if am:
    cur = [x.strip().strip('"').strip("'") for x in am.group(1).split(",") if x.strip()]
    for p in want:
        if p not in cur: cur.append(p)
    new_line = '_.' + 'file = [' + ', '.join(f'"{x}"' for x in cur) + ']'
    body2 = body[:am.start()] + new_line + body[am.end():]
    s = s[:m.start(1)] + body2 + s[m.end(1):]
    mp.write_text(s); print(f"  array merged: {cur}"); raise SystemExit

# case C: no _.file in [env] — insert as array
ins = '_.' + 'file = [' + ', '.join(f'"{p}"' for p in want) + ']\n'
s = s[:m.start(1)] + ins + s[m.start(1):]
mp.write_text(s); print("  inserted _.file array")
PYEOF

# ── 4. verify mise still parses ────────────────────────────────────────────
if mise ls >/dev/null 2>&1; then log "  ✓ mise parses after merge"; else
  log "  ✗ broken again — showing [env] block:"
  awk '/^\[env\]/{p=1} p&&/^\[/&&!/^\[env\]/{p=0} p' "$MISE" | tee -a "$LOG"
  exit 1
fi

# ── 5. start flock via pitchfork ──────────────────────────────────────────
hdr "4. start flock via pitchfork"
# mise daemons subcommands: start | stop | restart | ls | status | logs | tui
mise daemons restart flock 2>&1 | tee -a "$LOG" \
  || mise daemons start flock 2>&1 | tee -a "$LOG" \
  || pitchfork restart estate/flock 2>&1 | tee -a "$LOG" \
  || pitchfork start estate/flock 2>&1 | tee -a "$LOG" \
  || true

# ── 6. readiness ──────────────────────────────────────────────────────────
hdr "5. wait for :25193"
ok=0
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:25193/health; then
    ok=1; log "  ready after ${i}s"; break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  log "  ✗ not ready — mise daemons status/logs:"
  mise daemons status flock 2>&1 | tee -a "$LOG" || true
  mise daemons logs flock 2>&1 | tail -80 | tee -a "$LOG" || true
  pitchfork status 2>&1 | tee -a "$LOG" || true
  exit 1
fi

# ── 7. probe ──────────────────────────────────────────────────────────────
hdr "6. probe"
KEY=$(grep -m1 '^FLOCK_API_KEY=' "$HOME/estate/config/flock-ssot/flock.env" 2>/dev/null | cut -d= -f2- || true)
log "  key prefix: ${KEY:0:14}…"
curl -sS -i --max-time 5 http://127.0.0.1:25193/health 2>&1 | tee -a "$LOG"
log ""
curl -sS --max-time 10 -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:25193/v1/models 2>&1 | head -c 400 | tee -a "$LOG"
log ""

# ── 8. canonical state ────────────────────────────────────────────────────
hdr "7. CANONICAL STATE"
PID=$(ss -tlnpH 'sport = :25193' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && log "  :25193 owner: pid=$PID exe=$(readlink -f /proc/$PID/exe)" \
              || log "  ✗ :25193 has no listener"
log ""
log "  mise.toml:  $MISE"
log "  pitchfork:  $HOME/estate/pitchfork.toml"
log ""
log "  ops:  mise daemons {start|stop|restart|status|logs} flock"
hdr "DONE — $LOG"
