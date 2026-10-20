#!/bin/sh
# cuttinggate-serve.sh -- pitchfork wrapper: inject client keys from the vault.
# Cuttinggate REQUIRES CUTTINGGATE_CLIENT_KEYS; without it parseClientKeys()
# returns an empty digest list and EVERY Bearer token is rejected with
# auth_missing (the 2026-10-15 "flock key" bug: flock :25193 is retired, the
# running server had zero keys configured, nothing could authenticate).
# Secrets stay in the vault; this script only exports them.
set -e
SECRETS=/home/toxic/.secrets
if [ -f "$SECRETS" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS"
fi
: "${CUTTINGGATE_CLIENT_KEY:?CUTTINGGATE_CLIENT_KEY missing from $SECRETS}"
export CUTTINGGATE_CLIENT_KEYS="$CUTTINGGATE_CLIENT_KEY"
cd /home/toxic/estate/ranch/forge/router/cuttinggate
exec bun run src/server.ts
