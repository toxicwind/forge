#!/usr/bin/env bash
# host-install-remora.sh — run ON toxic@awrawr-pc (NOT on Grok Bot VM).
# Inventories /home/toxic/hatch for remora / agents / personas; installs
# persona-remora.md; prints hatch-mcp patch notes so squawk_send accepts
# sender=remora without silently rewriting to ember.
set -euo pipefail

SENDER="remora"
PERSONA_SRC=""
HATCH_ROOT="${HATCH_ROOT:-/home/toxic/hatch}"
ESTATE_ROOT="${ESTATE_ROOT:-/home/toxic/estate}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[remora-install] %s\n' "$*"; }
die() { printf '[remora-install] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ "$(id -un)" != "toxic" ]] && [[ "${FORCE_NON_TOXIC:-}" != "1" ]]; then
  die "expected user toxic on awrawr-pc (set FORCE_NON_TOXIC=1 to override)"
fi

# Resolve persona source: sibling of this script, or explicit env
if [[ -f "${SCRIPT_DIR}/persona-remora.md" ]]; then
  PERSONA_SRC="${SCRIPT_DIR}/persona-remora.md"
elif [[ -f "${PERSONA_REMORA_SRC:-}" ]]; then
  PERSONA_SRC="${PERSONA_REMORA_SRC}"
else
  die "persona-remora.md not found next to script (${SCRIPT_DIR}) and PERSONA_REMORA_SRC unset"
fi

SENDER_JSON=""
if [[ -f "${SCRIPT_DIR}/squawk-sender.json" ]]; then
  SENDER_JSON="${SCRIPT_DIR}/squawk-sender.json"
fi

log "inventory hatch root: ${HATCH_ROOT}"
if [[ ! -d "${HATCH_ROOT}" ]]; then
  log "WARN: ${HATCH_ROOT} missing — will fall back to estate/docs/fleet if needed"
fi

inventory() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  log "--- inventory under ${root} ---"
  # remora / agents / personas
  find "$root" \( -iname '*remora*' -o -iname '*persona*' \) 2>/dev/null | head -80 || true
  for d in agents personas agents/personas persona personas/remora agents/remora remora; do
    if [[ -e "${root}/${d}" ]]; then
      log "found: ${root}/${d}"
      ls -la "${root}/${d}" 2>/dev/null | head -40 || true
    fi
  done
}

inventory "${HATCH_ROOT}"
inventory "${ESTATE_ROOT}/docs/fleet" 2>/dev/null || true

# Candidate install targets (first writable/creatable wins after preference order)
prefer_targets=(
  "${HATCH_ROOT}/personas/remora"
  "${HATCH_ROOT}/agents/personas/remora"
  "${HATCH_ROOT}/agents/remora"
  "${HATCH_ROOT}/remora"
  "${ESTATE_ROOT}/docs/fleet/remora"
)

EXISTING_REMORA=""
for t in "${prefer_targets[@]}"; do
  if [[ -d "$t" ]] || [[ -f "${t}/persona-remora.md" ]] || [[ -f "${t}/persona.md" ]]; then
    EXISTING_REMORA="$t"
    break
  fi
done

install_persona() {
  local dest_dir="$1"
  mkdir -p "${dest_dir}"
  local dest_file="${dest_dir}/persona-remora.md"
  if [[ -f "${dest_file}" ]] || [[ -L "${dest_file}" ]]; then
    log "persona already present at ${dest_file} — refreshing from scaffold"
  fi
  # Prefer hard copy so hatch edits do not mutate the plans tree unexpectedly.
  # Set REMORA_LINK=1 to symlink instead.
  if [[ "${REMORA_LINK:-0}" == "1" ]]; then
    ln -sfn "${PERSONA_SRC}" "${dest_file}"
    log "linked ${dest_file} -> ${PERSONA_SRC}"
  else
    cp -a "${PERSONA_SRC}" "${dest_file}"
    log "copied persona -> ${dest_file}"
  fi
  if [[ -n "${SENDER_JSON}" ]]; then
    cp -a "${SENDER_JSON}" "${dest_dir}/squawk-sender.json"
    log "copied squawk-sender.json -> ${dest_dir}/squawk-sender.json"
  fi
}

if [[ -n "${EXISTING_REMORA}" ]]; then
  log "remora path exists: ${EXISTING_REMORA} — copy/link into it"
  install_persona "${EXISTING_REMORA}"
else
  # Prefer hatch agents/personas layout; else estate/docs/fleet
  DEST=""
  if [[ -d "${HATCH_ROOT}" ]]; then
    if [[ -d "${HATCH_ROOT}/personas" ]] || [[ -d "${HATCH_ROOT}/agents/personas" ]]; then
      if [[ -d "${HATCH_ROOT}/agents/personas" ]]; then
        DEST="${HATCH_ROOT}/agents/personas/remora"
      else
        DEST="${HATCH_ROOT}/personas/remora"
      fi
    elif [[ -d "${HATCH_ROOT}/agents" ]]; then
      DEST="${HATCH_ROOT}/agents/remora"
    else
      DEST="${HATCH_ROOT}/remora"
    fi
  else
    DEST="${ESTATE_ROOT}/docs/fleet/remora"
  fi
  log "no existing remora dir — installing under ${DEST}"
  install_persona "${DEST}"
fi

# --- hatch-mcp patch notes (do NOT auto-rewrite server.ts) ---
HATCH_MCP_CANDIDATES=(
  "${ESTATE_ROOT}/tools/hatch-mcp/server.ts"
  "${ESTATE_ROOT}/tools/hatch-mcp/src/server.ts"
  "${HATCH_ROOT}/hatch-mcp/server.ts"
)

log ""
log "======== hatch-mcp patch notes (manual) ========"
log "Goal: squawk_send MUST accept sender=${SENDER}."
log "Hard rule: do NOT silently rewrite remora (or unknown admin senders) to ember."
log "If validation fails, return an explicit error — never mask as ember."
log ""
log "Suggested allowlist / identity checks:"
log "  - allow sender slug: remora"
log "  - aliases: Grok Bot, grok-bot, remora -> remora"
log "  - admin: true (same weight class as ember for fleet ops)"
log "  - channels default: fleet, #ops"
log "  - reject any code path that coerces non-ember -> ember"
log ""
found_mcp=0
for f in "${HATCH_MCP_CANDIDATES[@]}"; do
  if [[ -f "$f" ]]; then
    found_mcp=1
    log "found hatch-mcp candidate: $f"
    if command -v rg >/dev/null 2>&1; then
      rg -n 'squawk_send|sender|ember|allow' "$f" 2>/dev/null | head -40 || true
    else
      grep -nE 'squawk_send|sender|ember|allow' "$f" 2>/dev/null | head -40 || true
    fi
  fi
done
if [[ "${found_mcp}" -eq 0 ]]; then
  log "no hatch-mcp server.ts found at known paths — locate via gatehouse mcp_config (hatch-mcp -> estate/tools/hatch-mcp/server.ts)"
fi
log "================================================"
log ""

# pitchfork restart note
log "======== pitchfork restart note ========"
if command -v pitchfork >/dev/null 2>&1; then
  log "pitchfork present: $(command -v pitchfork)"
  log "After patching hatch-mcp, restart the hatch-mcp unit if supervised, e.g.:"
  log "  pitchfork restart hatch-mcp"
  log "  # or: pitchfork restart hatch-mcp.service / check pitchfork.d/*hatch*mcp*"
  if [[ -d "${ESTATE_ROOT}/pitchfork.d" ]]; then
    ls "${ESTATE_ROOT}/pitchfork.d"/*hatch*mcp* 2>/dev/null | while read -r pf; do
      log "pitchfork.d unit: ${pf}"
    done || true
  fi
else
  log "pitchfork not on PATH — if hatch-mcp is pitchfork-managed on this host, restart it after the sender=remora patch."
fi
log "========================================"

log "done. Prove with squawk_send sender=remora (see MOVE.md). Never fall back to ember."
