#!/usr/bin/env bash
# herd-selfheal.sh — one-shot herd health check + safe auto-repair.
#
# Run this before asking "is herd broken?":
#   /home/toxic/estate/ranch/mesh/router/herd/herd-selfheal.sh
#
# What it does:
#   1. Verifies the engines/ symlink target is live (3 engine binaries);
#      re-points it to the canonical /home/toxic/estate/engines/herd if stale.
#   2. Verifies the canonical config parses as YAML (values never printed).
#   3. Verifies the repo config.yaml resolves to the canonical config.
#   4. Runs `go build ./...` on the herd module.
#   5. Runs `go vet ./...` on the herd module.
#   6. Verifies the 3 engine llama-server binaries are executable.
#   7. Probes the herd daemon /health endpoint.
#   8. Reports running llama-server processes (informational).
#
# Idempotent and safe: the ONLY repair it performs is re-pointing the
# engines symlink. It never restarts daemons, never touches squawk,
# never prints secrets. Exit 0 = all PASS, 1 = something FAILED.
set -uo pipefail

HERD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOV="/home/toxic/estate"
CANON_CONFIG="$SOV/config/herd.yaml"
ENGINES_LINK="$HERD_DIR/engines"
ENGINES_CANON="$SOV/engines/herd"
GO_BIN="${GO_BIN:-/usr/bin/go}"
HERD_PORT=25100
if [ -f "$SOV/config/ports.env" ]; then
  _p="$(grep -E '^HERD_PORT=' "$SOV/config/ports.env" 2>/dev/null | cut -d= -f2 | tail -1)"
  [ -n "$_p" ] && HERD_PORT="$_p"
fi

PASS=0; FAIL=0; REPAIRED=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }
note() { printf 'info  %s\n' "$1"; }

# --- 1. engines symlink -------------------------------------------------
engines_ok() {
  [ -L "$ENGINES_LINK" ] || return 1
  local t; t="$(readlink -f "$ENGINES_LINK" 2>/dev/null)"
  [ -n "$t" ] && [ -d "$t" ] || return 1
  [ -x "$t/beellama.cpp/build-cuda86/bin/llama-server" ] || return 1
  [ -x "$t/ik_llama.cpp/build/bin/llama-server" ] || return 1
  [ -x "$t/llama-cpp-turboquant/build/bin/llama-server" ] || return 1
  return 0
}
if engines_ok; then
  ok "engines/ -> $(readlink "$ENGINES_LINK") (3 engine binaries present)"
else
  if [ -x "$ENGINES_CANON/beellama.cpp/build-cuda86/bin/llama-server" ]; then
    ln -sfn "$ENGINES_CANON" "$ENGINES_LINK"
    REPAIRED=$((REPAIRED+1))
    if engines_ok; then
      ok "engines/ was stale; re-pointed -> $ENGINES_CANON"
    else
      bad "engines/ re-point attempted but target still unhealthy"
    fi
  else
    bad "engines/ broken and canonical target missing: $ENGINES_CANON"
  fi
fi

# --- 2. canonical config parses (values never printed) ------------------
if [ -f "$CANON_CONFIG" ] \
  && python3 -c 'import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); sys.exit(0 if isinstance(d,dict) else 1)' "$CANON_CONFIG" 2>/dev/null; then
  ok "canonical config parses: $CANON_CONFIG"
else
  bad "canonical config missing/invalid: $CANON_CONFIG"
fi

# --- 3. repo config.yaml tracks canonical --------------------------------
if [ "$(readlink -f "$HERD_DIR/config.yaml" 2>/dev/null)" = "$CANON_CONFIG" ]; then
  ok "repo config.yaml -> canonical config"
else
  bad "repo config.yaml does not resolve to $CANON_CONFIG"
fi

# --- 4/5. go build + go vet ----------------------------------------------
if [ -x "$GO_BIN" ]; then
  if (cd "$HERD_DIR" && "$GO_BIN" build ./... >/tmp/herd-selfheal-build.log 2>&1); then
    ok "go build ./..."
  else
    bad "go build ./... (log: /tmp/herd-selfheal-build.log)"
  fi
  if (cd "$HERD_DIR" && timeout 180 "$GO_BIN" vet ./... >/tmp/herd-selfheal-vet.log 2>&1); then
    ok "go vet ./..."
  else
    bad "go vet ./... (log: /tmp/herd-selfheal-vet.log)"
  fi
else
  bad "go toolchain not found at $GO_BIN"
  bad "go vet skipped (no toolchain)"
fi

# --- 6. engine binaries executable ----------------------------------------
ET="$(readlink -f "$ENGINES_LINK" 2>/dev/null)"
n=0
for b in beellama.cpp/build-cuda86/bin/llama-server \
         ik_llama.cpp/build/bin/llama-server \
         llama-cpp-turboquant/build/bin/llama-server; do
  [ -x "$ET/$b" ] && n=$((n+1))
done
if [ "$n" -eq 3 ]; then ok "3/3 engine binaries executable"; else bad "$n/3 engine binaries executable"; fi

# --- 7. herd daemon health (3 attempts; transient stalls happen) --------------
healthy=0
for _try in 1 2 3; do
  if curl -sf --max-time 5 "http://127.0.0.1:${HERD_PORT}/health" >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 1
done
if [ "$healthy" -eq 1 ]; then
  ok "herd daemon /health on 127.0.0.1:${HERD_PORT}"
else
  bad "herd daemon /health unreachable on 127.0.0.1:${HERD_PORT} (3 attempts)"
fi

# --- 8. engine processes (informational only) -------------------------------
np="$(pgrep -c -f 'llama-server' 2>/dev/null || echo 0)"
note "$np llama-server process(es) running"

# --- summary ---------------------------------------------------------------
echo '---'
echo "herd self-heal: $PASS passed, $FAIL failed$([ "$REPAIRED" -gt 0 ] && echo ", $REPAIRED repaired")"
[ "$FAIL" -eq 0 ]
