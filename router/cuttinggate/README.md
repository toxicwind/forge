# cuttinggate

*The canonical live router for the estate: one OpenAI-compatible endpoint fans requests across cloud providers and local inference with strategy-based failover, circuit breakers, and sticky sessions.*

![ranch](https://img.shields.io/badge/toxicwind-ranch-blue?style=for-the-badge) ![mesh](https://img.shields.io/badge/mesh-cuttinggate-purple?style=for-the-badge) ![bun](https://img.shields.io/badge/bun-black?style=for-the-badge) ![port 25200](https://img.shields.io/badge/port-25200-green?style=for-the-badge)

## Why this exists

Every model an agent can think with should be one request away. cuttinggate is that one request: **strategy names — not model names — decide where traffic goes**, so clients never rewire when providers change. It superseded the estate-scripts-router on `:25104` (still serving — pitchfork `auto = ["start"]`, verified 2026-10-02) and absorbed the flock-proxy role (`:25193`, live again 2026-10-04, key-gated).

- **Strategy-based routing** — `hybrid` (default: sticky → ast_race → circuit_chain), `free`, `ast_race`, `sticky_affinity`, `weighted_elo`, `circuit_chain`, `fifo_matrix`.
- **Zero-cost by default** — the `free` strategy races local herd inference against every `:free` cloud model; cost-sensitive agents never touch a paid endpoint by accident.
- **Self-healing** — per-provider circuit breakers (open/half-open), key pools with 429 rotation, quarantine for poisoned upstreams.
- **Observable** — pino JSON logs, `/health`, `/v1/models`, and a token/cost ledger.

## Quick Start

```bash
curl -sf http://127.0.0.1:25200/health      # router health
curl -sf http://127.0.0.1:25200/v1/models   # model list
curl -H "X-Estate-Strategy: free" http://127.0.0.1:25200/v1/chat/completions
```

Run it: `bun run src/server.ts` — port via `CUTTINGGATE_PORT`; the code default is `:25194` (`src/config.ts`, which collides with ralph-dashboard) and `:25200` comes from the pitchfork stanza in `pitchfork.d/`. Bun ≥ 1.4.0.

## Layout

```text
src/
  server.ts       HTTP entry (Elysia)
  router/         strategy engine: decision, governor, strategy selection
  strategy/       vendored estate-scripts-router TS strategy layer (router_*.ts)
  catalog.ts      provider catalog, generated from mesh/catalog
  keypool.ts      key-pool client (talks to mesh/keypool)
  circuit.ts      circuit breakers
  quarantine.ts   poisoned-upstream quarantine
  ledger.ts       token/cost accounting
  auth/           tokens, users
config/           router config
tests/            bun test suite (`bun test`)
```

## Where it sits

Part of the [mesh](../../README.md) routing plane at `ranch/mesh/proxy/cuttinggate/`. It superseded `:25104` (estate-scripts-router, still serving) and absorbed the `:25193` flock-proxy role (live again 2026-10-04, key-gated). Herd (`:25100`) is its local-inference leg when up.


## Providers: OpenCode Zen free tier

The `zen` provider (`https://opencode.ai/zen/v1`) serves OpenCode Zen's
zero-cost models as first-class cuttinggate routes. Zen's free tier is gated
on request *shape*, not app attestation — upstream answers `403
FreeTierError` unless the request looks like the OpenCode CLI. cuttinggate
applies the full shape per request (`src/zen.ts`, via `Router.call`):

- `User-Agent: opencode/1.18.x` (semver ≥ 1.18.0), `x-opencode-client: cli`,
  `x-opencode-project: global`
- `x-opencode-session`: `ses_` + 26 chars (12 hex ts + 14 base62), stable per
  process for prompt-cache affinity
- `x-opencode-request`: `msg_` + 26 chars, fresh per call
- body: `stream: true` (hard gate) plus the `bash`/`glob`/`grep`/`read` tool
  definitions — a body omitting `glob`/`grep` is rejected; `tool_choice:
  none` when the caller declared no tools
- the SSE stream is folded back into one JSON completion (non-content frames
  such as `inference-cost` are stripped) so the race engine's contract holds

Auth: `ZEN_API_KEY`, or `OPENCODE_API_KEY` (mirrors estate-scripts-router-ts).
The provider is also registered in the mesh catalog
(`mesh/catalog/src/data.ts`, adapter `openai`), so generated artifacts
(`providers.json`/`.go`/`.rs`, `tau-models.yml`) carry it. The vendored
strategy layer (`src/strategy/router_strategy.ts`) applies the same
client-identity headers and body gate as `src/zen.ts` for requests routed
through the strategy engine.
The 17-model seed in `src/zen.ts` is always registered at boot, so the set
below stays routable even when the live catalog lags an upstream rotation.

### Verified model table (2026-10-04, live completions)

| model | zen `/v1/models` label | completion | latency |
|---|---|---|---|
| ling-3.1-flash-free | listed | serves | 1.6s |
| fledge-alpha-free | listed | serves | 0.5s |
| mimo-v2.5-free | listed | serves | 0.5s |
| mimo-v2.6-flash-free | listed | serves | 1.6s |
| nemotron-3.5-lightning-free | listed | serves | 0.3s |
| nemotron-3-ultra-free | listed | serves | 2.4s |
| longcat-2.5-preview-free | listed | serves | 0.3s |
| deepseek-v4-flash-free | listed | serves | 0.1s |
| qwen3.6-plus-free | delisted, still serves | serves | 0.1s |
| minimax-m3-free | delisted, still serves | serves | 1.7s |
| north-mini-code-free | delisted, still serves | serves | 0.3s |
| big-pickle | delisted, still serves | serves | 0.1s |
| jev-1.13-free | listed | serves | 0.1s |
| muse-spark-1.2-contributor-free | listed | serves | 0.1s |
| muse-spark-1.3-contributor-free | listed | serves | 0.1s |
| space-bunny-free | listed | serves | 0.1s |
| ling-3.0-flash-fin-free | listed (new 2026-10-04) | 404 upstream on re-probe 2026-10-04 ~04:27Z (delisted) | — |

**Re-probe 2026-10-04 ~04:27Z** (direct `https://opencode.ai/zen/v1/chat/completions`, authenticated, tool-signature bundle, 86-model sweep): 8 of the 17 answer with the requested model — mimo-v2.6-flash-free, nemotron-3-ultra-free, space-bunny-free, mimo-v2.5-free, fledge-alpha-free, big-pickle, longcat-2.5-preview-free, nemotron-3.5-lightning-free (reasoning models need a real `max_tokens` budget; a 30-token probe burns it on chain-of-thought). deepseek-v4-flash-free, qwen3.6-plus-free, minimax-m3-free, north-mini-code-free, jev-1.13-free and muse-spark-1.2/1.3-contributor-free return 400; ling-3.1-flash-free returns 403; ling-3.0-flash-fin-free returns 404. Through `:25104` strategy-auto degrades these to a local fallback (`herd/beellama/exaone-4-0-1-2b`) with HTTP 200 — a 200 there does not prove the Zen model answered. Check the `routed-via` SSE comment before trusting a completion. Full per-model results: `/home/toxic/zen-sweep-results.json` on yote (86 models, authenticated).

### Community projects taking zen further

- denysvitali/llm-proxy — the fullest free-tier gate recipe (ID shape,
  stream gate, tool injection, SSE fold-back); also serves the OpenCode Go
  tier at `/zen/go/v1`
- warexpor/opencode-zen-gateway — UA semver floor, stable session per key,
  inference-cost stripping; notes the free tier is IP-day limited (after
  `FreeUsageLimitError`, wait until UTC midnight)
- aslamplr/turnpike — per-family endpoint split: DeepSeek/GLM/Kimi/LongCat
  on chat-completions, MiniMax/Qwen on `/messages`, GPT/Grok on `/responses`
- nexusrun/nexus_aigateway — session-header forwarding for the Go tier
- blaspat/opencode-tk-proxy — header-injecting proxy for the Go tier
- (earlier set documented in `mesh/router/estate-scripts-router/README.md`:
  parithosh-varma/opencode-proxy, dinhkarate/opencode-zen-free-proxy,
  markdev11/oc-proxy, JulienMaille/opencode-free-proxy,
  vyn-7/opencode-bypass, parithosh-varma/zen-proxy)

## Dev / contributing

Changes land as commits in the [toxicwind/ranch](https://github.com/toxicwind/ranch) repo (`mesh/proxy/cuttinggate/`). `bun run check` (typecheck + tests) before pushing. Keys live in 0600 files under `/home/toxic/` — never in this repo, never in logs.