#!/usr/bin/env bash
# maximal-host-pack.sh — run ON toxic@awrawr-pc (NOT on Grok Bot VM).
# Phases A–G per /workspace/plans/2026-10-07-estate-forward.md
# Prefer host scripts if present (comment SHAs from estate history):
#   ranch/doorbell/scripts/funnel-on.sh        # @ SHA 942ba604…
#   estate copy / patch-upstreams.sh           # @ SHA 0ac68ff5…
#   ranch/doorbell/host-install/pitchfork-takeover.sh
set -euo pipefail

ESTATE="${ESTATE:-$HOME/estate}"
RANCH="${RANCH:-$ESTATE/ranch}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$HOME/.tau/archives}"
TS="$(date +%Y%m%d-%H%M%S)"
TAR="$ARCHIVE_DIR/estate-rescue-${TS}.tar.gz"
MANIFEST="$ARCHIVE_DIR/manifest-${TS}.txt"
FUNNEL_HOST="${FUNNEL_HOST:-github-mcp-host.tailc9ac71.ts.net}"
SAFE_PUSH="${SAFE_PUSH:-0}"

die() { echo "FATAL: $*" >&2; exit 1; }
info() { echo "=== $* ==="; }

[ "$(id -un)" = "toxic" ] || echo "WARN: expected user toxic (got $(id -un))"
[ -d "$ESTATE" ] || die "missing $ESTATE — refuse to invent layout"
[ -d "$RANCH" ] || die "missing $RANCH"

# ─────────────────────────────────────────────────────────────
# A) Funnel diagnose + fix + curl prove public MCP paths
# ─────────────────────────────────────────────────────────────
info "A) Funnel diagnose"
tailscale serve status 2>&1 | head -30 || true
tailscale funnel status 2>&1 | head -20 || true

# Prefer existing host funnel-on.sh (@ SHA 942ba604…) under ranch/doorbell or estate
FUNNEL_SCRIPT=""
for cand in \
  "$RANCH/doorbell/scripts/funnel-on.sh" \
  "$ESTATE/bin/funnel-on.sh" \
  "$ESTATE/ops/funnel-on.sh" \
  "$RANCH/doorbell/host-install/funnel-on.sh"
do
  if [ -x "$cand" ] || [ -f "$cand" ]; then FUNNEL_SCRIPT="$cand"; break; fi
done

if [ -n "$FUNNEL_SCRIPT" ]; then
  info "A) calling existing $FUNNEL_SCRIPT"
  bash "$FUNNEL_SCRIPT" || true
else
  info "A) no funnel-on.sh — manual Funnel enable (never: --https=443 on)"
  # Ensure serve points at doorbell :25202 (do NOT steal :25204)
  curl -fsS -o /dev/null "http://127.0.0.1:25202/health" \
    || die "doorbell not healthy on :25202 — fix pitchfork before Funnel"
  # Prefer pitchfork-takeover if present (does not touch Tailscale itself)
  for pt in \
    "$RANCH/doorbell/host-install/pitchfork-takeover.sh" \
    "$ESTATE/ranch/doorbell/host-install/pitchfork-takeover.sh"
  do
    if [ -f "$pt" ]; then
      echo "(pitchfork-takeover present at $pt — not re-running unless FORCE_TAKEOVER=1)"
      break
    fi
  done
  # Serve paths → :25202 (aliases)
  tailscale serve --bg --yes --set-path=/doorbell-mcp http://127.0.0.1:25202/mcp 2>/dev/null \
    || tailscale serve --bg https+insecure://127.0.0.1:25202 2>/dev/null \
    || true
  tailscale serve --bg --yes --set-path=/gemini-mcp http://127.0.0.1:25202/mcp 2>/dev/null || true
  # Funnel ON — correct forms only (bare "on" after --https=443 is wrong)
  ok=0
  for cmd in \
    "tailscale funnel --bg --yes 443" \
    "tailscale funnel --yes 443" \
    "tailscale funnel 443 on" \
    "tailscale funnel 443"
  do
    echo "+ $cmd"
    if eval "$cmd" 2>&1; then ok=1; break; fi
  done
  [ "$ok" -eq 1 ] || echo "WARN: Funnel CLI may need admin ACL; continuing to prove curls"
fi

# Optional gatehouse upstream patch (@ SHA 0ac68ff5…) — call if present, never invent symlinks
for pu in \
  "$ESTATE/ops/patch-upstreams.sh" \
  "$ESTATE/bin/patch-upstreams.sh" \
  "$RANCH/doorbell/scripts/patch-upstreams.sh"
do
  if [ -f "$pu" ]; then
    info "A) patch-upstreams.sh present → $pu (no :25204 steal)"
    bash "$pu" || echo "WARN: patch-upstreams exited non-zero"
    break
  fi
done

info "A) prove public Funnel (MagicDNS 200 ≠ public)"
tailscale serve status 2>&1 | head -25 || true
PUB_OK=1
for path in /doorbell-mcp /gemini-mcp; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST "https://${FUNNEL_HOST}${path}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"maximal-pack","version":"1"}}}' \
    || echo "000")
  echo "public ${path} → HTTP ${code}"
  case "$code" in
    200|401|403|405|406) ;; # reachable (auth/method may vary)
    *) PUB_OK=0; echo "WARN: ${path} not publicly reachable (code=$code)" ;;
  esac
done
if [ "$PUB_OK" -ne 1 ]; then
  echo "WARN: Funnel prove incomplete — check admin Funnel ACL; MagicDNS alone is not public"
fi

# ─────────────────────────────────────────────────────────────
# B) Archive (SHA256 + non-empty gate); tar -C $HOME relative paths
# ─────────────────────────────────────────────────────────────
info "B) Archive rescue → $TAR"
mkdir -p "$ARCHIVE_DIR"

# Build relative-to-$HOME path list of things that exist
REL_PATHS=()
for rel in \
  "estate/var/scratch" \
  "estate/ranch/tack" \
  "estate/README.md" \
  "estate/ranch/README.md" \
  "estate/.gitmodules" \
  "estate/ranch/.gitmodules"
do
  if [ -e "$HOME/$rel" ]; then
    REL_PATHS+=("$rel")
  else
    echo "skip missing: $rel"
  fi
done
[ ${#REL_PATHS[@]} -gt 0 ] || die "nothing to archive — refuse empty op"

tar -C "$HOME" -czf "$TAR" "${REL_PATHS[@]}"
[ -s "$TAR" ] || die "archive empty or missing: $TAR"
sha256sum "$TAR" | tee "$MANIFEST"
# also record member list for rollback clarity
{
  echo "--- members ---"
  tar -tzf "$TAR"
} >> "$MANIFEST"
info "B) archive OK ($(wc -c < "$TAR") bytes) → $MANIFEST"

# ─────────────────────────────────────────────────────────────
# C) Purge only after archive OK
# ─────────────────────────────────────────────────────────────
info "C) Purge tack + scratch rescue + .tmp-clone-*"
# tack
if [ -d "$RANCH/tack" ]; then
  rm -rf "$RANCH/tack"
  echo "purged $RANCH/tack"
fi
# scratch rescue dirs only (tmp-rescue-* and similar zombies)
if [ -d "$ESTATE/var/scratch" ]; then
  find "$ESTATE/var/scratch" -maxdepth 1 -mindepth 1 \
    \( -name 'tmp-rescue-*' -o -name '*rescue*' -o -name 'tmp-clone-*' -o -name '.tmp-clone-*' \) \
    -print -exec rm -rf {} + 2>/dev/null || true
fi
# .tmp-clone-* under tau plugins cache
for root in "$HOME/tau" "$HOME/.tau" "$ESTATE/tau"; do
  [ -d "$root" ] || continue
  find "$root" -maxdepth 4 -type d -name '.tmp-clone-*' -print -exec rm -rf {} + 2>/dev/null || true
done

# ─────────────────────────────────────────────────────────────
# D) Sanitize dead gitmodules entries carefully (audit only)
# ─────────────────────────────────────────────────────────────
info "D) Sanitize dead .gitmodules entries (no blind wipe)"
GM="$ESTATE/.gitmodules"
if [ -f "$GM" ]; then
  cp -a "$GM" "$GM.bak.${TS}"
  # Dead paths called out in plan — remove ONLY these path= blocks
  python3 - "$GM" <<'PY'
import sys, re
path = sys.argv[1]
dead = {"projects/shell/ii", "tau/vendors"}
text = open(path).read()
# split into submodule stanzas
parts = re.split(r'(?=^\[submodule\s+")', text, flags=re.M)
kept = []
removed = []
for p in parts:
    if not p.strip():
        continue
    m = re.search(r'^\s*path\s*=\s*(\S+)', p, re.M)
    sub_path = m.group(1) if m else None
    if sub_path in dead:
        removed.append(sub_path)
        continue
    kept.append(p)
new = "".join(kept)
# normalize trailing newline
if new and not new.endswith("\n"):
    new += "\n"
open(path, "w").write(new)
print("removed:", removed or "(none matched)")
print("remaining stanzas:", len(kept))
PY
  echo "backup: $GM.bak.${TS}"
  # drop matching git index entries if present (best-effort)
  for dead in projects/shell/ii tau/vendors; do
    if git -C "$ESTATE" ls-files --error-unmatch "$dead" >/dev/null 2>&1; then
      git -C "$ESTATE" rm -rf --cached "$dead" 2>/dev/null || true
    fi
    # also clear submodule section from .git/config if any
    git -C "$ESTATE" config --remove-section "submodule.$dead" 2>/dev/null || true
  done
else
  echo "no $GM — skip"
fi
# ranch .gitmodules: audit same dead names if present; never wipe to one entry
RGM="$RANCH/.gitmodules"
if [ -f "$RGM" ]; then
  cp -a "$RGM" "$RGM.bak.${TS}"
  if grep -E 'projects/shell/ii|tau/vendors' "$RGM" >/dev/null 2>&1; then
    python3 - "$RGM" <<'PY'
import sys, re
path = sys.argv[1]
dead = {"projects/shell/ii", "tau/vendors"}
text = open(path).read()
parts = re.split(r'(?=^\[submodule\s+")', text, flags=re.M)
kept, removed = [], []
for p in parts:
    if not p.strip():
        continue
    m = re.search(r'^\s*path\s*=\s*(\S+)', p, re.M)
    sub_path = m.group(1) if m else None
    if sub_path in dead:
        removed.append(sub_path); continue
    kept.append(p)
new = "".join(kept)
if new and not new.endswith("\n"):
    new += "\n"
open(path, "w").write(new)
print("ranch removed:", removed or "(none)")
PY
  else
    echo "ranch .gitmodules has no known-dead entries — leave intact"
  fi
fi

# ─────────────────────────────────────────────────────────────
# E) Write plane-map READMEs + ops/sync.sh
# ─────────────────────────────────────────────────────────────
info "E) Write estate/README.md + ranch/README.md + estate/ops/sync.sh"

mkdir -p "$ESTATE/ops"

cat > "$ESTATE/README.md" << 'EOF'
# estate — ops / master plane

Host ops for **yote** (awrawr-pc). Project code lives in [ranch](./ranch). Private cell: **hatch**. Public MCP: **doorbell**.

## Planes

| Plane | Path / repo | Role |
|-------|-------------|------|
| Ops / master | `toxicwind/estate` → `~/estate` | pitchfork, config, bin, stack, ports |
| Projects | `toxicwind/ranch` → `~/estate/ranch` | animals as directories |
| Control cell | `toxicwind/hatch` (private) | Ember; light only |
| Bot plane | `ranch/arroyo/` | overlord · coyote · discord · mcp |
| Public MCP | `ranch/doorbell` (+ `toxicwind/doorbell` curl mirror) | `:25202`, aliases `/doorbell-mcp` `/gemini-mcp` |
| Agent | `toxicwind/tau` | nested or `~/tau` — one SSOT |
| Fleet / oracle | ranch + `toxicwind/squawk` | as today |

**Host name is yote.** Product rename: yote → coyote (bot). Do not confuse machine with product.

## SSOT

- Ports: `config/ports.env` (do **not** steal `:25204` — awrawr-ws-exec)
- Doorbell: `:25202` — Funnel public; MagicDNS ≠ public Funnel
- Provider authority: **roost** (`ranch/roost`) — no `tack` resurrection
- Workspaces `xai/` and `spark/` are **not** symlinked into live paths

## Deep links

- ranch · tau · hatch · doorbell · squawk
- Ops sync: `ops/sync.sh` (status across estate / ranch / tau)

## Invariants

1. Project code → ranch; host ops → estate; cell → hatch.
2. Ship on `main` (no PR theater).
3. Archive then purge; never edit only the live doorbell path.
EOF

cat > "$RANCH/README.md" << 'EOF'
# ranch — animals by plane

Monorepo under `~/estate/ranch` (`toxicwind/ranch`). Host ops stay in **estate**. Host machine stays **yote**.

## Inference

- herd · hodos · cuttinggate · roost · keypool

## MCP

- gatehouse · doorbell · switchboard · lasso
- Doorbell public: `:25202` via Tailscale Funnel (`/doorbell-mcp`, `/gemini-mcp`)
- Gatehouse MCP shim target typically `:25127` (see arroyo/mcp)

## Fleet

- squawk · campfire · corral

## Bot — arroyo

`ranch/arroyo/` bot plane umbrella:

| Dir | Role |
|-----|------|
| overlord/ | GramJS MTProto — puppertrix / BotFather control |
| coyote/ | Bun bot path (ex product name "yote") |
| discord/ | Discord surface |
| mcp/ | thin shim → gatehouse |

Env: introduce `ARROYO_*`, keep `YOTE_*` aliases until cutover. See `arroyo/MOVE.md`.

## Agent

- tau via chute (or `~/tau`)

## Do not

- Resurrect `tack/` (superseded by roost)
- Treat hodos as sole cloud door / invent wrong ports
- Blind-wipe `.gitmodules` — audit dead entries only
EOF

# Kill Estate-projects fiction if present
if [ -f "$ESTATE/ESTATE-PROJECTS.md" ]; then
  mv "$ESTATE/ESTATE-PROJECTS.md" "$ESTATE/ESTATE-PROJECTS.md.bak.${TS}"
  echo "archived fiction ESTATE-PROJECTS.md → .bak.${TS}"
fi
if [ -f "$RANCH/ESTATE-PROJECTS.md" ]; then
  mv "$RANCH/ESTATE-PROJECTS.md" "$RANCH/ESTATE-PROJECTS.md.bak.${TS}"
fi

cat > "$ESTATE/ops/sync.sh" << 'EOF'
#!/usr/bin/env bash
# Status across estate / ranch / tau (and herd if separate). No auto-commit.
set -euo pipefail
ESTATE="${ESTATE:-$HOME/estate}"
REPOS=(
  "$ESTATE"
  "$ESTATE/ranch"
  "$HOME/tau"
)
# optional herd path if checked out separately
[ -d "$ESTATE/ranch/herd/.git" ] && REPOS+=("$ESTATE/ranch/herd")
[ -d "$HOME/herd/.git" ] && REPOS+=("$HOME/herd")

for repo in "${REPOS[@]}"; do
  if [ ! -d "$repo/.git" ] && [ ! -e "$repo/.git" ]; then
    echo "SKIP (not a git repo): $repo"
    continue
  fi
  echo "-------- $repo --------"
  git -C "$repo" status -sb || true
  git -C "$repo" remote -v 2>/dev/null | head -4 || true
done
EOF
chmod +x "$ESTATE/ops/sync.sh"

# ─────────────────────────────────────────────────────────────
# F) ranch/arroyo/ skeleton + MOVE.md
# ─────────────────────────────────────────────────────────────
info "F) Create ranch/arroyo/ skeleton"
ARROYO="$RANCH/arroyo"
mkdir -p "$ARROYO"/{overlord,coyote,discord,mcp}

cat > "$ARROYO/README.md" << 'EOF'
# arroyo — bot plane

Umbrella for overlord · coyote · discord · mcp under ranch.

- **Host machine** stays **yote** (awrawr-pc).
- **Product** rename: yote → coyote (Bun path).
- Env: `ARROYO_*` preferred; keep `YOTE_*` aliases until cutover.
- MCP shim → gatehouse (typically `:25127`). Do not bind `:25204`.

See MOVE.md for migration from legacy yote paths.
EOF

for stub in overlord coyote discord mcp; do
  cat > "$ARROYO/$stub/README.md" << EOF
# arroyo/$stub

Stub — land code here. Product plane: arroyo. Host remains yote.
EOF
done

cat > "$ARROYO/MOVE.md" << 'EOF'
# MOVE — yote → arroyo/coyote

## Mapping

| Legacy | New |
|--------|-----|
| standalone `toxicwind/yote` / `~/yote` | `ranch/arroyo/coyote/` |
| Overlord / puppertrix GramJS | `ranch/arroyo/overlord/` |
| Discord bot surface | `ranch/arroyo/discord/` |
| MCP shim into gatehouse | `ranch/arroyo/mcp/` |

## Rules

1. Host name stays **yote**; only the product moves.
2. Introduce `ARROYO_*`; keep `YOTE_*` (e.g. `YOTE_TELEGRAM_API_ID/HASH/SESSION`) as aliases until cutover.
3. Archive standalone `toxicwind/yote` only after in-tree SSOT proven (historically `:25102`).
4. Never edit only the live path; do not symlink xai/spark workspaces.
5. Do not steal `:25204` (awrawr-ws-exec). Doorbell public stays `:25202`.

## Cutover checklist

- [ ] Copy/move sources into stubs above
- [ ] Point pitchfork / serve configs at new paths
- [ ] Prove Overlord BotFather flow + Bun coyote token path
- [ ] Archive old yote repo/tree
EOF

# ─────────────────────────────────────────────────────────────
# G) git add/commit on estate + ranch mains; print push (no push unless SAFE_PUSH=1)
# ─────────────────────────────────────────────────────────────
info "G) Commit on main (no push unless SAFE_PUSH=1)"

commit_repo() {
  local repo="$1" msg="$2"
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "not a git repo: $repo"
  git -C "$repo" add -A
  if git -C "$repo" diff --cached --quiet; then
    echo "no staged changes in $repo"
    return 0
  fi
  git -C "$repo" commit -m "$msg"
  echo "committed $repo: $msg"
  git -C "$repo" log -1 --oneline
}

commit_repo "$ESTATE" \
  "chore: archive rescue scratch, sanitize gitmodules, README plane map, ops/sync.sh"

commit_repo "$RANCH" \
  "docs: plane map + arroyo skeleton; chore: remove tack (archived)"

echo
echo "======== PUSH COMMANDS (not run unless SAFE_PUSH=1) ========"
echo "  git -C \"$ESTATE\" push origin main"
echo "  git -C \"$RANCH\"  push origin main"
echo "============================================================"

if [ "$SAFE_PUSH" = "1" ]; then
  info "SAFE_PUSH=1 → pushing mains"
  git -C "$ESTATE" push origin main
  git -C "$RANCH"  push origin main
else
  echo "Skipped push (set SAFE_PUSH=1 to enable)."
fi

info "DONE"
echo "Archive: $TAR"
echo "Manifest: $MANIFEST"
echo "Rollback: tar -C \"\$HOME\" -xzf \"$TAR\""
