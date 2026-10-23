#!/usr/bin/env bash
# launch-collector.sh — start the mcp-sight collector as root.
#
# bpftrace needs elevation on this box (kernel.unprivileged_bpf_disabled=2,
# perf_event_paranoid=2, tracefs not world-readable). The collector itself is
# read-only observation; the only privilege it needs is the ability to attach
# tracepoints/fentry probes.
#
# Usage:
#   ./launch-collector.sh             # run foreground (as root, escalates via sudo -n)
#   ./launch-collector.sh --as-root   # already root; just exec the collector
#
# For durable production, run this under a ROOT systemd unit (the systemd USER
# manager cannot raise ambient capabilities here, so the unit belongs in
# /etc/systemd/system). See README.md for the unit file.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${MCP_SIGHT_STATE:-$HOME/.fleet-bus/var/openfang-health/sight}"

export MCP_SIGHT_STATE="$STATE"
mkdir -p "$STATE"

# Already root (systemd root unit, or escalated) -> just run.
if [ "$(id -u)" = "0" ]; then
  exec python3 "$DIR/collector.py" --sudo --state-dir "$STATE"
fi

# Not root but sudo -n is available -> escalate, keeping stdin from a TTY so a
# human can Ctrl-C; detached runs use systemd.
exec sudo -n /usr/bin/env \
  MCP_SIGHT_STATE="$STATE" \
  python3 "$DIR/collector.py" --sudo --state-dir "$STATE"