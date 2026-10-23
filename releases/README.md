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

## Deploy lane (forge → pitchfork → healthck)

The release lane (`forge-release`) publishes to GitHub. The deploy lane
(`forge-deploy`) completes the estate doctrine pipeline: nativelink build →
binary stage → pitchfork daemon restart → health-check.

```bash
# Full deploy: build via nativelink, stage binary, restart daemon, health-check
forge-deploy --tag v0.15.0

# Skip the build step (binary already staged from a prior nativelink build)
forge-deploy --tag v0.15.0 --skip-build

# Dry-run: validate the entire pipeline without touching live daemons
forge-deploy --tag v0.15.0 --dry-run
```

**Lifecycle:**

1. **Build** — `mise run kappa-build` from the kappa-code repo (nativelink REAPI
   `:25155`, cache `:25148`). Skipped with `--skip-build`.
2. **Stage** — copies the ELF binary to `/home/toxic/.local/bin/kappa` via
   atomic rename (`staging → dest`). The pitchfork daemon (`kappa-serve.sh`)
   resolves `/home/toxic/.local/bin/kappa` → `serve --port 25159`.
3. **Restart** — `pitchfork restart estate/kappa-acp` adopts the new binary.
   The daemon reads the binary on each start.
4. **Health-check** — `curl http://127.0.0.1:25159/` confirms the service is
   accepting connections. If it fails, check `pitchfork logs estate/kappa-acp`.

**Honest GA boundary (deployment):** This lane deploys the Linux CLI binary only.
Cross-platform binaries (macOS ARM/x64, Windows), EV code-signing, and
multi-target marketplace publishing still need GA or self-hosted runners.
The release lane (`forge-release`) handles the GitHub publish; `forge-deploy`
handles the live estate swap. Use both in sequence for a complete deploy:

```bash
# 1. Build + release
mise run kappa-build
forge-release --repo toxicwind/kappa-code --artifact packages/cli/dist/@kappacode/cli-linux-x64/bin/kappa --tag v0.15.0

# 2. Deploy to live estate (from a separate session if the current one runs on kappa-acp)
forge-deploy --tag v0.15.0
```

**WARNING:** `forge-deploy` kills and restarts the live `estate/kappa-acp` daemon.
If your current session is running on that daemon (as is typical), DO NOT run
the non-dry-run version — it will terminate your own session. Validate with
`--dry-run` first, then execute the actual swap from a separate terminal or
session. The `--dry-run` mode prints every command it would execute without
running them.

## Forge-release dry-run result

```
$ forge-release --repo toxicwind/kappa-code \
    --artifact packages/cli/dist/@kappacode/cli-linux-x64/bin/kappa \
    --tag v0.15.0 --dry-run
[dry-run] check if release exists: gh release view v0.15.0 --json tagName
[release] creating release v0.15.0 on toxicwind/kappa-code
[dry-run] gh release create v0.15.0 --title v0.15.0 --notes Release v0.15.0
[release] uploading artifact: packages/cli/dist/@kappacode/cli-linux-x64/bin/kappa
[dry-run] gh release upload v0.15.0 packages/cli/dist/@kappacode/cli-linux-x64/bin/kappa
[release] published: [dry-run] would be https://github.com/toxicwind/kappa-code/releases/tag/v0.15.0
```

## Forge-deploy dry-run result

```
$ forge-deploy --tag v0.15.0 --dry-run
[deploy] repo: /home/toxic/pens/olympus/products/kappa/kappa-code
[deploy] tag: v0.15.0
[deploy] dry-run: true
[deploy] step 1: building via nativelink (mise run kappa-build)...
[dry-run] mise run kappa-build
[deploy] binary found: packages/cli/dist/@kappacode/cli-linux-x64/bin/kappa (284.7 MB)
[deploy] step 2: staging binary (atomic copy)...
[dry-run] cp .../kappa /home/toxic/.local/bin/kappa.deploy-staging
[dry-run] mv /home/toxic/.local/bin/kappa.deploy-staging /home/toxic/.local/bin/kappa
[deploy] step 3: restarting pitchfork daemon...
[dry-run] pitchfork restart estate/kappa-acp
[deploy] step 4: health-checking http://127.0.0.1:25159/...
[deploy] health-check PASS
[deploy] done: toxicwind/kappa-code@v0.15.0 → live
```

## Live daemon status (read-only, at time of this write)

- `pitchfork list` → `estate/kappa-acp` is in **errored** state (exit code 127).
- `curl http://127.0.0.1:25159/` → **connection refused** (no listener).
- The daemon is configured in `/home/toxic/estate/pitchfork.toml`:
  `run = "exec /home/toxic/estate/bin/kappa-serve.sh"`, ready on port 25159.
- **The live swap+restart is deferred** until the parent authorizes. Executing
  `pitchfork restart estate/kappa-acp` from this session would kill the running
  daemon and terminate THIS conversation. Use `--dry-run` to validate, then
  deploy from an external terminal or a separate session.
