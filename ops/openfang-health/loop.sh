#!/usr/bin/env bash
# loop.sh — EVENT-DRIVEN OpenFang health watcher (2026-09-21 full audit).
# Replaces the old 300s polling loop. Watches the pitchfork supervisor state
# file with inotify: any daemon state change (restart, crash, health
# transition) triggers an immediate health check. The daily digest still fires
# via the inotifywait timeout (86400s), not a sleep loop.
# Posts to the squawk fleet channel on status transitions (or daily digest).
# Fail-loud: any crash of the health script is logged and the watcher keeps going.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${PITCHFORK_STATE:-/home/toxic/.local/state/pitchfork/state.toml}"
LOG="${SHINGLE_HOME:-/home/toxic/.fleet-bus}/var/openfang-health/loop.log"
DIGEST_TIMEOUT=86400

run_check() {
  echo "[$(date -Iseconds)] run ($1)" >>"$LOG"
  "$DIR/openfang-health.sh" --squawk --quiet >>"$LOG" 2>&1 \
    || echo "[$(date -Iseconds)] HEALTH SCRIPT EXIT $?" >>"$LOG"
}

# Initial check at startup so the first state is recorded.
run_check "startup"

while true; do
  # Block until the supervisor state changes (daemon event) or 24h elapses
  # (daily digest). No polling: inotify wakes us only on real activity.
  if [ -f "$STATE" ]; then
    inotifywait -qq -t "$DIGEST_TIMEOUT" -e modify,move_self,attrib "$STATE" >>"$LOG" 2>&1
    rc=$?
  else
    echo "[$(date -Iseconds)] state file missing, waiting ${DIGEST_TIMEOUT}s" >>"$LOG"
    sleep "$DIGEST_TIMEOUT"
    rc=2
  fi
  if [ "$rc" -eq 2 ]; then
    run_check "daily-digest"
  elif [ "$rc" -eq 0 ]; then
    run_check "supervisor-event"
  else
    echo "[$(date -Iseconds)] inotifywait rc=$rc, retrying" >>"$LOG"
    sleep 5
  fi
done
