#!/usr/bin/env bash
# forge blue-green deploy — blue=awrawr-pc (here), green=dediops (almalinux-server).
#
# Builds via the forge remote cache (flicker :25148 / MISE_CACHE_REMOTE_URL),
# ships the artifact to the green lane with a health gate before the switch.
# GREEN SIDE AUTH IS PENDING (2026-10-30): this box's ed25519 key is not yet
# authorized on dediops; the script fails fast (exit 2) until `ssh dediops true`
# succeeds in BatchMode. Alias lives in ~/.ssh/config (Host dediops).
set -euo pipefail

GREEN_HOST="${GREEN_HOST:-dediops}"
ARTIFACT="${1:-/home/toxic/pens/olympus/products/kappa/kappa-code/packages/cli/dist/@kappacode/cli-linux-x64/bin/kappa}"
GREEN_ROOT="forge-blue-green"

if ! ssh -o BatchMode=yes -o ConnectTimeout=6 "$GREEN_HOST" true 2>/home/toxic/tmp/bg-ssh-probe.err; then
  echo "GREEN LANE UNREACHABLE ($GREEN_HOST): key auth not established yet." >&2
  echo "Authorize this host's ed25519 key on dediops, then re-run." >&2
  exit 2
fi

[ -f "$ARTIFACT" ] || { echo "artifact missing: $ARTIFACT — run: mise run kappa-build" >&2; exit 1; }
BASE="$(basename "$ARTIFACT")"

ssh "$GREEN_HOST" "mkdir -p ~/$GREEN_ROOT/incoming ~/$GREEN_ROOT/green ~/$GREEN_ROOT/blue"
scp -q "$ARTIFACT" "$GREEN_HOST:$GREEN_ROOT/incoming/$BASE"

ssh "$GREEN_HOST" "
  set -e
  chmod +x ~/$GREEN_ROOT/incoming/$BASE
  # health gate: the incoming artifact must at least self-report
  ~/$GREEN_ROOT/incoming/$BASE --version
  mv ~/$GREEN_ROOT/incoming/$BASE ~/$GREEN_ROOT/green/$BASE
"
echo "green lane updated: $GREEN_HOST:$GREEN_ROOT/green/$BASE"
echo "switch: repoint the green service at $GREEN_ROOT/green/ and restart; blue stays live here."
