#!/usr/bin/env bash
# Local mise task-cache server. Runtime data stays in var/runtime, source in vendored.
set -euo pipefail

ROOT="${ESTATE_HOME:-/home/toxic/estate}"
BIN="$ROOT/vendored/mr-boxington-cache/target/release/mbx-cache"
DATA_DIR="${MBX_CACHE_DATA_DIR:-$ROOT/var/runtime/mbx-cache}"
PORT="${MBX_CACHE_PORT:?MBX_CACHE_PORT must come from config/ports.env}"

[[ -x "$BIN" ]] || {
  echo "mbx-cache binary missing: build with mise exec -- cargo build --release in vendored/mr-boxington-cache" >&2
  exit 127
}
mkdir -p "$DATA_DIR"
exec "$BIN" --listen "127.0.0.1:$PORT" --storage filesystem --data-dir "$DATA_DIR" --allow-anonymous