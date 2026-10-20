# Forge deploy pipelines

How a repo gets forge-native deploys: push → build → rollout, with no
external CI and no container-console middlemen. (Written 2026-09-30 for the
effusion cutover; the pattern is repo-agnostic.)

## Principles

- **Event-driven, never polling.** GitHub pushes arrive as webhooks, not as
  a poller asking "anything new?". A daemon that wakes on a timer to check
  for pushes is a bug.
- **Build where it runs.** yote has 16 cores; the job queue, the build cache,
  and the deploy target are the same box. No runner egress, no registry
  round-trip for images that never leave the building.
- **Content-hash caching.** Forge hashes the job (name + command); an
  identical resubmit returns `CACHED` without re-executing. Idempotent
  deploys fall out for free.
- **Health-gated rollout, automatic rollback.** The new artifact must answer
  health checks before it becomes `:live`. The previous `:live` is always
  kept as `:previous`. A failed rollout restores the old image by itself and
  says so in the fleet channel.
- **Secrets stay on the box.** Webhook HMAC secrets live in
  `/home/toxic/.secrets/` (0600), minted on yote, never in a repo, never in
  a third-party secret store.

## The standard shape

Every forge-native deploy has the same five pieces:

1. **Webhook receiver** (bun, stdlib only): verifies `X-Hub-Signature-256`,
   accepts `push` events to the deploy branch, submits the build job, returns
   200 immediately (GitHub times out deliveries at ~10s — the pipeline runs
   async). Pitchfork-supervised, bound to 127.0.0.1, reached from the public
   internet through a funnel path (`tailscale funnel --set-path`).
2. **Build script** (repo's own idiom): checks out the pushed SHA, runs the
   repo's canonical build, produces a local artifact (docker image, static
   dir, binary). Submitted as a forge job so caching and logs are uniform.
3. **Rollout script**: swaps the artifact in, runs health gates, promotes to
   `:live` or rolls back. Also a forge job.
4. **Funnel path**: one line in the public `MAP` in
   `estate-scripts/projects/yote/ops/funnel-map.sh`, applied with
   `sudo funnel-map.sh`, verified with `sudo funnel-map.sh --check`.
5. **GitHub webhook**: registered on the repo (events: push), secret = the
   yote-side HMAC secret.

## Forge job API (the deploy surface)

```
POST /api/jobs  {"name": "...", "command": "..."}  -> {id, number, status, hash, cached?}
GET  /api/jobs/{id}        -> status object
GET  /api/jobs/{id}/logs   -> streamed output
GET  /health               -> 200
```

Identical `name`+`command` resubmits return `{"cached": true, "message": "CACHED"}`.

## Per-repo layout

```
infra/forge/
  hook.ts            # webhook receiver
  build.sh           # build the artifact for $SHA
  rollout.sh         # health-gated rollout for $SHA (+ rollback)
  docker-compose.yml # the stack, local images only
  Dockerfile.*       # image definitions
DEPLOY.md            # the flow, secrets map, manual deploy, rollback, retirements
```

## Cutover checklist (retiring an old deploy flow)

1. New pipeline proven end-to-end on a real push (build green, rollout
   green, health checks passing, rollback exercised at least once by hand).
2. Old trigger disabled: webhook secrets deleted from GitHub, workflow
   deploy jobs removed or the workflow retired.
3. Old artifacts documented as superseded (registry images, console URLs).
4. `DEPLOY.md` records what was retired and why — never silently.
5. Fleet announcement with the cutover commit SHAs.

## Anti-patterns (retired 2026-09-30, do not rebuild)

- Building on someone else's runners then shipping the artifact back to your
  own box (GitHub Actions → GHCR → pull). The box can build it.
- Webhook URLs as deploy credentials (Portainer). A URL is not a secret
  store and a container console is not a deploy pipeline.
- Deploys with no health gate and no rollback path.
