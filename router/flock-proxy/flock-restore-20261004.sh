#!/usr/bin/env bash
# flock-restore-20261004.sh — bring :25193 back, move it under systemd --user,
# retire the SIGHUP approach (the Rust binary does not handle HUP), retire the
# patch scaffolding. Cutting-edge operator UX: flock-ctl subcommands.
set -uo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN="$HOME/.flock-maxfix/restore-$STAMP"
mkdir -p "$RUN"
LOG="$RUN/restore.log"
: > "$LOG"
log(){ printf '%s\n' "$*" | tee -a "$LOG"; }
hdr(){ log ""; log "════════════════════════════════════════════════════════════════════"; log "$*"; log "════════════════════════════════════════════════════════════════════"; }

hdr "flock-restore $STAMP"

# ── 1. Diagnose.
hdr "1. diagnose"
ss -tlnpH 'sport = :25193' 2>/dev/null | tee -a "$LOG" || log "  ✗ no listener on :25193"
pgrep -af 'flock|pitchfork' 2>/dev/null | tee -a "$LOG" || log "  no flock/pitchfork procs"
BIN="$HOME/.flock/flock"
LAUNCH="$HOME/estate/ranch/flock/bin/flock-run.sh"
[ -x "$BIN" ]    && log "  binary:   OK  $BIN"    || { log "  binary:   MISSING"; exit 1; }
[ -x "$LAUNCH" ] && log "  launcher: OK  $LAUNCH" || log "  launcher: MISSING (will exec $BIN directly)"

# ── 2. Stop pitchfork from fighting systemd over :25193.
hdr "2. retire pitchfork ownership of flock"
if command -v pitchfork >/dev/null 2>&1; then
  pitchfork stop flock 2>&1 | tee -a "$LOG" || log "  pitchfork stop flock: (nothing running)"
else
  log "  pitchfork not in PATH"
fi
# also, if any bare flock process is holding :25193, kill it (SIGTERM, graceful)
OLD_PID=$(ss -tlnpH 'sport = :25193' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$OLD_PID" ]; then
  log "  killing stale pid $OLD_PID (SIGTERM)"
  kill -TERM "$OLD_PID" 2>/dev/null || true
  sleep 2
  kill -KILL "$OLD_PID" 2>/dev/null || true
fi

# ── 3. Flat env file systemd can parse (EnvironmentFile= has no shell logic).
hdr "3. flat EnvironmentFile"
SSOT="$HOME/estate/config/flock-ssot"
mkdir -p "$SSOT"
FLAT="$SSOT/flock.env"
umask 077
{
  echo "# flock.env — flat key=value for systemd EnvironmentFile=. Generated $STAMP."
  echo "FLOCK_PORT=25193"
  echo "PORT=25193"
  echo "HOST=127.0.0.1"
  echo "FLOCK_DATA_DIR=$HOME/.flock-data"
  echo "DATA_DIR=$HOME/.flock-data"
  echo "FLOCK_ASTMATRIX_DB=$HOME/estate/data/ast_matrix.db"
  echo "RUST_LOG=info"
  if [ -r "$HOME/.secrets" ]; then
    grep -E '^(FLOCK_API_KEY|PROXY_API_KEYS|NIM_API_KEYS|NVIDIA_API_KEYS|NVIDIA_API_KEY|GROQ_API_KEY|CEREBRAS_API_KEY|KIMI_API_KEY|HERD_API_KEY|ESTATE_CLIENT_KEYS|KIMI_AUTO_SHIM_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|BITDEER_API_KEY|MISTRAL_API_KEY|DEEPSEEK_API_KEY|PERPLEXITY_API_KEY|XAI_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|DEEPINFRA_API_KEY|SAMBANOVA_API_KEY|SILICONFLOW_API_KEY|SILICONFLOW_CN_API_KEY|NOVITA_API_KEY|TYPHOON_API_KEY|VENICE_API_KEY|NANOGPT_API_KEY|AIMLAPI_API_KEY|HUGGINGFACE_HUB_TOKEN|BASETEN_API_KEY|COREWEAVE_API_KEY|ZAI_API_KEY|ZENMUX_API_KEY|SYNTHETIC_API_KEY|WAFER_SERVERLESS_API_KEY|XIAOMI_API_KEY|QIANFAN_API_KEY|MINIMAX_API_KEY|GMI_API_KEY|MODEL_API_KEY|META_API_KEY|SAKANA_API_KEY|FUGU_API_KEY|STEPFUN_API_KEY|ABLITERATION_API_KEY|ABLIT_KEY|AIAND_API_KEY|CHUTES_API_KEY|CLOUDFLARE_AI_GATEWAY_API_KEY|AWS_BEARER_TOKEN_BEDROCK|AI_GATEWAY_API_KEY|VERCEL_AI_GATEWAY_API_KEY|OLLAMA_CLOUD_API_KEY|CHARM_HYPER_API_KEY|HYPER_API_KEY|COHERE_API_KEY|COMMAND_CODE_API_KEY|COMMANDCODE_API_KEY|SINGULARITYAPI_DEV_API_KEY|SINGULARITYAPI_TECH_API_KEY|HETZNER_API_KEY|HYPERBOLIC_API_KEY|GITHUB_TOKEN|PERPLEXITY_API_KEY|DASHSCOPE_API_KEY|PZERO_API_KEY|MINARA_API_KEY|INFERX_API_KEY|GPUAI_API_KEY|CORVEX_API_KEY|INFERBASE_API_KEY|ONDE_API_KEY|INFEREN_API_KEY|RUNWARE_API_KEY|INCEPTION_API_KEY)=' \
      "$HOME/.secrets" || true
  fi
} > "$FLAT.tmp" && mv "$FLAT.tmp" "$FLAT"
# alias canonical
if ! grep -q '^PROXY_API_KEYS=' "$FLAT" && grep -q '^FLOCK_API_KEY=' "$FLAT"; then
  K=$(grep -m1 '^FLOCK_API_KEY=' "$FLAT" | cut -d= -f2-)
  printf 'PROXY_API_KEYS=%s\n' "$K" >> "$FLAT"
fi
chmod 600 "$FLAT"
log "  wrote $FLAT ($(wc -l < "$FLAT") lines, 0600)"

# ── 4. systemd --user unit with readiness gate (no SIGHUP; restart is atomic).
hdr "4. systemd --user unit"
UD="$HOME/.config/systemd/user"
mkdir -p "$UD"

# Use a dedicated launcher that execs the binary (so systemd tracks the real PID).
LAUNCH_CANON="$HOME/.flock/flock-launch.sh"
cat > "$LAUNCH_CANON" <<'LSEOF'
#!/usr/bin/env bash
set -euo pipefail
: "${FLOCK_PORT:=25193}"
: "${FLOCK_DATA_DIR:=$HOME/.flock-data}"
: "${HOST:=127.0.0.1}"
mkdir -p "$FLOCK_DATA_DIR"
exec "$HOME/.flock/flock" --host "$HOST" --port "$FLOCK_PORT" --data-dir "$FLOCK_DATA_DIR"
LSEOF
# NOTE: the Rust binary's real flags vary by build. If it rejects --host/--port,
# fall back to env-only. Discover flags now:
if "$HOME/.flock/flock" --help 2>&1 | grep -qiE -- '--port|--host|--data-dir'; then
  log "  binary accepts --host/--port/--data-dir"
else
  log "  binary does not advertise --host/--port/--data-dir; using env-only launcher"
  cat > "$LAUNCH_CANON" <<'LSEOF'
#!/usr/bin/env bash
set -euo pipefail
: "${PORT:=${FLOCK_PORT:-25193}}"
: "${DATA_DIR:=${FLOCK_DATA_DIR:-$HOME/.flock-data}}"
: "${HOST:=127.0.0.1}"
export PORT DATA_DIR HOST FLOCK_PORT FLOCK_DATA_DIR
mkdir -p "$DATA_DIR"
exec "$HOME/.flock/flock"
LSEOF
fi
chmod 0755 "$LAUNCH_CANON"

cat > "$UD/flock.service" <<SVCEOF
[Unit]
Description=flock — rate-limit-aware NVIDIA NIM proxy
Documentation=file://$SSOT/ROUTER_CANON.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=exec
WorkingDirectory=$HOME/estate/ranch/flock
EnvironmentFile=$FLAT
ExecStart=$LAUNCH_CANON
# Readiness gate: only mark active once /health answers.
ExecStartPost=/bin/sh -c 'i=0; while [ \$i -lt 60 ]; do if curl -sf -o /dev/null http://127.0.0.1:25193/health; then exit 0; fi; i=\$((i+1)); sleep 1; done; exit 1'
# NO ExecReload= — the binary has no SIGHUP handler. Use 'systemctl --user restart flock'.
Restart=always
RestartSec=2
TimeoutStartSec=90
TimeoutStopSec=15
KillMode=mixed
KillSignal=SIGTERM
SuccessExitStatus=0 143

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UMask=0077
ReadWritePaths=$HOME/.flock-data $HOME/estate/data $HOME/.flock $HOME/.cache
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=flock
SVCEOF
log "  wrote $UD/flock.service"

# ── 5. Reload, enable, start.
hdr "5. enable + start"
systemctl --user daemon-reload 2>&1 | tee -a "$LOG"
systemctl --user enable --now flock.service 2>&1 | tee -a "$LOG"

# ── 6. Wait for readiness.
hdr "6. wait for :25193 + /health"
ok=0
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:25193/health; then
    ok=1; log "  ready after ${i}s"; break
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  log "  ✗ not ready — dumping journal:"
  journalctl --user -u flock.service -n 120 --no-pager 2>&1 | tee -a "$LOG"
  exit 1
fi

# ── 7. Health + models probe.
hdr "7. probe"
KEY=$(grep -m1 '^FLOCK_API_KEY=' "$FLAT" 2>/dev/null | cut -d= -f2- || true)
log "  key prefix: ${KEY:0:14}…"
curl -sS -i --max-time 5 http://127.0.0.1:25193/health 2>&1 | tee -a "$LOG"
log ""
log "  /v1/models (first 20):"
curl -sS -i --max-time 10 -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:25193/v1/models 2>&1 | head -20 | tee -a "$LOG"

# ── 8. Operator UX: flock-ctl.
hdr "8. flock-ctl"
CTL="$HOME/.local/bin/flock-ctl"
mkdir -p "$(dirname "$CTL")"
cat > "$CTL" <<'CTLEOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-status}" in
  start)   systemctl --user start flock ;;
  stop)    systemctl --user stop flock ;;
  restart) systemctl --user restart flock ;;
  reload)  echo "flock has no SIGHUP handler; use: flock-ctl restart" >&2; exit 2 ;;
  status)  systemctl --user status flock --no-pager ;;
  logs)    journalctl --user -u flock -f ;;
  errors)  journalctl --user -u flock -p err -n 200 --no-pager ;;
  health)  curl -sS -i http://127.0.0.1:25193/health ;;
  models)  K=$(grep -m1 '^FLOCK_API_KEY=' "$HOME/estate/config/flock-ssot/flock.env" | cut -d= -f2-); \
           curl -sS -H "Authorization: Bearer $K" http://127.0.0.1:25193/v1/models ;;
  port)    ss -tlnpH 'sport = :25193' ;;
  pid)     ss -tlnpH 'sport = :25193' | grep -oP 'pid=\K[0-9]+' | head -1 ;;
  test)    K=$(grep -m1 '^FLOCK_API_KEY=' "$HOME/estate/config/flock-ssot/flock.env" | cut -d= -f2-); \
           curl -sS -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
             -d '{"model":"nvidia/nemotron-3-ultra-550b-a55b","messages":[{"role":"user","content":"reply: OK"}],"max_tokens":4}' \
             http://127.0.0.1:25193/v1/chat/completions ;;
  *)       echo "usage: flock-ctl {start|stop|restart|status|logs|errors|health|models|port|pid|test}"; exit 2 ;;
esac
CTLEOF
chmod 0755 "$CTL"
log "  wrote $CTL"
export PATH="$HOME/.local/bin:$PATH"

# ── 9. Retire the scaffolding scripts (move, not rm).
hdr "9. retire scaffolding"
for f in \
  "$HOME/estate/ranch/mesh/proxy/flock-proxy/patch.sh" \
  "$HOME/estate/ranch/mesh/proxy/flock-proxy/flock-final-20261004.sh" \
  "$HOME/estate/ranch/mesh/proxy/flock-proxy/flock-final2-20261004.sh" \
  "$HOME/estate/ranch/mesh/proxy/flock-proxy/flock-maximal-20261004.sh" \
; do
  [ -f "$f" ] || continue
  mv "$f" "$f.retired.$STAMP"
  log "  retired: $f"
done
# snapshot the whole flock-maxfix history for the audit trail
tar -czf "$RUN/flock-maxfix-history.tgz" -C "$HOME" .flock-maxfix 2>/dev/null || true
log "  archived: $RUN/flock-maxfix-history.tgz"

# ── 10. Canonical state.
hdr "10. CANONICAL STATE"
systemctl --user status flock.service --no-pager 2>&1 | tee -a "$LOG"
log ""
PID=$(ss -tlnpH 'sport = :25193' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
H1=$(sha256sum "/proc/$PID/exe" 2>/dev/null | awk '{print $1}')
H2=$(sha256sum "$HOME/.flock/flock" 2>/dev/null | awk '{print $1}')
log "  :25193 owner:  pid=$PID"
log "  running hash:  $H1"
log "  on-disk hash:  $H2"
[ "$H1" = "$H2" ] && log "  ✓ running == on-disk" || log "  ✗ mismatch"
log ""
log "  unit:    $UD/flock.service"
log "  env:     $FLAT"
log "  ctl:     $CTL"
log "  SSOT:    $SSOT"
log ""
log "  daily ops:"
log "    flock-ctl restart          # atomic, no SIGHUP"
log "    flock-ctl logs             # journalctl -u flock -f"
log "    flock-ctl health | models | test"
log ""
log "  The Rust binary has no SIGHUP handler; every previous 'reload' killed it."
log "  systemd --user now owns the lifecycle. pitchfork no longer manages flock."

hdr "DONE — $LOG"
