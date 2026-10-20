# flock router V2 — Production-Grade Cloud Provider Router

> **RETIRED 2026-09-17 — READ THIS FIRST.** The in-process Go router described
> below (`internal/flock`, `astMatrix:` config key) is **not compiled into the
> shipped binary**. The binary logs `[WARN] astMatrix config block is retired
> and ignored; configure flock: instead`, serves **404** on `/flock/status`,
> `/flock/metrics`, `/astmatrix/status`, and `/astmatrix/metrics`. Live cloud
> routing is **delegation**: the `flock:` config key points herd at the flock
> daemon on `127.0.0.1:8000`, whose models appear in `/v1/models` with the
> `flock:` prefix (e.g. `flock: 01-ai/yi-large`). What follows documents the
> tree-only `internal/flock` package for reference.

## Overview

flock is a first-class routing module for herd that provides intelligent dispatch to cloud LLM providers with production-grade reliability features.

## Architecture (Modular)

| File | Purpose |
|------|---------|
| `config.go` | YAML configuration structs and defaults |
| `circuit.go` | Circuit breaker with half-open probe support |
| `coalescer.go` | Request deduplication for identical concurrent requests |
| `metrics.go` | Latency histograms, error rates, throughput tracking |
| `providers.go` | Provider registry with 13 built-in providers |
| `healthdb.go` | SQLite-backed health DB with EMA latency, sticky sessions |
| `ratelimit.go` | Token bucket rate limiter per provider |
| `router.go` | Main HTTP handler with 8 routing strategies |
| `matrix.go` | Coordinator wrapper (compatibility) |
| `ui.go` | Status and metrics HTTP endpoints |

## Routing Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `hybrid` | Retry + circuit breaker + health check | Default, general purpose |
| `ast_race` | Parallel fan-out, first valid wins | Low latency, cost insensitive |
| `sticky_affinity` | Session-based routing | Stateful conversations |
| `weighted_elo` | ELO-weighted random selection | Quality-aware load balancing |
| `least_latency` | Route to lowest observed latency | Performance-critical |
| `round_robin` | Weighted round-robin | Fair distribution |
| `free` | Free-tier providers only | Cost optimization |
| `circuit_chain` | Chain through providers | Maximum availability |

## Built-in Providers (13)

- herd (local)
- openrouter, nvidia, groq, together, cerebras, fireworks, hyperbolic
- github (models.inference.ai), mistral, openai, perplexity, siliconflow

## Production Features

- **Circuit Breakers**: Closed -> Open -> Half-Open with probe recovery
- **Health Probes**: Background probes every `healthProbeInterval` (default 30s)
- **Request Coalescing**: Deduplicates identical concurrent requests
- **Retry with Backoff**: 3 attempts per provider (`maxRetries` default 3) with exponential backoff
- **Rate Limiting**: Token bucket per provider (60/min paid, 10/min free)
- **Latency Tracking**: Exponential moving average per provider
- **Sticky Sessions**: Session affinity via Authorization header
- **Model Mapping**: Map local model IDs to provider-specific IDs

## Configuration

The live configuration is the **`flock:` delegation key** (see the retired
`astMatrix:` block below for what NOT to use). From the live
`/home/toxic/estate/config/herd.yaml`:

```yaml
# RETIRED 2026-09-17: astMatrix in-process router replaced by Flock delegation.
# Flock (:8000) is the unified multi-provider remote-API/completions subsystem.
flock:
  enabled: true
  baseUrl: http://127.0.0.1:8000
  keyEnv: FLOCK_API_KEY
  modelMap:
    kimi-k2: nvidia/nemotron-3-super-120b-a12b
    kimi-k3-nim: nvidia/nemotron-3-ultra-550b-a55b
```

The in-process router's old `astMatrix:` block (RETIRED — ignored by the binary
with a warning; kept here for reference only):

```yaml
# DO NOT USE — retired 2026-09-17, ignored by the shipped binary.
astMatrix:
  enabled: true
  strategy: hybrid
  astStrategy: ast_race
  requestTimeout: 95
  maxRetries: 3
  healthProbeInterval: 30
  enableCoalescing: true
  astAlways: false
  providers:
    openrouter:
      baseUrl: https://openrouter.ai/api/v1
      keyEnv: OPENROUTER_API_KEY
      models: [openrouter/auto]
    groq:
      baseUrl: https://api.groq.com/openai/v1
      keyEnv: GROQ_API_KEY
      freeTier: true
      models: [groq/llama-3.1-70b-versatile]
```

## Integration

The in-process router implemented the `router.Router` interface as a drop-in
replacement dispatched from `server.go` when the requested model was handled by
the cloud matrix. This integration path is retired along with the `astMatrix:`
key; herd now reaches cloud models through the flock daemon (`flock:` key).

## Build

```bash
cd herd
go build ./...
```

## Status Endpoint

The in-process `/flock/status` and `/flock/metrics` endpoints (plus the legacy
`/astmatrix/*` paths) are **retired — they 404 on the shipped binary**.
Cloud-model visibility now comes from the model listing:

```bash
curl -s http://127.0.0.1:25100/v1/models | python3 -c "import sys,json;print([m['id'] for m in json.load(sys.stdin)['data'] if 'flock' in str(m.get('meta',{}))][:5])"
```
