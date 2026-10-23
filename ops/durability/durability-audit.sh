#!/usr/bin/env bash
# durability-audit.sh — estate durability guard.
#
# Hunts the recurring monkey-patch classes (anvil, 2026-09-20):
#   1. processes anchored in ephemeral paths (/tmp, /dev/shm) doing real jobs
#   2. listening TCP ports with no pitchfork.toml daemon coverage
#   3. shell profiles containing daemon logic (belongs in pitchfork/systemd)
#   4. cron files / systemd units referencing ephemeral paths
#   5. uncommitted live edits in /home/toxic/estate (state paths excluded)
#
# Alerts to squawk fleet ONLY when findings exist (alert on conditions, not on
# a timer). Exit 0 = clean, 2 = findings reported.
#
# Usage: durability-audit.sh [--alert]   # --alert posts to fleet; default prints
set -uo pipefail

REPO="${ESTATE_REPO:-/home/toxic/estate}"
TOML="$REPO/pitchfork.toml"
ALLOW="$REPO/ops/durability/allowlist.txt"
SQUAWK_ROOT="${SQUAWK_ROOT:-/home/toxic/.fleet-bus/squawk-root}"
CHANNEL="fleet"
ALERT=0
[[ "${1:-}" == "--alert" ]] && ALERT=1

FINDINGS=()
note() { FINDINGS+=("$1"); }

allowed() { # allowed <text> — true if text matches any non-comment allowlist line
    [[ -f "$ALLOW" ]] || return 1
    local line pat
    while IFS= read -r line; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line//[[:space:]]/}" ]] && continue
        pat="$line"
        [[ "$1" == *"$pat"* ]] && return 0
    done < "$ALLOW"
    return 1
}

# --- 1. processes anchored in ephemeral paths --------------------------------
SELF=$$
while IFS= read -r proc; do
    pid="${proc%% *}"; args="${proc#* }"
    [[ "$pid" == "$SELF" ]] && continue
    allowed "$args" && continue
    note "EPHEMERAL-PROC pid=$pid cmd=$args"
done < <(ps -eo pid=,args= 2>/dev/null | grep -E '/tmp/|/dev/shm/' | grep -v 'grep -E' || true)

# --- 2. listening ports without pitchfork coverage ---------------------------
# Build port -> daemon-name map from the toml (ready_* AND run lines), then
# derive coverage. A port is covered if any daemon section claims it.
declare -A PORT_OWNER=()
if [[ -f "$TOML" ]]; then
    while IFS=' ' read -r port daemon; do
        [[ -n "$port" ]] && PORT_OWNER["$port"]="$daemon"
    done < <(awk '
        /^\[daemons\./ { gsub(/\[daemons\.|\]/, ""); daemon=$0; next }
        {
            # strip comments first (timestamps like 18:03 and doc notes like
            # :25379 are not ports). Heuristic: no "#" inside quoted strings here.
            sub(/#.*$/, "")
            line=$0
            # :PORT groups (ready_http URLs, --listen addr:port, sport = :PORT, ...)
            while (match(line, /:[0-9]+/)) {
                port=substr(line, RSTART+1, RLENGTH-1)
                if (port != "") print port, daemon
                line=substr(line, RSTART+RLENGTH)
            }
            # PORT = "NNNN" / --port NNNN (env blocks, flag args)
            if (match($0, /[Pp][Oo][Rr][Tt][^0-9]{1,6}[0-9]+/)) {
                s=substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", s)
                if (s != "") print s, daemon
            }
        }' "$TOML" | sort -u)
fi
declare -A COVERED=()
for p in "${!PORT_OWNER[@]}"; do COVERED["$p"]=1; done
# statically-known platform ports (not pitchfork-managed by design).
# Format: port — what it is. Keep this list honest: every entry verified.
for p in \
    22 `# sshd` \
    443 `# tailscaled funnel` \
    9090 `# cockpit` \
    34567 `# tailscale /files` \
    8377 8378 8379 `# bridge backends (mcp, gemini-mcp, exec-ws)` \
    25135 25147 `# squawk feed + ws` \
    5037 `# adb fork-server (dev tooling)` \
    8420 `# ralph-dashboard (own launcher)` \
    9749 `# codebase-memory-mcp daemon` \
    10200 `# boundless uvicorn (own venv)` \
    20241 `# cloudflared tunnel -> 8379` \
    25014 `# llama-server beellama (own start)` \
    25102 `# yote.ts (own start)` \
    25108 `# Estate_web (own start)` \
    25134 `# qdrant second listen (same supervised proc as 25133)` \
    25160 `# forensics-srv (own venv)` \
    25161 `# herd-race (own start)` \
    25205 `# prometheus backend (mesh-front proxy on :25105 is pitchfork-managed)` \
    25210 `# grafana backend (mesh-front proxy on :25110 is pitchfork-managed)` \
    ; do COVERED["$p"]=1; done
# --- 2b. running daemon whose toml port has nothing listening (stale definition) --
# Only flag when pitchfork reports the daemon RUNNING: a stopped daemon's
# silent port is normal, a running daemon's silent port is drift.
if [[ -f "$TOML" ]]; then
    PF_BIN="${PITCHFORK_BIN:-$HOME/.local/share/mise/shims/pitchfork}"
    for p in "${!PORT_OWNER[@]}"; do
        ss -ltn 2>/dev/null | grep -qE "[:.]$p([^0-9]|$)" && continue
        d="${PORT_OWNER[$p]}"
        st="$("$PF_BIN" status --json "Estate/$d" 2>/dev/null | \
              python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
        [[ "$st" == "running" ]] && \
            note "STALE-READY :$p (daemon $d reports running but nothing listens; re-register via bin/pitchfork-restart)"
    done
fi
while IFS= read -r line; do
    port="${line##*:}"
    [[ -z "${COVERED[$port]:-}" ]] || continue
    holders="$(ss -tlnp 2>/dev/null | grep -E "[:.]$port([^0-9]|$)" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | tr '\n' ' ')"
    procs=""
    for h in $holders; do
        c="$(tr '\0' ' ' < "/proc/$h/cmdline" 2>/dev/null)"
        allowed "$c" || procs="$procs pid=$h($c)"
    done
    [[ -n "$procs" ]] && note "UNCOVERED-PORT :$port held by$procs"
done < <(ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -oE '[0-9]+$' | sort -un || true)

# --- 3. shell profiles with daemon logic --------------------------------------
for prof in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile"; do
    [[ -f "$prof" ]] || continue
    hits="$(grep -nE 'nohup|setsid|\(.*\) *&|while (true|:)|curl[^|]*\|\s*(ba)?sh|daemon off' "$prof" 2>/dev/null || true)"
    [[ -n "$hits" ]] && note "PROFILE-DAEMON $prof: $hits"
done

# --- 4. cron files / systemd units referencing ephemeral paths ----------------
for f in /etc/cron.d/* /etc/crontab; do
    [[ -f "$f" ]] || continue
    hits="$(grep -nE '/tmp/|/dev/shm/' "$f" 2>/dev/null || true)"
    [[ -n "$hits" ]] && note "CRON-EPHEMERAL $f: $hits"
done
for u in "$HOME/.config/systemd/user"/*.service "$HOME/.config/systemd/user"/*.timer; do
    [[ -f "$u" ]] || continue
    hits="$(grep -nE '/tmp/|/dev/shm/' "$u" 2>/dev/null || true)"
    [[ -n "$hits" ]] && note "UNIT-EPHEMERAL $u: $hits"
done

# --- 5. uncommitted live edits (excluding known state paths) -------------------
if [[ -d "$REPO/.git" ]]; then
    dirty="$(git -C "$REPO" status --porcelain 2>/dev/null | \
        grep -vE 'squawk-relay/|var/openfang-health/|todos\.md|\.pid$|\.backup/|^\?\? \.staging/' || true)"
    [[ -n "$dirty" ]] && note "UNCOMMITTED Estate: $(echo "$dirty" | wc -l) files: $(echo "$dirty" | awk '{print $2}' | tr '\n' ' ' | cut -c1-400)"
    # submodule drift (bulk ops must be submodule-aware)
    while IFS= read -r sm; do
        [[ -n "$sm" ]] && note "SUBMODULE-DIRTY $sm"
    done < <(git -C "$REPO" submodule foreach --quiet 'git status --porcelain | head -3 | sed "s/^/$name: /"' 2>/dev/null || true)
fi

# --- report --------------------------------------------------------------------
if (( ${#FINDINGS[@]} == 0 )); then
    echo "durability-audit: clean"
    exit 0
fi

report="$(printf 'durability audit findings (%d):\n' "${#FINDINGS[@]}"; printf ' - %s\n' "${FINDINGS[@]}")"
echo "$report"

if (( ALERT )); then
    ts="$(date -u +%Y-%m-%dT%H:%M:%S.%6N+00:00)"
    seq="$(ls "$SQUAWK_ROOT/$CHANNEL"/*.md 2>/dev/null | sed 's/.*\///; s/-.*//' | sort -n | tail -1)"
    seq=$(( ${seq:-0} + 1 ))
    fname="$seq-anvil-durability-audit.md"
    {
        echo "---"
        echo "seq: $seq"
        echo "from: anvil"
        echo "to: all"
        echo "channel: $CHANNEL"
        echo "ts: $ts"
        echo "status: discussion"
        echo "title: durability-audit"
        echo "---"
        echo "$report"
        echo "(anvil)"
    } > "$SQUAWK_ROOT/$CHANNEL/$fname"
    echo "published $fname"
fi
exit 2
