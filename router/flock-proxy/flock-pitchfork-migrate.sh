#!/usr/bin/env bash
# flock-pitchfork-migrate.sh — retire systemd --user; restore flock to pitchfork.
# The estate already runs `pitchfork-bin supervisor run`. systemd was a second
# supervisor fighting for :25193. This script:
#   1. stops & removes the systemd unit
#   2. merges flock into the pitchfork daemon registry (native to the stack)
#   3. hooks mise env inheritance (so ~/.secrets flows in without flattening)
#   4. starts flock under pitchfork, verifies :25193 + /health
#   5. retires flock-ctl and the systemd-era shims
set -uo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN="$HOME/.flock-maxfix/pitchfork-$STAMP"
mkdir -p "$RUN"
LOG="$RUN/migrate.log"
: > "$LOG"
log(){ printf '%s\n' "$*" | tee -a "$LOG"; }
hdr(){ log ""; log "════════════════════════════════════════════════════════════════════"; log "$*"; log "════════════════════════════════════════════════════════════════════"; }
backup(){ [ -f "$1" ] && cp -a "$1" "$1.bak.$STAMP" && log "  backup: $1.bak.$STAMP"; }

hdr "flock-pitchfork-migrate $STAMP"

# ── 1. systemd teardown ────────────────────────────────────────────────────
hdr "1. retire systemd --user unit"
systemctl --user stop flock.service 2>&1 | tee -a "$LOG" || true
systemctl --user disable flock.service 2>&1 | tee -a "$LOG" || true
rm -f "$HOME/.config/systemd/user/flock.service"
systemctl --user daemon-reload 2>&1 | tee -a "$LOG" || true
systemctl --user reset-failed flock.service 2>&1 | tee -a "$LOG" || true
log "  systemd unit removed"
ss -tlnpH 'sport = :25193' 2>/dev/null | tee -a "$LOG" || log "  :25193 dark (expected)"

# ── 2. discover tools ──────────────────────────────────────────────────────
hdr "2. discover pitchfork / mise"
PITCHFORK=$(command -v pitchfork 2>/dev/null || echo "$HOME/.local/share/mise/installs/pitchfork/2.25/pitchfork")
MISE=$(command -v mise 2>/dev/null || echo "$HOME/.local/bin/mise")
[ -x "$PITCHFORK" ] && log "  pitchfork: $PITCHFORK" || { log "  ✗ pitchfork missing"; exit 1; }
[ -x "$MISE" ] && log "  mise:      $MISE" || log "  ⚠ mise not found (continuing with pitchfork only)"

# ── 3. locate pitchfork.toml / parent.toml ────────────────────────────────
hdr "3. locate pitchfork config"
mapfile -t PFCFG < <(
  find "$HOME/estate" "$HOME" -maxdepth 4 -type f \
    \( -name 'pitchfork.toml' -o -name 'parent.toml' \) \
    ! -path '*/target/*' ! -path '*/node_modules/*' ! -path '*/.git/*' \
    2>/dev/null | sort -u
)
log "  candidates:"
for f in "${PFCFG[@]}"; do
  n=$(grep -c 'flock' "$f" 2>/dev/null | head -1); n=${n:-0}
  log "    $f   (flock refs: $n)"
done

# Primary target: the pitchfork.toml with a daemon-list array, at estate root
PRIMARY=""
for f in "${PFCFG[@]}"; do
  if grep -qE '^daemons\s*=\s*\[' "$f" 2>/dev/null; then
    case "$f" in "$HOME/estate/pitchfork.toml"|"$HOME/estate/ranch/pitchfork.toml") PRIMARY="$f"; break;; esac
  fi
done
[ -z "$PRIMARY" ] && for f in "${PFCFG[@]}"; do
  grep -qE '^daemons\s*=\s*\[' "$f" 2>/dev/null && { PRIMARY="$f"; break; }
done
[ -z "$PRIMARY" ] && PRIMARY="$HOME/estate/pitchfork.toml"
log "  primary:   $PRIMARY"
backup "$PRIMARY"

# ── 4. merge flock daemon entry ────────────────────────────────────────────
hdr "4. merge [daemons.flock] into $PRIMARY"
python3 - "$PRIMARY" "$HOME" <<'PYEOF' | tee -a "$LOG"
import sys, pathlib, re
toml_path = pathlib.Path(sys.argv[1])
home = sys.argv[2]

if not toml_path.exists():
    toml_path.parent.mkdir(parents=True, exist_ok=True)
    toml_path.write_text("")

s = toml_path.read_text()

# 4a. ensure flock is in the top-level `daemons = [...]` array, if such an array exists.
def ensure_in_array(text, name):
    m = re.search(r'(?m)^daemons\s*=\s*\[([^\]]*)\]', text)
    if not m:
        return text, False
    body = m.group(1)
    names = [x.strip().strip('"').strip("'") for x in body.split(',') if x.strip()]
    if name in names:
        return text, False
    names.append(name)
    new_body = ", ".join(f'"{n}"' for n in names)
    new = f'daemons = [{new_body}]'
    return text[:m.start()] + new + text[m.end():], True

s, added = ensure_in_array(s, "flock")
if added: print(f"  + added 'flock' to daemons array")

# 4b. remove any existing [daemons.flock] section (replace wholesale).
# Match from `[daemons.flock]` to next top-level `[` or EOF.
s = re.sub(r'(?ms)^\[daemons\.flock\]\s*\n.*?(?=^\[|\Z)', '', s)

# 4c. append the canonical [daemons.flock] block.
block = f'''
[daemons.flock]
# managed by pitchfork (mise-native). systemd unit retired {pathlib.Path.home()}/.config/systemd/user/flock.service
run = "exec {home}/.flock/flock"
cwd = "{home}/estate/ranch/flock"
env = {{ HOST = "127.0.0.1", PORT = "25193", FLOCK_PORT = "25193", DATA_DIR = "{home}/.flock-data", FLOCK_DATA_DIR = "{home}/.flock-data", FLOCK_ASTMATRIX_DB = "{home}/estate/data/ast_matrix.db", RUST_LOG = "info" }}
port = 25193
ready_http = "http://127.0.0.1:25193/health"
ready_timeout = "60s"
retry = 5
retry_delay = "2s"
stop_signal = "SIGTERM"
stop_timeout = "15s"
watch = ["{home}/.flock/flock"]
watch_mode = "poll"
'''.lstrip("\n")
if not s.endswith("\n"): s += "\n"
s += "\n" + block
toml_path.write_text(s)
print(f"  wrote [daemons.flock] block")
PYEOF

# ── 5. mise env inheritance ────────────────────────────────────────────────
hdr "5. mise env inheritance"
MISE_TOML="$HOME/estate/mise.toml"
[ -f "$MISE_TOML" ] || MISE_TOML="$HOME/.config/mise/config.toml"
backup "$MISE_TOML"
python3 - "$MISE_TOML" "$HOME" <<'PYEOF' | tee -a "$LOG"
import sys, pathlib
mp = pathlib.Path(sys.argv[1]); home = sys.argv[2]
if not mp.exists():
    mp.parent.mkdir(parents=True, exist_ok=True)
    mp.write_text("")
s = mp.read_text()
need = [
  f'{home}/.secrets',
  f'{home}/estate/config/flock-ssot/flock.env',
]
if "[env]" not in s:
    s += "\n[env]\n"
# locate the [env] block, then ensure `_.file = [...]` includes our paths
import re
m = re.search(r'(?ms)^\[env\]\s*\n(.*?)(?=^\[|\Z)', s)
if m:
    body = m.group(1)
    fm = re.search(r'(?m)^_\s*\.\s*file\s*=\s*\[([^\]]*)\]', body)
    if fm:
        cur = [x.strip().strip('"').strip("'") for x in fm.group(1).split(",") if x.strip()]
        for p in need:
            if p not in cur: cur.append(p)
        new = "_." + "file = [" + ", ".join(f'"{x}"' for x in cur) + "]"
        # rewrite the whole line
        new_line = "_." + f'file = [{", ".join(chr(34)+x+chr(34) for x in cur)}]'
        body2 = re.sub(r'(?m)^_\s*\.\s*file\s*=\s*\[[^\]]*\]', new_line, body)
        s = s[:m.start()] + "[env]\n" + body2 + s[m.end():]
        print(f"  merged _.file: {cur}")
    else:
        ins = "_." + f'file = [{", ".join(chr(34)+x+chr(34) for x in need)}]\n'
        s = s[:m.start(1)] + ins + s[m.start(1):]
        print("  inserted _.file")
mp.write_text(s)
PYEOF

# ── 6. reload pitchfork / start flock ──────────────────────────────────────
hdr "6. reload pitchfork"
# Try mise daemons first (native), else pitchfork directly.
if "$MISE" daemons --help >/dev/null 2>&1; then
  "$MISE" daemons reload 2>&1 | tee -a "$LOG" || "$MISE" daemons register 2>&1 | tee -a "$LOG" || true
  "$MISE" daemons start flock 2>&1 | tee -a "$LOG" || true
else
  "$PITCHFORK" reload 2>&1 | tee -a "$LOG" || true
  "$PITCHFORK" start flock 2>&1 | tee -a "$LOG" || "$PITCHFORK" start estate/flock 2>&1 | tee -a "$LOG" || true
fi

# ── 7. readiness ───────────────────────────────────────────────────────────
hdr "7. wait for :25193 + /health"
ok=0
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:25193/health; then
    ok=1; log "  ready after ${i}s"; break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  log "  ✗ not ready — dumping pitchfork status:"
  if "$MISE" daemons --help >/dev/null 2>&1; then
    "$MISE" daemons status flock 2>&1 | tee -a "$LOG" || true
    "$MISE" daemons logs flock 2>&1 | tail -80 | tee -a "$LOG" || true
  else
    "$PITCHFORK" status 2>&1 | tee -a "$LOG" || true
    "$PITCHFORK" logs estate/flock 2>&1 | tail -80 | tee -a "$LOG" || true
  fi
  exit 1
fi

# ── 8. probe ───────────────────────────────────────────────────────────────
hdr "8. probe"
KEY=$(grep -m1 '^FLOCK_API_KEY=' "$HOME/estate/config/flock-ssot/flock.env" 2>/dev/null | cut -d= -f2- || true)
log "  key prefix: ${KEY:0:14}…"
curl -sS -i --max-time 5 http://127.0.0.1:25193/health 2>&1 | tee -a "$LOG"
log ""
log "  /v1/models:"
curl -sS -i --max-time 10 -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:25193/v1/models 2>&1 | head -20 | tee -a "$LOG"

# ── 9. retire flock-ctl and systemd-era artifacts ─────────────────────────
hdr "9. retire flock-ctl + systemd-era shims"
for f in \
  "$HOME/.local/bin/flock-ctl" \
  "$HOME/.flock/flock-launch.sh" \
  "$HOME/estate/config/flock-ssot/flock.env" \
; do
  [ -e "$f" ] || continue
  mv "$f" "$f.retired.$STAMP" 2>/dev/null || true
  log "  retired: $f → $f.retired.$STAMP"
done

# ── 10. canonical state ────────────────────────────────────────────────────
hdr "10. CANONICAL STATE"
PID=$(ss -tlnpH 'sport = :25193' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
H1=$(sha256sum "/proc/$PID/exe" 2>/dev/null | awk '{print $1}')
H2=$(sha256sum "$HOME/.flock/flock" 2>/dev/null | awk '{print $1}')
log "  :25193 owner:  pid=$PID"
log "  running hash:  $H1"
log "  on-disk hash:  $H2"
[ "$H1" = "$H2" ] && log "  ✓ running == on-disk" || log "  ✗ mismatch"
log ""
log "  pitchfork.toml:  $PRIMARY"
log "  mise env:        $MISE_TOML"
log "  systemd unit:    removed"
log ""
log "  daily ops (pitchfork-native):"
log "    mise daemons status flock"
log "    mise daemons restart flock"
log "    mise daemons logs flock --tail"
log "    mise daemons stop flock"
log ""
log "  no SIGHUP, no systemctl, no ExecReload trap."
log "  pitchfork supervisor owns the lifecycle, exactly like the other 50 daemons."

hdr "DONE — $LOG"
log "  archive: $RUN"
