# Stoat Router v3.2 — Resilient Multi-Provider LLM Router

> **STATUS: SUPERSEDED 2026-10-02, STILL RUNNING.** The :25104 port was marked
> retired (config/ports.env line 80; this directory's
> pitchfork.d/stoat.toml.retired-20261002), but the composing stanza
> `[daemons.stoat]` in estate/pitchfork.toml still sets
> auto = ["start"]: `bun router.ts` is bound to :25104 and /health answers 200
> (verified 2026-10-02). cuttinggate on :25200 is canonical.
> This doc describes the router as it last ran. Code retained here for
> reference at ranch/mesh/router/stoat/stoat-ts.
> router_config.ts requires ESTATE_ROUTER_PORT (fallback ESTATE_PORT)
> if this code is ever revived.

OpenAI-compatible chat router on `http://127.0.0.1:25104`, supervised by
pitchfork (`estate/pitchfork.toml [daemons.stoat]`, `auto = ["start"]`). Bun/TypeScript single binary
(ranch/mesh/router/stoat/stoat-ts/).

## Architecture

```
client -> :25104/v1/chat/completions
            ├─ normalizeModelSpec()      # router-side Openfang-shim parsing
            ├─ routeHybrid()             # explicit -> hedgedChain(explicit+field)
            │                            # auto     -> sticky -> routeAstRace -> chain
            ├─ routeAstRace()            # first-substantive-wins parallel race
            ├─ hedgedChain()             # speculative hedging (HFT redundant feeds)
            ├─ routeCascade()            # FrugalGPT-style cheap→dear cascade
            └─ Matrix (router_matrix.ts) # Elo, circuits, quarantine, latency EMA
                └─ HealthDB (SQLite WAL) # requests, healing log, sticky sessions
```

**Providers (9):** `llama-swap` (local herd :25100, no auth), `kimi-auto`
(local shim :25105 → resolver's best Kimi, no auth), `nim-local` (local NIM
proxy :8000), `openrouter`, `nvidia` (multi-key rotation + per-key token
bucket), `groq`, `cerebras`, `google`, `mistral`.

**Strategies** (`ESTATE_STRATEGY`): `hybrid` (default), `ast_race`,
`circuit_chain`, `cascade`, `weighted`, `fifo`, `sticky`, `free`.

## v3.2 resilience features

- **Fail-fast ceilings**: `ESTATE_CONNECT_MS` (8s), `ESTATE_TTFT_MS`
  (45s), per-attempt totals. A hanging backend never holds a client hostage.
- **Exponential quarantine**: 3 consecutive failures → circuit opens with
  backoff `30s * 2^(level-1)` capped at 10 min. Successful requests reset.
- **Active re-probe**: open circuits are probed on backoff expiry
  (open → half → closed); `/status` shows `probe_in_s`.
- **Warm standby** (HFT): local providers get a 30s `/models` liveness ping
  via `state.recordProbe()` — strikes + circuit only, **no Elo inflation, no
  DB rows**. A dead local backend quarantines before user traffic hits it.
- **Hot key reload**: `POST /admin/reload` or `SIGHUP` reloads secret files
  without restart.
- **`/status`**: per-provider circuit detail, last error, Elo, live models,
  p50/p95 latency (SQLite, 30 min window), kimi-auto resolved model.
- **`X-Estate-Timings`**: every chat response ships
  `connect_ms / ttft_ms / total_ms` per-hop timings.

## HFT synthesis (the novel part)

the Architect's HFT doctrine (race redundant paths first-valid-wins, fail-fast
ceilings, push-not-poll, hot persistent connections, measure every hop,
fallback planned before primary) applied to LLM routing:

1. **Speculative hedging** (`hedgedChain`): the preferred lane gets a head
   start; if no winner within `ESTATE_HEDGE_MS` (1500ms), the whole
   remaining field races in parallel. First substantive wins; losers are
   aborted and their aborts are **not** circuit strikes. A lane that fails
   fast immediately triggers the next lane. Providers with recent strikes
   lose the lane-0 head start (they still race at the hedge).
2. **First-substantive-wins race** (`routeAstRace`): previously waited for
   *all* lanes (`allSettled`) — the slowest lane set the pace. Now the first
   substantive finisher wins; code-shaped (`isAst`) output keeps priority
   via a 250ms quality window.
3. **Latency-aware ordering**: per-provider latency EMA (α=0.2) feeds
   `candidateScore() = Elo − EMA_ms/50`. Chronic slowness demotes a provider
   even with higher Elo; a single outlier cannot decide alone.
4. **Push-not-poll kimi-auto**: `fs.watch` on the resolver's `state.json`
   keeps `/status`'s resolved-model marker instant; the shim reads state
   live per request.
5. **Per-hop telemetry**: `X-Estate-Timings` on every response; p50/p95
   per provider in `/status`.

Measured: hedge fires at ~1500ms (test); blackholed-backend failover serves
200 via the next provider with zero client failures; dead backend
auto-quarantines via warm standby; prober heals on recovery (open → half →
closed, traffic returns).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ESTATE_STRATEGY` | `hybrid` | routing strategy |
| `ESTATE_CONNECT_MS` | `8000` | per-attempt connect ceiling |
| `ESTATE_TTFT_MS` | `45000` | streaming first-token ceiling |
| `ESTATE_ATTEMPT_MS` | `120000` | non-stream attempt ceiling |
| `ESTATE_ATTEMPT_STREAM_MS` | `180000` | streaming attempt ceiling |
| `ESTATE_HEDGE_MS` | `1500` | speculative hedge delay (0=sequential) |
| `ESTATE_QUARANTINE_BASE_S` | `30` | quarantine backoff base |
| `ESTATE_QUARANTINE_MAX_S` | `600` | quarantine backoff cap |
| `ESTATE_QUARANTINE_PROBE_MS` | `15000` | re-probe cadence |
| `ESTATE_DB` | `…/estate_router.db` | SQLite path (tests override) |
| `KIMI_AUTO_SHIM_PORT` | `25105` | kimi-auto shim port (in `config/ports.env`) |
| `KIMI_AUTO_STATE` | `~/.local/share/kimi-auto/state.json` | resolver state (fs.watch) |

Cloud keys via secret files (hot-reloadable): `NVIDIA_API_KEY` /
`NVIDIA_API_KEYS`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`,
`GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `NIM_PROXY_API_KEY`.

## Endpoints

```bash
# Chat (OpenAI-compatible)
curl -X POST http://127.0.0.1:25104/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'

# Explicit provider (colon or slash form; also bare local ids)
# {"model":"llama-swap:<model-id>"}  {"model":"nvidia/nvidia/nemotron-3-super-120b-a12b"}

curl http://127.0.0.1:25104/health     # version, strategy, provider summary
curl http://127.0.0.1:25104/status     # full resilience dashboard
curl 'http://127.0.0.1:25104/openfang/resolve?spec=nvidia:foo'  # spec check
curl -X POST http://127.0.0.1:25104/admin/reload   # hot-reload secret files
```

## Bodybuilder (multi-model fan-out)

Decompose a natural-language job into parallel LLM request bodies, then
execute them. Autonomous by default: the caller sends the prompt and gets
answers back. `execute:false` restores bodies-only for callers that run the
fan-out themselves.

Generation vs execution: the decomposition LLM only generates request
bodies; in autonomous mode the router executes each body through
pin-aware dispatch and returns per-model results.

Model-ID hygiene (2026-10-01/02): the decomposer LLM hallucinates IDs
from training data. The router constrains it with the live free-pool
allow-list, instructs verbatim IDs, then sanitizes: unknown IDs are
rewritten round-robin to live pool members, temperature clamped to
[0,2], max_tokens to [1,32000]. Malformed output falls back to
deterministic fan-out across the live free pool.

## Quality gates (2026-10-02)

* Chat-capability filter: guard, embedding, reranker, moderation, reward,
  and classifier models never enter chat candidate pools (isChatCapable
  in router_config.ts).
* Substance gate: substantive() rejects bare scalar scores as chat
  completions, so classifier-shaped answers feed the flap-strike circuit
  instead of being served.

## Openfang configuration

Point Openfang at the router as an OpenAI-compatible endpoint:

```
base_url = http://127.0.0.1:25104/v1
model    = auto            # router picks (Elo + latency + health)
# or model = "llama-swap:<id>" / "kimi-auto" / "nvidia/..." for pinning
```

Known Openfang bug (worked around router-side): `openfang agent set` can
place `nvidia:<model>` wholly into the model field while preserving the old
provider. The router's `normalizeModelSpec()` parses `provider:model` and
`provider/model` forms and routes them to the right provider, so the mangled
spec still works — verify with `/openfang/resolve?spec=<spec>`.

## Research grounding

- RouteLLM, arXiv 2406.18665 — learned strong/weak routing from preference
  data (informs Elo-as-preference-signal).
- FrugalGPT, arXiv 2305.05176 — cheap-to-expensive learned cascades
  (informs `cascade` strategy).
- A Unified Approach to Routing and Cascading for LLMs, arXiv 2410.10347 —
  routing+cascading unification, quality estimators (informs substantive/
  isAst gating).
- Mixture-of-Schedulers, arXiv 2511.11628 — learned router over expert
  scheduling policies.
- HFT corpus (on yote, not GitHub): `shingle-workspace/hft-specs/`,
  `squawk-hft-latency.md`, `squawk-hft-microsecond.md`,
  `gear-push-ZgT7il/g/shared/hft_fetch.py`, `skills/hft-latency` —
  race/fail-fast/push-not-poll/measure-every-hop doctrine synthesized above.

## Tests

`bun test tests/hedge.test.ts` (8 tests): hedged second-lane wins at
~1500ms, loser aborts take no circuit strike, strike-demotion of lane 0,
spec normalization (colon/slash/bare), exponential quarantine via synthetic
probes, latency-EMA scoring. Uses a temp SQLite DB (`ESTATE_DB`).

## Failover demo (2026-09-20, live)

1. Baseline explicit `llama-swap:beellama/exaone-4-0-1-2b-iq4xs` → 200,
   `X-Routed-Via: llama-swap/…` (1378ms).
2. `iptables DROP` on :25100 → identical request → **200** via
   `nvidia/nvidia/nemotron-3-super-120b-a12b`. Zero failed client requests.
3. Warm standby quarantined llama-swap (3 strikes, circuit open, backoff);
   `/status` showed the strike trail.
4. Block removed → quarantine prober re-probed (open → half) → next real
   request succeeded → circuit closed, traffic returned to llama-swap.
5. Lesson applied: kimi-auto shim's 120s upstream timeout → 8s fail-fast so
   a dead herd surfaces 502 immediately instead of hanging the chain.

## Opportunities (running list)

- Weighted timeout strikes: `ttft_timeout`/`attempt_timeout` count double
  (a hanging provider quarantines in 2 requests, not 3).
- Persistent keep-alive pool to cloud providers (amortize TLS handshake;
  microsecond audit showed 150–670ms per cold handshake).
- Chain-level give-up for all-dead scenarios (fast 503 instead of waiting
  out hangers).
- Concurrency sweeps + p95 methodology doc (per the HFT microsecond audit).
