# @flock/strategy

Flock strategy tier — estate-scripts-router's routing strategies (v3.2) ported to
Bun/TypeScript. Decides **which** provider/model serves a request and executes
the call with fail-fast hedging. Sits above the policy tier (`../policy`:
Elo, circuits, health analytics) and below the serving layer.

## Layout

| File | Ports | What it is |
|---|---|---|
| `types.ts` | `router_types.ts` | `StrategyDeps` interface — replaces the global `state` singleton; `RouteResult`, `ChatBody`, `ProviderView`, `StrategyFn` |
| `catalog.ts` | `router_config.ts` | Roost-backed catalog helpers: `ProviderView` projection, key resolution, `normalizeModelSpec` (openfang `provider:model` shim), `modelFree` (live-metadata free eligibility), `CODING` aliases, `LOCAL_ROLES`, timing constants |
| `governor.ts` | `router_matrix.ts` (Governor) | Model-pressure governor (AIMD): admission permits, exhaustion backoff, write-behind snapshot persistence |
| `nvidia-keys.ts` | `router_matrix.ts` (`nextNvidiaKey`) | NVIDIA multi-key rotation — token bucket, 40 rpm/key, honest 429 when dry |
| `deps.ts` | `RouterState`/`Matrix` composition | `PolicyBackedDeps` — composes `EloEngine` + `CircuitPolicy` + `PolicyHealthDB` + Roost `ModelCatalog` + `Governor` into `StrategyDeps` |
| `strategy.ts` | `router_strategy.ts` | `callOne` + all route strategies + `bindStrategies` |
| `ui-data.ts` | `router_ui.ts` | `uiData(deps)` payload + `FLOCK_UI_HTML` legacy /ui embed contract |

## Behavioral details preserved

- **callOne**: entitlement-404 fail-fast guard → circuit guard → headers
  (`Estate-Flock/3.1` UA, openrouter referer/title, nvidia pool rotation
  with 429 when buckets are dry) → governor admission → AbortSignal
  fail-fast stack (CONNECT_MS headers budget, TTFT_MS first-chunk budget
  for streams, ATTEMPT_MS total cap) → hedged_loser → 499 with **no**
  circuit strike → worker-exhaustion checked **before** generic failure
  handling (model-scoped, never cools the lane) → stream first-chunk
  re-emit → Gemini ledger `recordUsage` (best-effort).
- **Race doctrine**: first-substantive-wins; losers abort cleanly; empty
  completions are never winners — they feed the flap tracker.
- **herd bonus lane**: always races when healthy, appended after the
  n-cut so no caller can slice it off.
- **LONGCTX pin**: est-token gate (>200k) → direct call to the KEYED
  `nvidia/nemotron-3-super-120b-a12b` lane, outside the race; 10/day cap
  (every attempt burns credits, logged under `strategy='longctx-pinned'`);
  circuit checked first; `ESTATE_LONGCTX_PIN=0` kills it.
- **routeFree**: live-metadata free pool (never a static list), ling-first,
  local roles always join at zero cost.

## Port notes (deliberate deviations)

- Strategies take `StrategyDeps` first; `bindStrategies(deps)` restores the
  classic `ROUTERS` ergonomics (`(body, session) => Promise<RouteResult>`).
- `routeCascade` sorts by `candidateScore` (elo − latencyEMA/50) instead of
  raw elo — same ordering signal, latency-aware.
- `liveMeta()` returns `{}` until Roost discovery records per-model pricing
  metadata; `modelFree` falls back deterministically to the `:free` suffix
  convention, so a missing discovery refresh never empties the pool.
- The Rust proxy's `governor.rs` owns the hot path; `governor.ts` is the
  portable TS equivalent for standalone TS serving layers and tests.
- The primary dashboard is the separate `flock/dashboard` Bun app;
  `ui-data.ts` keeps the portable /ui data + HTML contract.

## Use

```ts
import { createDeps, bindStrategies } from "@flock/strategy";

const deps = createDeps(); // db path, governor path from defaults
const routers = bindStrategies(deps);
const r = await routers[process.env.ESTATE_STRATEGY ?? "hybrid"]!(
  { model: "free", messages: [{ role: "user", content: "hi" }] },
  "session-id",
);
```

```sh
bun test        # regression suite
bun x tsc --noEmit -p tsconfig.json
```
