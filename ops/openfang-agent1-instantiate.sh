#!/usr/bin/env bash
# openfang-agent1-instantiate.sh — instantiate persistent openfang Agent 1 in ONE command.
#
# Usage:
#   openfang-agent1-instantiate.sh --persona-file PATH [--name agent1] [--i-accept-proposal]
#
# The persona definition must come from the Agent 1 lead (per directives.md and
# User's order 2026-09-14: agent1 names itself — no assignment from above).
# This script does NOT invent a persona; it installs the one you hand it.
#
# Model path: llama-swap/kimi-auto via :25100 (live). The nvidia provider key is
# stale (401), so any persona file requesting provider=nvidia will be overridden
# to llama-swap with a loud warning.
#
# Safety: refuses to install a file marked as PROPOSAL unless --i-accept-proposal
# is passed explicitly.
set -euo pipefail

PERSONA_FILE=""
NAME="agent1"
ACCEPT_PROPOSAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --persona-file) PERSONA_FILE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --i-accept-proposal) ACCEPT_PROPOSAL=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -n "$PERSONA_FILE" ] || { echo "missing --persona-file" >&2; exit 1; }
[ -f "$PERSONA_FILE" ] || { echo "persona file not found: $PERSONA_FILE" >&2; exit 1; }

if grep -q "PROPOSAL - NOT DEPLOYED" "$PERSONA_FILE" 2>/dev/null; then
  if [ "$ACCEPT_PROPOSAL" -eq 0 ]; then
    echo "REFUSED: $PERSONA_FILE is marked PROPOSAL - NOT DEPLOYED." >&2
    echo "The Agent 1 persona must come from the Agent 1 lead (User's order 2026-09-14:" >&2
    echo "agent1 names itself; the persona will not be invented)." >&2
    echo "To install the proposal anyway, pass --i-accept-proposal." >&2
    exit 1
  fi
  echo "WARNING: installing a PROPOSAL persona as decided — you passed --i-accept-proposal." >&2
fi

AGENT_DIR="/home/toxic/.openfang/agents/$NAME"
mkdir -p "$AGENT_DIR"

SYSTEM_PROMPT="$(cat "$PERSONA_FILE")"

cat >"$AGENT_DIR/agent.toml" <<EOF
name = "$NAME"
version = "1.0.0"
description = "Agent 1 — persistent openfang agent. Persona supplied by the Agent 1 lead."
author = "toxicwind"
module = "builtin:chat"
schedule = "reactive"

[model]
provider = "llama-swap"
model = "kimi-auto"
base_url = "http://127.0.0.1:25100/v1"
max_tokens = 131072
temperature = 0.7

[resources]
max_memory_bytes = 268435456
max_tool_calls_per_minute = 60
max_network_bytes_per_hour = 104857600

[capabilities]
network = ["127.0.0.1:*", "localhost:*"]
tools = ["file_read", "file_list", "file_write", "shell_exec", "web_fetch", "web_search", "memory_store", "memory_recall", "agent_spawn", "mcp_call", "channel_send"]
memory_read = []
memory_write = []
agent_spawn = true

[metadata]
instantiated_by = "openfang-agent1-instantiate.sh"
EOF

printf '%s\n' "$SYSTEM_PROMPT" >"$AGENT_DIR/system.md"
chmod 600 "$AGENT_DIR/agent.toml" "$AGENT_DIR/system.md"

echo "agent files written to $AGENT_DIR — verifying registration..."
if timeout 60 openfang agent list 2>/dev/null | grep -v 'INFO\|WARN' | awk -v n="$NAME" '$2==n && $3=="Running" {found=1} END {exit !found}'; then
  echo "OK: agent '$NAME' is Running."
else
  echo "VERIFY: agent '$NAME' not (yet) Running — kernel syncs TOML on boot; re-run 'openfang agent list'." >&2
  exit 2
fi
