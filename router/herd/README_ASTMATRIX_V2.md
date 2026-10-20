# AstMatrix V2 — Production-Grade Cloud Provider Router

## Overview

AstMatrix is a first-class routing module for herd that provides intelligent dispatch to cloud LLM providers with production-grade reliability features.

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
- **Health Probes**: Background 5s probes every 30s
- **Request Coalescing**: Deduplicates identical concurrent requests
- **Streaming SSE**: Proper flush every 32KB for real-time responses
- **Retry with Backoff**: 3 attempts per provider with exponential backoff
- **Rate Limiting**: Token bucket per provider (60/min paid, 10/min free)
- **Latency Tracking**: Exponential moving average per provider
- **Sticky Sessions**: Session affinity via Authorization header
- **Model Mapping**: Map local model IDs to provider-specific IDs

## Configuration

```yaml
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

Upstream `server.go` already dispatches to `s.cloud.ServeHTTP(w, r)` when `s.cloud.Handles(data.ModelID)` returns true. This router implements the `router.Router` interface and is a drop-in replacement.

## Build

```bash
cd herd
go build ./...
```

## Status Endpoint

```bash
curl http://localhost:25100/astmatrix/status
curl http://localhost:25100/astmatrix/metrics
```
