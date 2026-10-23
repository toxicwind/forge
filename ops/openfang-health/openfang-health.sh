#!/usr/bin/env bash
# openfang-health.sh — live liveness + provider audit for the openfang/coyote stack on yote.
#
# Research lineage (see ops/openfang-health/README.md):
#  - AgentSight  (arXiv 2508.02736): link agent intent (agent registry, queued work)
#    to OS-level behavior (processes, ports, resources). Zero-SDK: probe the OS, not the SDK.
#  - AgentCgroup (arXiv 2602.09345): memory is the concurrency bottleneck; tool-call
#    bursts are unpredictable (~15.4x peak/avg) -> watch RSS pressure, not just "up".
#  - HarnessAudit(arXiv 2605.14271): audit the execution trajectory (registry integrity,
#    audit-chain validity), not just the heartbeat.
#
# Usage: openfang-health.sh [--squawk] [--quiet]
#   --squawk  post to squawk fleet channel on status transition (or daily digest)
#   --quiet   suppress human summary on stdout (JSON + HTML always written)
#
# Exit codes: 0 = checks ran (status OK/DEGRADED/FAIL recorded in JSON),
#             1 = the checker itself errored (fail loud — never confuse the two).
set -euo pipefail

SHINGLE="${SHINGLE_HOME:-/home/toxic/.fleet-bus}"
VAR="$SHINGLE/var/openfang-health"
OUT_JSON="$VAR/openfang-health.json"
OUT_HTML="$VAR/openfang-health.html"
STATUS_FILE="$VAR/last-status"
LAST_POST="$VAR/last-post-ts"
SQUAWK_ROOT="${SQUAWK_ROOT:-/home/toxic/.fleet-bus/squawk-root}"
PITCHFORK="/home/toxic/.local/share/mise/installs/pitchfork/latest/pitchfork"
PROBE_TIMEOUT=5
DIGEST_INTERVAL=86400

QUIET=0
DO_SQUAWK=0
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --squawk) DO_SQUAWK=1 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

mkdir -p "$VAR"
RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT

# result <name> <ok|warn|fail> <detail>   (detail must be single-line)
result() {
  local detail
  detail="$(printf '%s' "$3" | tr '\n' ' ' | sed 's/|//g')"
  printf '%s|%s|%s\n' "$1" "$2" "$detail" >>"$RESULTS"
}

ts_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_ms() { date +%s%3N; }  # HFT: measure every hop

# ---- 1. pitchfork supervisor (the OS truth behind every daemon) ----
if systemctl --user is-active pitchfork >/dev/null 2>&1; then
  PID="$(systemctl --user show pitchfork -p MainPID --value)"
  MEM="$(systemctl --user show pitchfork -p MemoryCurrent --value)"
  result "supervisor" "ok" "active pid=$PID mem=${MEM}B"
else
  result "supervisor" "fail" "pitchfork.service not active"
fi

# ---- 2. every configured daemon must be running ----
# Supervisor-stale vs real outage: an errored daemon whose endpoint is actually
# serving is a metadata problem (HFT: trust the live lane, not the stale view).
supervisor_stale_ok() {
  case "$1" in
    Estate/toolcall-llm) timeout 3 curl -sf -o /dev/null "http://127.0.0.1:25152/health" 2>/dev/null ;;
    Estate/awrawr-ws-exec) [ "$(timeout 3 curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8379/exec-ws 2>/dev/null)" = "400" ] ;;
    *) return 1 ;;
  esac
}
if [ -x "$PITCHFORK" ]; then
  LIST_OUT="$("$PITCHFORK" list 2>&1)"
  TOTAL="$(printf '%s\n' "$LIST_OUT" | grep -c ' ' || true)"
  RUNNING="$(printf '%s\n' "$LIST_OUT" | awk '$2=="running"' | wc -l)"
  NOTRUN="$(printf '%s\n' "$LIST_OUT" | awk '$2!="running" {print $1}' | tr '\n' ',' | sed 's/,$//')"
  if [ -z "$NOTRUN" ]; then
    result "daemons" "ok" "$RUNNING/$TOTAL running"
  else
    REAL_FAIL=""; STALE=""
    for d in $(printf '%s' "$NOTRUN" | tr ',' ' '); do
      if supervisor_stale_ok "$d"; then STALE="$STALE $d"; else REAL_FAIL="$REAL_FAIL $d"; fi
    done
    if [ -n "$REAL_FAIL" ]; then
      result "daemons" "fail" "$RUNNING/$TOTAL running; down:$REAL_FAIL${STALE:+; supervisor-stale (endpoint live):$STALE}"
    else
      result "daemons" "warn" "$RUNNING/$TOTAL running; supervisor-stale (endpoint live):$STALE — restart daemon to clear metadata"
    fi
  fi
else
  result "daemons" "fail" "pitchfork binary missing at $PITCHFORK"
fi

# ---- 3. openfang kernel boots (in-process) ----
T0="$(now_ms)"
STATUS_OUT="$(timeout 30 openfang status 2>&1)"
STATUS_RC=$?
KERNEL_MS=$(( $(now_ms) - T0 ))
if [ "$STATUS_RC" -eq 0 ] && printf '%s' "$STATUS_OUT" | grep -q "booted successfully"; then
  AUDIT="$(printf '%s' "$STATUS_OUT" | grep -o 'Audit trail loaded: [0-9]* entries, chain integrity [A-Z]*' | sed -n '1p')"
  result "openfang_kernel" "ok" "boot ok in ${KERNEL_MS}ms; ${AUDIT:-audit line missing}"
else
  result "openfang_kernel" "fail" "openfang status rc=$STATUS_RC after ${KERNEL_MS}ms"
fi

# ---- 4. agent registry: expected agents present and Running ----
T0="$(now_ms)"
AGENTS_OUT="$(timeout 30 openfang agent list 2>&1 | grep -v 'INFO\|WARN' || true)"
AGENTS_MS=$(( $(now_ms) - T0 ))
MISSING=""
for a in coyote shingle-pilot squawk-relay assistant; do
  if ! printf '%s\n' "$AGENTS_OUT" | awk -v n="$a" '$2==n && $3=="Running"' | grep -q .; then
    MISSING="$MISSING $a"
  fi
done
if [ -z "$MISSING" ]; then
  COUNT="$(printf '%s\n' "$AGENTS_OUT" | grep -c 'Running' || true)"
  result "agents" "ok" "4/4 expected Running (total Running=$COUNT) in ${AGENTS_MS}ms"
else
  result "agents" "fail" "not Running:$MISSING (query took ${AGENTS_MS}ms)"
fi

# ---- 5. audit chain integrity (HarnessAudit: audit the trajectory) ----
if printf '%s' "$STATUS_OUT" | grep -q "chain integrity OK"; then
  result "audit_chain" "ok" "chain integrity OK"
else
  result "audit_chain" "fail" "chain integrity NOT verified"
fi

# ---- 6. provider liveness (live/dead only — never key values) ----
# 6a. llama-swap AST matrix :25100
T0="$(now_ms)"
if MODELS_JSON="$(timeout "$PROBE_TIMEOUT" curl -sf "http://127.0.0.1:25100/v1/models" 2>&1)"; then
  N="$(printf '%s' "$MODELS_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null || echo '?')"
  result "llama_swap" "ok" ":25100/v1/models ok in $(( $(now_ms) - T0 ))ms, $N models"
else
  result "llama_swap" "fail" ":25100/v1/models unreachable after $(( $(now_ms) - T0 ))ms"
fi

# 6b. kimi-auto resolver state: fresh + healthy
KSTATE="/home/toxic/.local/share/kimi-auto/state.json"
if [ -f "$KSTATE" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$KSTATE") ))
  KINFO="$(python3 -c "
import json
d=json.load(open('$KSTATE'))
okc=[c for c in d['candidates'] if c['ok']]
print(d.get('model'), d.get('healthy'), min([c['latency_ms'] for c in okc]) if okc else '-')
" 2>/dev/null || echo 'parse-error')"
  if [ "$AGE" -lt 1800 ] && printf '%s' "$KINFO" | grep -q True; then
    result "kimi_auto" "ok" "state fresh (${AGE}s); $KINFO"
  else
    result "kimi_auto" "warn" "state age=${AGE}s info=[$KINFO]"
  fi
else
  result "kimi_auto" "fail" "state.json missing"
fi

# 6c. cloud provider auth posture (names only)
PROV_OUT="$(timeout 30 openfang models providers 2>&1 | grep -v 'INFO\|WARN' || true)"
NMISS="$(printf '%s\n' "$PROV_OUT" | awk '$2=="Missing"' | wc -l)"
NLOCAL="$(printf '%s\n' "$PROV_OUT" | awk '$2=="NotRequired"' | wc -l)"
for p in nvidia anthropic groq cerebras deepseek openrouter; do
  ST="$(printf '%s\n' "$PROV_OUT" | awk -v p="$p" '$1==p {print $2}')"
  [ -z "$ST" ] && ST="unknown"
  result "provider_$p" "$([ "$ST" = Missing ] && echo warn || echo ok)" "auth=$ST (live/dead only)"
done
result "providers_summary" "ok" "$NMISS Missing, $NLOCAL NotRequired(local)"

# ---- 7. endpoint probes (failfast) ----
probe_http() { # name url -> prints "ok|CODE" or "fail|CODE"
  CODE="$(timeout "$PROBE_TIMEOUT" curl -s -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || echo '000')"
  case "$CODE" in
    2*|3*|401|403) echo "ok|$CODE" ;;
    *) echo "fail|$CODE" ;;
  esac
}
probe_tcp() { # name host port -> prints ok|fail
  if timeout "$PROBE_TIMEOUT" bash -c "</dev/tcp/$2/$3" 2>/dev/null; then echo ok; else echo fail; fi
}

YOTE_T0="$(now_ms)"
YOTE_RES="$(probe_http yote http://127.0.0.1:25102/health)"
YOTE_MS=$(( $(now_ms) - YOTE_T0 ))
case "$YOTE_RES" in
  ok\|*) result "yote_ep" "ok" ":25102/health reachable (${YOTE_RES#*|}) in ${YOTE_MS}ms" ;;
  *)     result "yote_ep" "fail" ":25102/health code=${YOTE_RES#*|} after ${YOTE_MS}ms" ;;
esac

MESH_T0="$(now_ms)"
if [ "$(probe_tcp mesh 127.0.0.1 25115)" = ok ]; then result "meshub_ep" "ok" ":25115 tcp open in $(( $(now_ms) - MESH_T0 ))ms"; else result "meshub_ep" "fail" ":25115 tcp closed after $(( $(now_ms) - MESH_T0 ))ms"; fi

COYOTE_T0="$(now_ms)"
COYOTE_RES="$(probe_http coyote http://127.0.0.1:25143/health)"
COYOTE_MS=$(( $(now_ms) - COYOTE_T0 ))
# Estate/coyote service daemon is not in the live pitchfork set -> expected down; warn, not fail
case "$COYOTE_RES" in
  ok\|*) result "coyote_ep" "ok" ":25143/health reachable in ${COYOTE_MS}ms" ;;
  *)     result "coyote_ep" "warn" ":25143 code=${COYOTE_RES#*|} after ${COYOTE_MS}ms (Estate/coyote not in live pitchfork set)" ;;
esac

# ---- 8. resource pressure (AgentCgroup: memory is the bottleneck) ----
MEMINFO="$(free -m | awk '/^Mem:/ {print "total="$2"MB used="$3"MB avail="$7"MB"}')"
result "memory" "ok" "$MEMINFO"
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU="$(timeout 10 nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null | sed -n '1p' | tr ',' ' ')"
  [ -n "$GPU" ] && result "gpu" "ok" "$GPU" || result "gpu" "warn" "nvidia-smi empty"
else
  result "gpu" "warn" "nvidia-smi missing"
fi

# ---- assemble JSON + status ----
export RESULTS OUT_JSON
python3 - "$RESULTS" "$OUT_JSON" <<'PYEOF'
import json, sys, datetime
res_path, out_path = sys.argv[1], sys.argv[2]
checks = []
for line in open(res_path):
    line = line.rstrip("\n")
    if not line: continue
    name, status, detail = line.split("|", 2)
    checks.append({"name": name, "status": status, "detail": detail})
sev = {"ok": 0, "warn": 1, "fail": 2}
worst = max((sev[c["status"]] for c in checks), default=0)
overall = {0: "OK", 1: "DEGRADED", 2: "FAIL"}[worst]
doc = {
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "overall": overall,
    "checks": checks,
    "papers": ["2508.02736", "2602.09345", "2605.14271"],
}
with open(out_path, "w") as f:
    json.dump(doc, f, indent=2)
PYEOF
OVERALL="$(python3 -c "import json; print(json.load(open('$OUT_JSON'))['overall'])")"
printf '%s' "$OVERALL" >"$STATUS_FILE"

# ---- HTML status page ----
python3 - "$OUT_JSON" "$OUT_HTML" <<'PYEOF'
import json, sys, html
doc = json.load(open(sys.argv[1]))
color = {"OK": "#3fb950", "DEGRADED": "#d29922", "FAIL": "#f85149"}
rows = "".join(
    f"<tr><td>{html.escape(c['name'])}</td>"
    f"<td style='color:{color.get(c['status'].upper(),'#fff')}'>{c['status']}</td>"
    f"<td>{html.escape(c['detail'])}</td></tr>" for c in doc["checks"]
)
page = f"""<!doctype html><html><head><meta charset=utf-8>
<meta http-equiv=refresh content=300><title>openfang-health — {doc['overall']}</title>
<style>body{{background:#0d1117;color:#c9d1d9;font-family:monospace;padding:2em}}
table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #30363d;padding:6px 10px;text-align:left}}
h1 span{{color:{color.get(doc['overall'],'#fff')}}}</style></head><body>
<h1>openfang / coyote health — <span>{doc['overall']}</span></h1>
<p>generated {html.escape(doc['ts'])} (UTC) · refresh 300s · lineage: arXiv 2508.02736 / 2602.09345 / 2605.14271</p>
<table><tr><th>check</th><th>status</th><th>detail</th></tr>{rows}</table></body></html>"""
open(sys.argv[2], "w").write(page)
PYEOF

# ---- human summary ----
if [ "$QUIET" -eq 0 ]; then
  echo "openfang-health: $OVERALL ($(ts_now))"
  while IFS='|' read -r n s d; do printf '  [%s] %-16s %s\n' "$s" "$n" "$d"; done <"$RESULTS"
fi

# ---- squawk: post on transition, else daily digest ----
if [ "$DO_SQUAWK" -eq 1 ]; then
  PREV="$(cat "$VAR/prev-posted-status" 2>/dev/null || echo '')"
  NOW_TS="$(date +%s)"
  LAST="$([ -f "$LAST_POST" ] && cat "$LAST_POST" || echo 0)"
  SHOULD_POST=0
  [ "$OVERALL" != "$PREV" ] && SHOULD_POST=1
  [ $(( NOW_TS - LAST )) -gt "$DIGEST_INTERVAL" ] && SHOULD_POST=1
  if [ "$SHOULD_POST" -eq 1 ] && [ -d "$SQUAWK_ROOT/fleet" ]; then
    # hodos: seq allocation + write must be atomic vs concurrent writers (opp #9)
    (
      hodos -x 200
      NEXT_SEQ="$(python3 -c "
import re, glob
ms=[re.match(r'(\d+)-', f.split('/')[-1]) for f in glob.glob('$SQUAWK_ROOT/fleet/*.md')]
ns=[int(m.group(1)) for m in ms if m]
print((max(ns)+1) if ns else 1)")"
      BODY="$(python3 -c "
import json
d=json.load(open('$OUT_JSON'))
bad=[c for c in d['checks'] if c['status']!='ok']
lines=[f\"- [{c['status']}] {c['name']}: {c['detail']}\" for c in bad]
print('\n'.join(lines) if lines else 'all checks ok')")"
      {
        printf 'seq: %s\nfrom: openfang-health\nto: all\nchannel: fleet\nts: %s\nstatus: discussion\ntitle: openfang-health %s\n---\n' "$NEXT_SEQ" "$(date -Iseconds)" "$OVERALL"
        printf 'openfang/coyote health: **%s**\n\n%s\n' "$OVERALL" "$BODY"
      } >"$SQUAWK_ROOT/fleet/${NEXT_SEQ}-openfang-health-report.md"
      printf '%s' "$OVERALL" >"$VAR/prev-posted-status"
      printf '%s' "$NOW_TS" >"$LAST_POST"
    ) 200>"$VAR/.post.lock"
  fi
fi
