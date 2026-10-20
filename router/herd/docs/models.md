# Supported Models — Astmatrix V2

## KIMI (Primary)
| Model | ID | Context | Speed | Use Case |
|-------|-----|---------|-------|----------|
| K1.5 | kimi/k1.5 | 128K | Fast | General purpose |
| Moonshot v1 128K | kimi/moonshot-v1-128k | 128K | Medium | Long context |
| Moonshot v1 8K | kimi/moonshot-v1-8k | 8K | Fast | Quick tasks |

Aliases: `kimi-auto` -> K1.5, `kimi-long` -> 128K, `kimi-fast` -> 8K

## Local (herd)
| Model | ID | Context | Speed |
|-------|-----|---------|-------|
| Local Fast | local-fast | 32K | GPU |
| Local Quality | local-quality | 64K | GPU |
| Local Long CTX | local-longctx | 128K | GPU |

## Cloud Providers (13 total)
| Provider | Free Tier | Models | ELO |
|----------|-----------|--------|-----|
| OpenRouter | ✓ | auto, optimus-alpha | 1500 |
| Groq | ✓ | llama-3.1-70b, mixtral-8x7b | 1580 |
| GitHub | ✓ | Phi-4, gpt-4o-mini | 1500 |
| NVIDIA | ✓ | llama-3.1-nemotron-70b | 1550 |
| Cerebras | ✓ | llama-3.1-70b | 1560 |
| Hyperbolic | ✓ | llama-3.1-70b | 1490 |
| SiliconFlow | ✓ | deepseek-v2 | 1470 |
| Together | | llama-3.1-70b, mixtral-8x22b | 1520 |
| Fireworks | | llama-3.1-70b | 1510 |
| Mistral | | mistral-large-2 | 1530 |
| OpenAI | | gpt-4o, gpt-4o-mini, o1-preview | 1650 |
| Perplexity | | sonar | 1480 |

## Routing Strategies
- `hybrid` — Retry + circuit breaker + health check (default)
- `ast_race` — Parallel fan-out, first valid wins
- `sticky_affinity` — Session-based routing
- `weighted_elo` — ELO-weighted random selection
- `least_latency` — Route to lowest observed latency
- `round_robin` — Weighted round-robin
- `free` — Free-tier providers only
- `circuit_chain` — Chain through providers
