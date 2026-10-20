#!/usr/bin/env bash
# Direct build entry: mise owns the toolchain; mbx-cache restores eligible task outputs.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BUILD_CMD=$(cat <<'BUILD'
go build ./... && go test -short -count=1 ./internal/...
BUILD
)
exec "$ROOT/scripts/mise-build.sh" "herd" "$ROOT/mesh/router/herd" "$BUILD_CMD"
