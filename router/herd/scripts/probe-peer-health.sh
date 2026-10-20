#!/usr/bin/env bash
# probe-peer-health.sh — live end-to-end proof of event-driven dead-peer
# self-healing for the herd router.
#
# Fully event-driven driver: no sleep, no polling loops, no timeouts-as-delays.
#   - Process readiness is signaled over named pipes. The driver blocks on
#     `read` and wakes exactly when the child signals — never a readiness poll,
#     never "give it a moment" sleeps.
#   - The cool-off is never slept through. A single cool-off cannot serve both
#     halves of the proof (fail-fast needs cool-off >> driver latency;
#     immediate recovery needs cool-off << driver latency), so the probe runs
#     the herd twice:
#       run 1 (cool_off_seconds: 3600): proves weighted ejection and fail-fast
#         503 while the circuit is open, without touching the backend.
#       run 2 (cool_off_seconds: 0.005): the cool-off (5ms) is shorter than any
#         real inter-request gap, so the first real request after the backend
#         recovers IS the half-open probe — recovery is demonstrated purely as
#         an event (real traffic), with no waiting whatsoever.
#   - Teardown reaps children with `wait` (SIGCHLD-driven), not sleep.
#   - Ports are picked collision-free (bind port 0) unless overridden.
# The only `read -t` uses are hang backstops: fail loudly if a child dies
# before signaling readiness. The test never waits out a duration to become
# correct.
#
# Spins up, on 127.0.0.1 only:
#   1. a scripted backend (python http.server) with a mode file:
#      healthy | fail500 | empty200
#   2. the herd binary under test with a minimal one-peer config
# then drives and asserts:
#   run 1:
#     A. healthy request -> 200, peer healthy
#     B. fail500 x2 (weight 2.0, threshold 4) -> circuit OPEN
#     C. request while open -> 503 peer_circuit_open, backend untouched,
#        retry_after_ms advertised by the server
#   run 2 (fresh herd, 5ms cool-off):
#     A2. healthy request -> 200, peer healthy
#     B2. fail500 x2 -> circuit OPEN
#     D2. backend healthy again -> the next real request is admitted as the
#         half-open probe -> 200, the backend WAS hit exactly once, peer
#         readmitted to rotation — healthy, or degraded when the rolling
#         error window still holds the earlier failures (no waiting)
#     F2. empty200 x3 (weight 1.5) -> circuit OPEN again (weights differ)
#     G2. backend healthy -> next real request probes -> 200 -> readmitted
#         to rotation
#
# Usage: probe-peer-health.sh [--bin PATH] [--keep]
#   --bin PATH  herd binary to test (default: build from this repo)
#   --keep      leave processes running for manual inspection
#   BE_PORT / HERD_PORT env overrides are honored when free; otherwise ports
#   are allocated collision-free. TMPDIR may point scratch space elsewhere
#   (fifos, logs) if /tmp is cramped.
set -u

HERD_BIN=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin)  HERD_BIN="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "usage: $0 [--bin PATH] [--keep]" >&2; exit 2 ;;
  esac
done

PEER=probe-peer
MODEL=probe-model

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/probe-peer-health.XXXXXX")"
BACKEND_PID=""; HERD_PID=""; DRAIN_PID=""

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

pick_port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'
}
port_free() { ! (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null; }

if [ -z "${BE_PORT:-}" ]; then
  BE_PORT="$(pick_port)"
elif ! port_free "$BE_PORT"; then
  fail "BE_PORT $BE_PORT already in use; refusing to disturb it"
fi
if [ -z "${HERD_PORT:-}" ]; then
  HERD_PORT="$(pick_port)"
elif ! port_free "$HERD_PORT"; then
  fail "HERD_PORT $HERD_PORT already in use; refusing to disturb it"
fi
pass "ports: backend=:$BE_PORT herd=:$HERD_PORT"

stop_herd() {
  [ -n "$HERD_PID" ] && kill "$HERD_PID" 2>/dev/null
  [ -n "$DRAIN_PID" ] && kill "$DRAIN_PID" 2>/dev/null
  # Reap the herd children only (the backend outlives herd runs); wait is
  # SIGCHLD-driven — an event, not a delay.
  [ -n "$HERD_PID" ] && wait "$HERD_PID" 2>/dev/null
  [ -n "$DRAIN_PID" ] && wait "$DRAIN_PID" 2>/dev/null
  HERD_PID=""; DRAIN_PID=""
}

cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "keeping procs (backend=$BACKEND_PID herd=$HERD_PID) workdir=$WORKDIR"
    return
  fi
  stop_herd
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null
  [ -n "$BACKEND_PID" ] && wait "$BACKEND_PID" 2>/dev/null
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ---- binary ------------------------------------------------------------
if [ -z "$HERD_BIN" ]; then
  HERE="$(cd "$(dirname "$0")/.." && pwd)"
  HERD_BIN="$WORKDIR/herd"
  (cd "$HERE" && go build -o "$HERD_BIN" .) || fail "go build failed"
fi
[ -x "$HERD_BIN" ] || fail "binary not executable: $HERD_BIN"
pass "binary: $HERD_BIN"

# ---- scripted backend --------------------------------------------------
echo healthy > "$WORKDIR/mode"
echo 0 > "$WORKDIR/hits"
mkfifo "$WORKDIR/be-ready"
cat > "$WORKDIR/backend.py" <<'PYEOF'
import http.server, os
wd = os.environ["PROBE_WD"]
class H(http.server.BaseHTTPRequestHandler):
    def _mode(self):
        return open(os.path.join(wd, "mode")).read().strip()
    def _bump(self):
        p = os.path.join(wd, "hits")
        n = int(open(p).read().strip() or 0) + 1
        open(p, "w").write(str(n))
    def _send(self, code, body):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_POST(self):
        ln = int(self.headers.get("Content-Length", 0))
        self.rfile.read(ln)
        self._bump()
        m = self._mode()
        if m == "fail500":
            self._send(500, '{"error":{"message":"boom","type":"server_error"}}')
        elif m == "empty200":
            self._send(200, '{"choices":[]}')
        else:
            self._send(200, '{"choices":[{"message":{"content":"probe-ok"}}]}')
    def log_message(self, *a):
        pass
srv = http.server.HTTPServer(("127.0.0.1", int(os.environ["PROBE_BE_PORT"])), H)
# Signal readiness over the fifo only after the socket is bound. The open
# blocks until the driver reads — a rendezvous, not a poll.
open(os.environ["PROBE_READY_FIFO"], "w").write("ready\n")
srv.serve_forever()
PYEOF
PROBE_WD="$WORKDIR" PROBE_BE_PORT="$BE_PORT" PROBE_READY_FIFO="$WORKDIR/be-ready" \
  nohup python3 "$WORKDIR/backend.py" >"$WORKDIR/backend.log" 2>&1 &
BACKEND_PID=$!
# Hang backstop only: fail loudly if the backend dies before signaling.
read -t 20 -r _ <"$WORKDIR/be-ready" \
  || fail "backend never signaled ready (see $WORKDIR/backend.log)"
pass "backend pid $BACKEND_PID on :$BE_PORT"

# ---- herd lifecycle ----------------------------------------------------
drain_herd_out() { # <tag> : background log drain; signals herd-ready-<tag>
  local tag=$1 line signaled=0    # on the "listening on http" line
  while IFS= read -r line; do
    printf '%s\n' "$line" >>"$WORKDIR/herd-$tag.log"
    if (( !signaled )) && [[ "$line" == *"listening on http"* ]]; then
      signaled=1
      printf 'ready\n' >"$WORKDIR/herd-ready-$tag"
    fi
  done <"$WORKDIR/herd-out-$tag"
}

write_config() { # <cool_off_seconds> <path>
  cat > "$2" <<YAMLEOF
peers:
  $PEER:
    proxy: http://127.0.0.1:$BE_PORT
    models:
      - $MODEL
    health:
      enabled: true
      ewma_alpha: 0.3
      failure_threshold: 4
      recovery_credit: 1
      success_threshold: 1
      cool_off_seconds: $1
      degraded_latency_ms: 15000
      degraded_error_rate: 0.5
      weights:
        transport: 2.0
        5xx: 2.0
        404-dead-id: 3.0
        402-not-entitled: 2.0
        403-refused: 1.5
        429-throttled: 0.5
        200-empty: 1.5
YAMLEOF
}

start_herd() { # <config> <tag>
  local cfg=$1 tag=$2
  mkfifo "$WORKDIR/herd-out-$tag" "$WORKDIR/herd-ready-$tag"
  # The shell opens herd-out-<tag> for writing on the herd's behalf; the open
  # blocks until the drain loop below opens it for reading — rendezvous.
  "$HERD_BIN" --config "$cfg" --listen "127.0.0.1:$HERD_PORT" \
    >"$WORKDIR/herd-out-$tag" 2>&1 &
  HERD_PID=$!
  drain_herd_out "$tag" &
  DRAIN_PID=$!
  # Hang backstop only: fail loudly if the herd dies before signaling.
  read -t 20 -r _ <"$WORKDIR/herd-ready-$tag" \
    || fail "herd($tag) never signaled ready (see $WORKDIR/herd-$tag.log)"
  pass "herd($tag) pid $HERD_PID on :$HERD_PORT"
}

# ---- request helpers ---------------------------------------------------
req() { # req -> http code of one chat completion through the peer
  curl -sS -o /dev/null -w '%{http_code}' -m 20 \
    -X POST "http://127.0.0.1:$HERD_PORT/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":8}"
}
peer_json() { # peer_json -> the JSON object for $PEER from /peer-health
  curl -sS -m 10 "http://127.0.0.1:$HERD_PORT/peer-health" | \
    PEER_NAME="$PEER" python3 -c "
import sys, json, os
snaps = json.load(sys.stdin)
want = os.environ['PEER_NAME']
for s in snaps:
    if s.get('peer') == want or s.get('name') == want or s.get('id') == want:
        print(json.dumps(s)); break
else:
    sys.exit(3)"
}
peer_state() { # peer_state -> state string from /peer-health
  peer_json | python3 -c "import sys,json;print(json.load(sys.stdin)['state'])"
}
peer_in_rotation() { # true when the peer admits traffic: healthy or degraded.
  # (degraded is in-rotation; it only flags elevated recent error rate.)
  case "$(peer_state)" in
    healthy|degraded) return 0 ;;
    *) return 1 ;;
  esac
}
retry_after_ms() {
  peer_json | python3 -c "import sys,json;print(json.load(sys.stdin).get('retry_after_ms', 0))"
}
hits() { cat "$WORKDIR/hits"; }
set_mode() { echo "$1" > "$WORKDIR/mode"; pass "backend mode -> $1"; }

# ==== run 1: ejection + fail-fast (long cool-off) ========================
write_config 3600 "$WORKDIR/herd1.yaml"
start_herd "$WORKDIR/herd1.yaml" run1

# ---- A. healthy ---------------------------------------------------------
code=$(req)
[ "$code" = "200" ] || fail "A: expected 200, got $code"
[ "$(peer_state)" = "healthy" ] || fail "A: peer not healthy"
pass "A: healthy request -> 200, state healthy"

# ---- B. fail500 x2 -> circuit OPEN (weight 2.0, threshold 4) -------------
set_mode fail500
c1=$(req); c2=$(req)
[ "$c1" = "500" ] || fail "B: req1 expected 500, got $c1"
[ "$c2" = "500" ] || fail "B: req2 expected 500, got $c2"
[ "$(peer_state)" = "circuit-open" ] || fail "B: circuit did not open (state=$(peer_state))"
pass "B: 2x 500 -> circuit-open (weighted ejection)"

# ---- C. fail-fast: 503 without backend traffic ---------------------------
h0=$(hits)
code=$(req)
[ "$code" = "503" ] || fail "C: expected 503 fail-fast, got $code"
body=$(curl -sS -m 20 -X POST "http://127.0.0.1:$HERD_PORT/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":8}")
echo "$body" | grep -q peer_circuit_open || fail "C: 503 body missing peer_circuit_open"
[ "$(hits)" = "$h0" ] || fail "C: backend was hit during fail-fast"
ra=$(retry_after_ms)
[ "$ra" -gt 0 ] 2>/dev/null || fail "C: server did not advertise retry_after_ms"
pass "C: 503 peer_circuit_open, backend untouched (hits=$h0), retry_after_ms=$ra"

stop_herd
pass "run 1 complete: ejection + fail-fast proven"

# ==== run 2: recovery on real traffic (5ms cool-off) ======================
# The cool-off is shorter than any real inter-request gap, so the first
# request after the backend recovers is admitted as the half-open probe.
# No waiting of any kind: the probe is purely an event.
write_config 0.005 "$WORKDIR/herd2.yaml"
start_herd "$WORKDIR/herd2.yaml" run2

# ---- A2. healthy ---------------------------------------------------------
set_mode healthy
code=$(req)
[ "$code" = "200" ] || fail "A2: expected 200, got $code"
[ "$(peer_state)" = "healthy" ] || fail "A2: peer not healthy"
pass "A2: healthy request -> 200, state healthy"

# ---- B2. fail500 x2 -> circuit OPEN ---------------------------------------
set_mode fail500
c1=$(req); c2=$(req)
[ "$c1" = "500" ] || fail "B2: req1 expected 500, got $c1"
[ "$c2" = "500" ] || fail "B2: req2 expected 500, got $c2"
[ "$(peer_state)" = "circuit-open" ] || fail "B2: circuit did not open"
pass "B2: 2x 500 -> circuit-open"

# ---- D2. recover -> next real request IS the half-open probe -------------
set_mode healthy
[ "$(peer_state)" = "circuit-open" ] || fail "D2: circuit did not stay open"
h0=$(hits)
code=$(req)
[ "$code" = "200" ] || fail "D2: probe expected 200, got $code"
[ "$(hits)" = "$((h0 + 1))" ] || fail "D2: probe did not reach the backend exactly once"
peer_in_rotation || fail "D2: peer not readmitted (state=$(peer_state))"
pass "D2: half-open probe on real traffic -> 200, backend hit once -> readmitted"

# ---- F2. empty200 x3 -> OPEN again (weight 1.5 proves weighting) ----------
set_mode empty200
c1=$(req); c2=$(req); c3=$(req)
[ "$c1" = "200" ] || fail "F2: req1 expected 200, got $c1"
[ "$c2" = "200" ] || fail "F2: req2 expected 200, got $c2"
[ "$c3" = "200" ] || fail "F2: req3 expected 200, got $c3"
[ "$(peer_state)" = "circuit-open" ] || fail "F2: empty200 did not open circuit"
pass "F2: 3x 200-empty -> circuit-open (lighter weight needs more failures)"

# ---- G2. recover again -> readmit ------------------------------------------
set_mode healthy
[ "$(peer_state)" = "circuit-open" ] || fail "G2: circuit did not stay open"
h1=$(hits)
code=$(req)
[ "$code" = "200" ] || fail "G2: probe expected 200, got $code"
[ "$(hits)" = "$((h1 + 1))" ] || fail "G2: probe did not reach the backend exactly once"
peer_in_rotation || fail "G2: peer not readmitted (state=$(peer_state))"
pass "G2: recovery -> probe on real traffic -> readmitted to rotation"

echo
echo "ALL PROBE ASSERTIONS PASSED"
