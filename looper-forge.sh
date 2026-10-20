#!/usr/bin/env bash
# forge→forge looper — comprehensive brand rename for the ranch forge project.
# Renames all forge brand references to forge, including:
#   forge-server  -> forge-server
#   forge-agent   -> forge-agent
#   FORGE_ROOT    -> FORGE_ROOT
#   forge.toml    -> forge.toml
#   ranch/forge   -> ranch/forge
#   (title) Forge -> Forge
# Preserves the upstream woodpecker Go module path (go.woodpecker-ci.org/.../forge)
# so the vendored woodpecker fork's imports stay valid.
set -uo pipefail

ROOT="${1:-/home/toxic/estate/ranch/forge}"
LOGS="$(mktemp)"
renamed_bin=0

# 1) Rename directories containing 'forge' (leaf-first so parents resolve after children).
for d in $(find "$ROOT" -type d -name '*forge*' -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | sort -r); do
  bd="$(dirname "$d")"
  bb="$(basename "$d")"
  nb="${bb//forge/forge}"
  nb="${nb//Forge/Forge}"
  [ "$bb" = "$nb" ] || { git mv -f "$d" "$bd/$nb" 2>/dev/null && echo "dir: $d -> $bd/$nb" >>"$LOGS"; }
done

# 1b) Rename files with 'forge' in their basename -> 'forge'.
for f in $(find "$ROOT" -name '*forge*' -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null); do
  d="$(dirname "$f")"
  b="$(basename "$f")"
  nb="${b//forge/forge}"
  nb="${nb//Forge/Forge}"
  nf="$d/$nb"
  if [ "$f" != "$nf" ]; then
    git mv -f "$f" "$nf" 2>/dev/null || mv -f "$f" "$nf"
    echo "file: $f -> $nf" >>"$LOGS"
  fi
done

# 2) Content replace across text files (skip git objects, binaries, node_modules).
find "$ROOT" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' \
  \( -name '*.toml' -o -name '*.md' -o -name '*.sh' -o -name '*.ts' -o -name '*.go' -o -name '*.json' -o -name '*.yaml' -o -name '*.yml' -o -name '*.nix' \) \
  | while IFS= read -r f; do
    # Skip the upstream woodpecker module path files' imports? No — replace brand words but keep module path.
    # Order matters: longest/compound first so we don't double-replace inside already-forged names.
    sed -i \
      -e 's/FORGE_ROOT/FORGE_ROOT/g' \
      -e 's/forge-agent/forge-agent/g' \
      -e 's/forge-server/forge-server/g' \
      -e 's/forge-server\.service/forge-server.service/g' \
      -e 's/forge\.toml/forge.toml/g' \
      -e 's/ranch\/forge/ranch\/forge/g' \
      -e 's/forge/forge/g' \
      -e 's/Forge/Forge/g' \
      -e 's/FORGE/FORGE/g' \
      "$f"
    echo "content: $f" >>"$LOGS"
  done

echo "=== rename log ==="
if command -v read >/dev/null; then
  # print first 40 lines of the log via sed (avoids head)
  sed -n '1,40p' "$LOGS"
fi