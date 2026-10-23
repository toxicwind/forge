# Forge Release Lane

First-class GitHub release drop-in for the forge estate build lane.

## What this is

A native release lane that turns a forge-cache-verified artifact into a
GitHub Release with upload, using the estate `delend-*` primitive (`gh` via
`delend-gh`'s underlying `gh` CLI). No GitHub Actions CI required — the build
happens through the forge-native path (nativelink REAPI `:25155` → mise/mbx
cache `:25148`) and this lane publishes the result.

## Why native beats GA CI for the Linux CLI

- **No extra infra cost.** GA minutes burn credits; the forge lane runs
  entirely on the estate box.
- **Forge cache first.** `mise run kappa-build` (or any `mise run <task>`)
  routes through nativelink REAPI and gets cache hits — identical to the
  woodpecker forge daemon's pipeline.
- **Single source of truth.** The same artifact that passes forge health checks
  gets released; no second build on GA runners.
- **Org-agnostic.** `gh` resolves arbitrary `org/repo` — never hard-coded to
  `toxicwind/*`.

## Honest boundary

| What this lane covers                                | What still needs GA (or equivalent)                  |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Linux CLI binary (forge build + `gh release upload`) | Cross-platform smoke tests (macOS/Windows)           |
| Draft or published releases, per-project             | Windows EV code-signing (requires Windows runner)    |
| Idempotent — `--clobber` tolerates existing tags     | Multi-target marketplace publishing (npm, pip, etc.) |
| Artifact upload (single file, configurable)          | Multi-asset releases (pre-releases, changelog body)  |

For the above boundaries, run the GA publish workflow _after_ the forge lane
succeeds, or stand up a self-hosted runner lane.

## How to release

### Prerequisites

- `gh` CLI authenticated (`gh auth status` → logged in)
- Forge-native build available (`mise run kappa-build` or equivalent)
- Working directory: a repo with the built artifact

### One-shot release

```bash
# Build the artifact via forge cache (nativelink)
mise run kappa-build   # or: mise run <task-name>

# Create draft release + upload
forge-release --repo toxicwind/kappa-code \
              --artifact dist/@kappacode/kappa/bin/kappa \
              --tag v0.1.0 \
              --draft
```

### Published release (non-draft)

```bash
forge-release --repo toxicwind/kappa-code \
              --artifact dist/@kappacode/kappa/bin/kappa \
              --tag v0.1.0
```

### Clobber (re-create if tag exists)

```bash
forge-release --repo toxicwind/kappa-code \
              --artifact dist/@kappacode/kappa/bin/kappa \
              --tag v0.1.0 \
              --clobber
```

### Dry-run (no network calls)

```bash
forge-release --repo toxicwind/kappa-code \
              --artifact dist/@kappacode/kappa/bin/kappa \
              --tag v0.1.0 \
              --dry-run
```

### Custom release notes

```bash
forge-release --repo toxicwind/kappa-code \
              --artifact dist/@kappacode/kappa/bin/kappa \
              --tag v0.1.0 \
              --notes "## What's new\n- Added release lane"
```

## How it works

```
1. Parse args (repo, artifact, tag, --draft/--clobber/--dry-run/--notes)
2. Validate: gh auth? artifact exists? repo resolves?
3. If --clobber and tag exists: delete it (gh release delete)
4. Create release: gh release create <tag> --title <tag> [--draft] [--notes ...]
5. Upload artifact: gh release upload <tag> <artifact>
6. Print summary URL
```

All `gh` calls go through the estate-standard `gh` binary (not `ghq` or
`delend-gh` — `delend-gh` is a git-primitive, not a release tool).

## The rig

See `rig.json` — declares the release-lane as a dispatchable A2A unit that
other agents (kappa, tau, delend-quick workflows) can invoke.
