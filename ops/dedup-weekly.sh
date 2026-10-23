#!/usr/bin/env bash
# dedup-weekly.sh — weekly btrfs block-level dedup for the estate.
#
# Uses fclones (znver4 build): `fclones group` finds duplicate content by
# size+hash, `fclones dedupe` merges identical extents via FIDEDUPERANGE.
# This is content-hash verified and extent-level: files are never deleted,
# paths/symlinks/permissions are untouched — only identical data blocks get
# shared, freeing disk space. Safe to run on live trees.
#
# Wired as a weekly cron (toxic's crontab, Sundays 05:23). Also safe to run
# by hand: /home/toxic/estate/ops/dedup-weekly.sh
#
# Added 2026-10-04 (Deduper, Forge's crew): the 2026-10-03 fclones audit
# found ~34.9 GB reclaimable across cold-storage + estate; top waste =
# duplicated daily cell-backup tarballs and rescued worktree copies.

set -euo pipefail

REPO=/home/toxic/estate
LOG_DIR="$REPO/var/log"
RUN_DIR="$REPO/var/run"
LOCK="$RUN_DIR/dedup-weekly.lock"
LOG="$LOG_DIR/dedup-weekly.log"
GROUP_FILE="$LOG_DIR/dedup-groups-$(date -u +%Y%m%dT%H%M%SZ).txt"
FCLONES=/usr/bin/fclones

# Scopes: the trees the 2026-10-03 fclones audit covered.
SCOPES=(/home/toxic/cold-storage /home/toxic/estate)

mkdir -p "$LOG_DIR" "$RUN_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

# Single-flight: cron + manual runs must never overlap.
exec 9>"$LOCK"
if ! hodos -n 9; then
  log "another dedup run holds $LOCK; exiting"
  exit 0
fi

command -v "$FCLONES" >/dev/null || { log "fclones not found at $FCLONES; aborting"; exit 1; }

df_before=$(df -B1 --output=avail /home | tail -1 | tr -d ' ')
log "start: /home avail=${df_before}B scopes=${SCOPES[*]}"

# Phase 1: group identical files (size + hash, 4KiB blocks, 16 threads).
log "phase 1: fclones group"
"$FCLONES" group -s 4KiB -t 16 "${SCOPES[@]}" > "$GROUP_FILE" 2>>"$LOG"
log "phase 1 done: groups file $GROUP_FILE ($(wc -l < "$GROUP_FILE") lines)"

# Phase 2: dedupe — byte-verified extent merge via FIDEDUPERANGE.
# Nothing is deleted; identical blocks are shared. This job runs for real
# (not dry-run): btrfs dedupe is content-verified and safe on live trees.
log "phase 2: fclones dedupe"
if "$FCLONES" dedupe < "$GROUP_FILE" >>"$LOG" 2>&1; then
  log "phase 2 done"
else
  log "phase 2 exited nonzero (see above); continuing to measurement"
fi

df_after=$(df -B1 --output=avail /home | tail -1 | tr -d ' ')
reclaimed=$((df_after - df_before))
log "done: /home avail=${df_after}B reclaimed=${reclaimed}B groups=$GROUP_FILE"

# Keep the last 8 group files; drop older ones.
ls -t "$LOG_DIR"/dedup-groups-*.txt 2>/dev/null | tail -n +9 | xargs -r rm -f
