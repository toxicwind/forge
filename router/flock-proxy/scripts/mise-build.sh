#!/usr/bin/env bash
# Direct build entry: mise owns the toolchain; mbx-cache restores eligible task outputs.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BUILD_CMD=$(cat <<'BUILD'
cargo build && cargo test
BUILD
)
exec "$ROOT/scripts/mise-build.sh" "flock" "$ROOT/mesh/proxy/flock-proxy" "$BUILD_CMD"
