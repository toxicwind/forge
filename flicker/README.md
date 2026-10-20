# Flicker

> Part of [**the ranch**](https://github.com/toxicwind/ranch) — the whole inference estate, one map.

Flicker is the estate's local-only build daemon: a Woodpecker v3 Go fork stripped down to direct job execution with content-hash caching. It replaced the old Python `buildsrv` daemon (briefly and mistakenly renamed "brand" on 2026-09-30 — that name is gone) on the same port, as a drop-in replacement.

No containers, no remote forges, no auth — single-tenant daemon that runs jobs through bash login shells (so mise toolchains resolve) and returns `CACHED` when an identical job spec was already run.

## Quick start

```bash
# Health
curl -fsS http://127.0.0.1:25148/api/health

# Submit a job
curl -s -X POST http://127.0.0.1:25148/api/jobs \
  -H "Content-Type: application/json" \
  -d {'"name":"hello","command":"echo hello","workdir":"/tmp","timeout":300}'}

# Or use the CLI
flicker submit --name hello -- 'echo hello'
flicker status 1
flicker logs 1
```

## API

| Method | Path | What |
|---|---|---|
| GET | `/api/health` | Service health + cache stats |
| POST | `/api/jobs` | Submit a job (`name`, `command`/`script`, `workdir`, `env`, `timeout`, `cache_key`, `artifacts`) |
| GET | `/api/jobs` | List jobs |
| GET | `/api/jobs/:id` | Job status (`pending`/`running`/`success`/`failure`/`canceled`/`error`) |
| GET | `/api/jobs/:id/logs` | Plain-text job logs |

Identical job specs (command, workdir, sorted env, cache key, sorted artifacts) hash to the same content key — resubmits return the cached success immediately.

## Layout

- `ranch/flicker/` — this source (Woodpecker v3 fork, `flicker/bin/` holds committed binaries)
- `/home/toxic/.local/bin/flicker` — the CLI
- `/home/toxic/flicker/` — state on yote
- Ports: `:25148` HTTP API, `:25240` gRPC

Pitchfork supervises `estate-scripts/flicker` (server) and `estate-scripts/flicker-agent` (local execution agent).

## History

- `buildsrv`: original stdlib-Python daemon (`buildsrvd.py`), port 25148.
- 2026-09-30 00:05: renamed to `brand` (bad name, acknowledged).
- 2026-09-30 01:54: deleted from the tree in an unrelated commit.
- Same night: Flicker (this fork) cut over as the live replacement. All `brand`/`branding` folders removed 2026-10-02.
