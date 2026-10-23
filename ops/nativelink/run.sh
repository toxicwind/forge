#!/usr/bin/env bash
# NativeLink launcher — prefers cargo/mise binary
set -euo pipefail
ROOT=/home/toxic/var/runtime/nativelink
install -d -m 0755 "$ROOT/cas/content" "$ROOT/cas/tmp" "$ROOT/ac/content" "$ROOT/ac/tmp" "$ROOT/work"
BIN=${NATIVELINK_BIN:-}
if [[ -z "$BIN" ]]; then
  for c in /home/toxic/.cargo/bin/nativelink /home/toxic/.local/bin/nativelink; do
    [[ -x "$c" ]] && BIN=$c && break
  done
fi
[[ -n "$BIN" ]] || { echo nativelink binary not found; exit 1; }
exec "$BIN" /home/toxic/estate/config/nl/nativelink.json5
