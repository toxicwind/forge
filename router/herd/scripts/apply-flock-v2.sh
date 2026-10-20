#!/bin/bash
set -euo pipefail

# =============================================================================
# FLOCK V2 — PRODUCTION-GRADE CLOUD ROUTER FOR HERD
# Apply this patch set to upstream herd
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_REPO="${1:-}"

if [ -z "$TARGET_REPO" ]; then
    echo "Usage: $0 <path-to-herd-repo>"
    echo ""
    echo "Example:"
    echo "  $0 ~/projects/herd"
    exit 1
fi

if [ ! -d "$TARGET_REPO/.git" ]; then
    echo "ERROR: $TARGET_REPO is not a git repository"
    exit 1
fi

cd "$TARGET_REPO"

# Verify upstream (no flock module yet)
if [ -d "internal/flock" ]; then
    echo "WARNING: internal/flock already exists — this may be a fork, not upstream"
    echo "Continuing anyway..."
fi

echo "=== [1/4] BACKUP EXISTING FILES ==="
cp internal/config/config.go internal/config/config.go.bak.$(date +%s)
cp internal/server/server.go internal/server/server.go.bak.$(date +%s)

echo ""
echo "=== [2/4] COPY FLOCK MODULE ==="
mkdir -p internal/flock
cp "$SCRIPT_DIR/internal/flock/"*.go internal/flock/
ls -la internal/flock/

echo ""
echo "=== [3/4] APPLY PATCHES ==="
# Apply config.go patch
if [ -f "$SCRIPT_DIR/patches/flock-v2/config.go.patch" ]; then
    patch -p1 < "$SCRIPT_DIR/patches/flock-v2/config.go.patch" || {
        echo "config.go patch failed, applying manually..."
        cp "$SCRIPT_DIR/patches/flock-v2/config.go.new" internal/config/config.go
    }
fi

# Apply server.go patch
if [ -f "$SCRIPT_DIR/patches/flock-v2/server.go.patch" ]; then
    patch -p1 < "$SCRIPT_DIR/patches/flock-v2/server.go.patch" || {
        echo "server.go patch failed, applying manually..."
        cp "$SCRIPT_DIR/patches/flock-v2/server.go.new" internal/server/server.go
    }
fi

echo ""
echo "=== [4/4] ADD DEPENDENCY ==="
# Add sqlite3 dependency if not present
if ! grep -q "mattn/go-sqlite3" go.mod; then
    go get github.com/mattn/go-sqlite3
fi

echo ""
echo "=== VERIFY BUILD ==="
go build ./... && echo "BUILD OK" || echo "BUILD FAILED — check errors above"

echo ""
echo "=== DONE ==="
echo "Flock V2 applied to $TARGET_REPO"
echo ""
echo "Next steps:"
echo "  1. Edit config.yaml to add flock section"
echo "  2. Run: go test ./internal/flock/..."
echo "  3. Commit: git add internal/flock && git commit -m 'feat: flock v2 production router'"
