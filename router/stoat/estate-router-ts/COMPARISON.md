> **Historical note (2026-10-02).** This comparison was written 2026-09-17, before the mesh consolidation — paths and "live" claims below describe the estate as it was then. The estate-scripts-router (`:25104`) was retired 2026-10-02 and replaced by cuttinggate (`:25200`, `mesh/proxy/cuttinggate/`); the router code now lives at `mesh/router/estate-scripts-router/`. Preserved unchanged for the record.

# Router comparison — all forms (2026-09-17)

Live router: `tools/estate-scripts-router/estate-scripts-router-ts/` on `:25104`.

## The forms

Three separate implementations have carried similar routing DNA:

1. **estate-scripts-router-ts** (Bun/TypeScript) — the **live production router**,
   pitchfork daemon on `:25104`. Live provider `/models` discovery, 7
   strategies, streaming, sticky sessions, ELO, circuits, HealthDB, free
   racing, `/ui` dashboard.
2. **Go cloud-router module** (`projects/herd/internal/flock/`) — a
   llama-swap library module, not a version of #1. 13 providers,
   per-provider rate limits, request coalescing, least-latency and
   round-robin strategies, richer status surface. No live discovery, no
   streaming-first design.
3. **Mesh gateway cloud-router** (`projects/range/ranch/barn/shep/flock.go`) —
   routes tool-call/MCP traffic, a different domain entirely (not model
   inference).

Stale copies of the TS tree exist at `projects/range/ranch/stockyard/router-legacy/`,
`projects/herd/mesh/router/`, and a nested duplicate
`estate-scripts-router-ts/estate-scripts-router-ts/` — the live daemon runs from
`tools/estate-scripts-router/estate-scripts-router-ts/` only. The old TS User-Agent
and `[matrix]` log prefix were renamed to `Estate-Router/3.1` /
`[router]`; nothing of the old branding carries into the consolidated
router.

## Side by side

| | estate-scripts-router-ts (LIVE) | Go module |
|---|---|---|
| Location | `tools/estate-scripts-router/estate-scripts-router-ts/` | `projects/herd/internal/flock/` |
| Status | **Production** — pitchfork daemon `:25104` | Library, compiled into herd llama-swap builds |
| Providers | 7: llama-swap (herd main port `:25100`), openrouter, nvidia (direct multi-key), groq, cerebras, google, mistral | 13: llama-swap, openrouter, nvidia, groq, together, cerebras, fireworks, hyperbolic, github, mistral, openai, perplexity, siliconflow |
| Strategies | 7 canonical: fifo_matrix, free, sticky_affinity, weighted_elo, circuit_chain, hybrid, flock_race (`fifo_flock` / `flock_race` aliases live; legacy `ast_race` / `fifo_matrix` still accepted) | 8: hybrid, flock_race (alias `ast_race`), sticky_affinity, weighted_elo, least_latency, round_robin, free, circuit_chain |
| Model discovery | **Live** — `GET {base}/models` per key at startup + every 30 min; union with curated | YAML-configured static lists |
| Health | SQLite WAL HealthDB, EMA latency, ELO, circuit breakers, sticky sessions | SQLite health DB, EMA latency, circuit breakers w/ half-open probes, sticky sessions |
| Rate limiting | NVIDIA multi-key token buckets (40 rpm/key, round-robin) | Per-provider token buckets (all providers) |
| Extra | SSE streaming, `/ui` dashboard, flap tracker, Prometheus `/metrics`, optional client-key auth | Request coalescing, latency histograms, richer status/metrics |

## Full form inventory (all flock/astmatrix forms, 2026-09-17)

Everything that has ever carried the astmatrix/flock routing DNA, with its
canonical status. The old name "astmatrix" no longer makes sense: the thing
is a *flock* of providers raced/managed together, so every active surface is
renamed. Archives and frozen snapshots are documented, not renamed.

| # | Form | Location | Kind | Status |
|---|---|---|---|---|
| 1 | estate-scripts-router-ts | `tools/estate-scripts-router/estate-scripts-router-ts/` | Bun/TS multi-provider model router | **LIVE** - pitchfork daemon `estate-scripts-router` on `:25104` |
| 2 | flock (proxy) | `/home/toxic/projects/flock`, daemon `/home/toxic/.flock/flock` on `:8000` | Rust NVIDIA NIM OpenAI-compatible proxy | **LIVE** - separate repo; NIM-side consolidation owned by main chat |
| 3 | Go flock module | `projects/herd/internal/flock/` | llama-swap library module (13 providers) | Active source; NOT the running `:25100` binary (built 2026-09-12 from an incomplete tree) |
| 4 | mesh gateway router | `projects/range/ranch/barn/shep/flock.go`, `projects/herd/mesh/gateway/flock.go` | Go MCP/tool-call router | Reference copies; live `:25115` is the Bun mesh-hub |
| 5 | flock-py | `projects/range/ranch/stockyard/router-legacy/flock-py/`, `projects/herd/mesh/router/flock-py/` | Python reference router | Frozen reference |
| 6 | flock-router | `projects/range/ranch/stockyard/router-legacy/flock-router/` | TS reference router | Frozen reference |
| 7 | flock-pkg | `projects/range/flock-pkg/`, `projects/herd/mesh/flock-pkg/` | Semantic/AST extraction snapshots | Frozen snapshots (not request routers) |
| 8 | tau archive | `projects/tau/archive/from-estate-scripts-swap/internal/astmatrix` | Old Go copy | **Frozen archive - do not edit** |
| 9 | tau-flock extension | `projects/tau/extensions/flock/` (`@toxicwind/tau-flock`) | Tau extension: flock client + slash commands + LLM tools | **LIVE-registered** - linked in `~/.tau/plugins`, `plugin list` shows it |
| 10 | stray NIM implementations | various | NVIDIA NIM clients | Owned by main chat - out of this lane |

Canonicality: exactly two live daemons (form 1 on `:25104`, form 2 on `:8000`).
One active library source (form 3). One live-registered Tau extension (form 9).
Everything else is reference, snapshot, or frozen archive.

## Consolidation changes (this tree, 2026-09-17)

- **Live discovery authoritative**: `/v1/models` returns 779 unique servable
  IDs (was ~50 aliases); every provider-keyed model is directly addressable —
  no more curated-alias-only routing.
- **NVIDIA direct multi-key**: 4 keys, round-robin, 40-rpm token buckets per
  key. The old `flock` daemon (`:8000`, still running) is bypassed for NVIDIA
  by the router; other consumers unaudited so far.
- **Flap tracker**: 3 empty completions in 10 min benches a model from the
  free pool; strikes decay and re-probe. Visible at `/metrics`
  (`estate_router_model_empty_strikes`). Already striking flapping Ling
  variants on openrouter and llama-swap paths.
- **Substance guard on every path**: HTTP 200 with empty content (and no
  tool_calls) is a failure at every routing layer — never served, never
  sticky-pinned. Closed the circuit-chain/free fallback hole that served
  blank 200s.
- **`/v1/models` metadata**: provider, source (curated/live), free flag, ELO,
  circuit state, empty-strike count, plus raw provider objects where live.
- **Operational**: Prometheus `/metrics`, optional `ESTATE_CLIENT_KEYS`
  auth, neutral naming (UA `Estate-Router/3.1`, `[router]` logs).
- **Local path preserved**: llama-swap provider routes through the herd main
  port `:25100`; the router has not bypassed it.

- **Strategy names flock-aligned** (2026-09-17): `ast_race` -> `flock_race`,
  `fifo_matrix` keeps working with new alias `fifo_flock`. Additive only:
  legacy names still accepted (switch cases match both, ROUTERS map holds
  both keys). Proven live: `X-Estate-Strategy: flock_race` returned a
  non-empty completion through the restarted `:25104` daemon. Go module
  default strategy is now `flock_race`; yaml accepts `flockStrategy` with
  legacy `astStrategy` still honored via custom UnmarshalYAML.

- **Free pool is live-metadata derived** (2026-09-17, the Architect): `freeCandidates()`
  no longer enumerates a static `:free`-suffix list. Eligibility is
  `modelFree(p, mid)` — live `/models` pricing wins (OpenRouter prompt +
  completion priced `"0"` = free), with deterministic fallback to the `:free`
  suffix convention only when a provider exposes no pricing metadata at all.
  Filters: circuit state, flap strikes (substance-guard failures feed the
  strike counter), local llama-swap roles always join. `/v1/models`
  `x-estate.free` is the same function, so the catalog and the router
  agree. 4 live-free models the static list missed (`stealth/union-alpha`,
  `google/lyria-3-pro-preview`, `google/lyria-3-clip-preview`,
  `openrouter/free`) now race in the free pool.

## Spec limits (live tree, 2026-09-17)

| Limit | Value | Where |
|---|---|---|
| Free-pool race width | `MAX_PARALLEL = 4` | `router_config.ts` |
| Flap bench | 3 empty strikes in 600 s (`FLAP_STRIKES`/`FLAP_WINDOW_S`) | `router_matrix.ts` |
| Live discovery refresh | every 30 min + non-blocking at startup; 15 s fetch timeout | `router_live_models.ts` |
| Race timeout | 95 s gather-then-pick | `router_strategy.ts` |
| Provider call timeout | 120 s non-stream, 180 s stream | `router_strategy.ts` |
| NVIDIA direct | 4 keys round-robin, 40 rpm token bucket per key | `router_matrix.ts` |
| FIFO queue depth | `FIFO_MAX = 64` | `router_config.ts` |
| Sticky TTL | `STICKY_TTL = 1800` s | `router_config.ts` |
| Circuit open hold | 60 s, then half-open probe | `router_matrix.ts` |

## Remaining gaps (honest)

- TS router lacks 6 Go-module providers: together, fireworks, hyperbolic,
  github, openai, perplexity, siliconflow. Go module lacks google (Gemini).
- TS router has no request coalescing and no least-latency / round-robin
  strategies; per-provider rate limits exist only for NVIDIA.
- Flap strikes are in-memory (lost on restart); no echo/junk scoring yet.
- NVIDIA bucket exhaustion falls back to the default key instead of
  queueing; `/models` discovery uses only the first key.
- `/v1/models` deduplicates by model id, hiding multi-provider routes.

## Live discovery numbers (2026-09-17)

| Provider | Curated | Live | Union served |
|---|---|---|---|
| llama-swap | 3 | 102 | 102 |
| openrouter | 11 | 444 | 451 |
| nvidia | 12 | 82 | 92 |
| groq | 6 | 13 | 17 |
| cerebras | 0 | 2 | 2 |
| google | 4 | 59 | 60 |
| mistral | 4 | 46 | 47 |

`cerebras` was hardcoded to **zero** models before live discovery.

## Estate auto/bodybuilder vs official OpenRouter routers (2026-10-01)

Official docs read 2026-10-01:

- Auto Router: https://openrouter.ai/docs/guides/routing/routers/auto-router
- Body Builder: https://openrouter.ai/docs/guides/routing/routers/body-builder

### Auto Router

Official `openrouter/auto`: "automatically selects the best model for your prompt" —
powered by the market (aggregate spend of millions of OpenRouter users over a
trailing 7-day window per task type, ~30 fine-grained task types), cost tiers
low/medium/high/xhigh/max, session stickiness, no additional fee. The response
`model` field shows which model was actually used.

Estate `routeAuto` (default STRATEGY since a005d6f22): prompt-aware per-request
switching — AST race for code-shaped traffic, free race as the default path,
hybrid fallback when the free pool is empty. 2M/1M context pins run before
strategy dispatch. Per-request `X-Estate-Strategy` override; `X-Strategy`
and `X-Routed-Via` response headers show the chosen lane.

Differences: official routes on market spend-share with session stickiness
(stickiness is a separate estate strategy, `sticky_affinity`); estate routes on
prompt shape + cost (free-first) across its own keyed providers, no market
signal, no per-request cost tier.

### Body Builder

Official `openrouter/bodybuilder`: "transforms natural language prompts into
structured OpenRouter API requests, enabling you to easily run the same task
across multiple models in parallel." Free to use; returns a JSON object
containing an array of ready-to-execute request bodies; the caller executes
them in parallel.

Estate `POST /v1/bodybuilder` (`buildBodybuilderRequests`): same split —
generation is the router's job, execution stays with the caller. Decomposition
itself runs on the free race, so generation costs nothing. Returns
`{requests:[...]}`, 1-16 self-contained bodies, JSON only. Verified live
2026-10-01: 2 generated bodies submitted through `/v1/chat/completions` ->
HTTP 200, `X-Strategy: auto`.

Differences: official bodybuilder is a hosted model with access to all OpenRouter
models and model-alias resolution ("Claude Sonnet" -> `anthropic/claude-sonnet-4.5`);
estate's decomposes with a system prompt on its own free race and emits the
model ids the decomposer chooses (observed: `openai/gpt-4o`, which the
router then re-routed per its own logic).
