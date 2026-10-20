<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![ranch](https://img.shields.io/badge/ranch-forge-black?style=for-the-badge)](https://github.com/toxicwind/ranch)
[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=for-the-badge&logo=go&logoColor=white)](https://go.dev)
[![Rust](https://img.shields.io/badge/Rust-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org)
[![REAPI](https://img.shields.io/badge/REAPI-cache-4C1?style=for-the-badge)](https://github.com/nativelink/nativelink)
[![port](https://img.shields.io/badge/port-25148-8F2?style=for-the-badge)](http://127.0.0.1:25148)

</div>

# ⚒️ forge

**The estate's build daemon + REAPI remote-execution layer.** Forge is the one
builder the ranch routes through: it *caches and executes* builds (Bazel/REAPI
at `:25155`, mise task cache at `:25148`), *deploys* the sites, and *borrows
prior art* for the hard problems. Forge pairs with **weave** (entity-level git
merge driver, upstream of the build) and **flatbread** (the content graph the
agents and sites read) — weave resolves edits, forge caches the build,
flatbread feeds the source.

```
agents edit (weave-aware git) → clean merges → CI hits forge (:25155) → cache/build
```

## 🧩 What it wraps

| Piece | Where | Port | Role |
|---|---|---|---|
| **NativeLink (REAPI)** | `barn/nativelink` | `:25155` / `:25157` | Remote Execution API + CAS — the remote build cache/executor. Docs: `barn/nativelink/web` (fumadocs `docs/weave.mdx`). |
| **forge build daemon** (`forge-server`) | `pitchfork estate/forge` + `estate/forge-agent` | `:25148` HTTP / `:25240` gRPC | The woodpecker-CI fork: job queue, content-hash cache, health. `POST /api/jobs`. |
| **woodpecker source** | `forge/woodpecker/` | — | The CI engine we fork for the daemon (`go.woodpecker-ci.org/woodpecker/v3`). |
| **pattern-borrow** | `scripts/pattern-borrow.ts` | — | Borrow a proven pattern before solving. |
| **emergent (research)** | `emergent/` | — | Paper-finder + prior-art ingestion. |
| **weave** (sibling) | `barn/weave` | — | Entity-level git merge driver, upstream of forge. |
| **flatbread** (sibling) | `barn/flatbread` | — | Content graph for agents and sites. |

## 🚀 Quick start

```bash
# Cached buid via nativelink REAPI (bazel)
bazel build --remote_cache=grpc://127.0.0.1:25155 //...

# Cacheable task via the forge daemon (mbx client on :25148)
mise run <task>          # declared sources/outputs -> cached
mise exec -- <cmd>       # ad-hoc; mise toolchain resolves

# Live job queue
curl http://127.0.0.1:25148/api/jobs
curl http://127.0.0.1:25148/api/health   # {"ok":true,...}

# Borrow prior art
bun emergent/paper-borrow.ts query "content-hash caching for CI job objects"
```

## 🔁 Deploy model (forge-native)

A repo gets forge-native deploys with **push → build → rollout**, no external
CI and no container-console middlemen (see `forge/woodpecker/DEPLOY.md`):

1. **Event-driven, never polling.** GitHub pushes reach a webhook receiver that
   verifies `X-Hub-Signature-256` and submits the build job (async; GitHub
   times out deliveries at ~10s).
2. **Build where it runs.** The job queue, build cache, and deploy target are
   the same box (`yote`, 16 cores). No runner egress, no registry round-trip.
3. **Content-hash caching.** Forge hashes `(name + command)`; an identical
   resubmit returns `CACHED` without re-executing.
4. **Health-gated rollout, automatic rollback.** New artifact must pass health
   checks before `.live`; the prior `.live` stays as `.previous`; a failed
   rollout restores the old image by itself.
5. **Secrets stay on the box.** Webhook HMAC keys live in `/home/toxic/.secrets/`
   (0600) — never in a repo, never in a third-party store.

The five deploy pieces: webhook receiver (`hook.ts`), build script
(`build.sh`, repo idiom), rollout script (`rollout.sh`), the compose `Dockerfile`s,
and `DEPLOY.md` as the record.

## 🧱 Stack

- **Go** — the woodpecker-CI fork daemon + agent (Rust `nativelink` for REAPI)
- **Bun + TypeScript** — webhook receivers, pattern-borrow, paper-borrow
- **Nix / mise** — flake + mise toolchains, pinning the compiler set

## 🏗️ Live daemons

```bash
estate/forge          running   :25148 HTTP  (forge-server)
estate/forge-agent    running   :25240 gRPC  (forge-agent)
```

> Note: the running binary's internal `service` string still reads `flicker`;
> it will report `forge` after the next build from the swept `forge/woodpecker/`
> source.