# Herd

> 🗺️ Part of [**the ranch**](https://github.com/toxicwind/ranch) — the whole inference estate, one map.

> **Orchestrate fleets of LLM inference engines. Zero downtime, zero friction.**  
> Canonical Lineage: **[toxicwind/herd](https://github.com/toxicwind/herd)** & **[toxicwind/herd](https://github.com/toxicwind/herd)** (Upstream: [mostlygeek/herd](https://github.com/mostlygeek/herd))

[![CI](https://github.com/toxicwind/herd/actions/workflows/go-ci.yml/badge.svg)](https://github.com/toxicwind/herd/actions)
[![CI (Windows)](https://github.com/toxicwind/herd/actions/workflows/go-ci-windows.yml/badge.svg)](https://github.com/toxicwind/herd/actions)
[![License: SOL / MIT](https://img.shields.io/badge/License-SOL%20v1.0%20%2F%20MIT-blue.svg)](./LICENSE.md)

---

## 🔱 Estate Fleet Orchestration (75 Models via AST Matrix)

Herd is the high-performance inference gateway and model router for the Estate Stack. It transforms single-model hot-swapping into multi-tier fleet orchestration across local hardware (NVIDIA RTX 3090 24GB CUDA 8.6 + AMD Ryzen 7 8700F Zen 4 AVX-512) and remote endpoints.

- ✅ Easy to deploy and configure: one binary, one configuration file. no external dependencies
- ✅ On-demand model switching for many local AI servers (llama.cpp + forks, vllm, stable-diffusion.cpp, audio.cpp, ComfyUI, etc.)
  - future proof, upgrade your inference servers at any time.
- ✅ OpenAI API supported endpoints:
  - `v1/completions`
  - `v1/chat/completions`
  - `v1/responses`
  - `v1/embeddings`
  - `v1/models` - list available models
  - `v1/audio/speech` ([#36](https://github.com/mostlygeek/herd/issues/36))
  - `v1/audio/transcriptions` ([docs](https://github.com/mostlygeek/herd/issues/41#issuecomment-2722637867))
  - `v1/audio/voices`
  - `v1/images/generations`
  - `v1/images/edits`
- ✅ Anthropic API supported endpoints:
  - `v1/messages`
  - `v1/messages/count_tokens`
- ✅ llama-server (llama.cpp) supported endpoints
  - `v1/rerank`, `v1/reranking`, `/rerank`
  - `/infill` - for code infilling
  - `/completion` - for completion endpoint
  - `/models` - list available models. same behavior as `v1/models`
  - `/props` - requires `?model={model_id}` query parameter to be provided. The autoload parameter is not supported and will be ignored.
- ✅ SDAPI via [stable-diffusion.cpp's server](https://github.com/leejet/stable-diffusion.cpp/tree/master/examples/server)
  - `/sdapi/v1/txt2img`
  - `/sdapi/v1/img2img`
  - `/sdapi/v1/loras` - requires `model` in request body to fetch the correct loras
- ✅ [audio.cpp](https://github.com/0xShug0/audio.cpp) supported [extra endpoints](https://github.com/0xShug0/audio.cpp/blob/main/app/server/README.md#post-v1tasksrun)
  - `/audioapi/v1/tasks/run`
- ✅ `/comfyui/` - ComfyUI custom endpoint ([#1001](https://github.com/mostlygeek/herd/issues/1001)) for more reliable swapping
- ✅ herd API
  - `/ui` - web UI
  - `/upstream/:model_id` - direct access to upstream server ([demo](https://github.com/mostlygeek/herd/pull/31))  
  - `/running` - list currently running models ([#61](https://github.com/mostlygeek/herd/issues/61))
  - `POST /api/models/unload` - manually unload all running models ([#58](https://github.com/mostlygeek/herd/issues/58))
  - `POST /api/models/unload/:model_id` - unload a specific model
  - `GET /api/profiles` - list configured profiles and the active selection
  - `PUT /api/profiles/active` - activate a profile or select none
  - `/logs` - remote log monitoring
    - `GET /logs` returns buffered plain text logs.
      - If `Accept: text/html` is sent, `/logs` redirects to `/ui/`.
    - `GET /logs/stream` keeps the connection open for live log streaming.
      - Stream endpoints send buffered history first by default; add `?no-history` to stream only new lines.
    - `GET /logs/stream/proxy` streams proxy logs only.
    - `GET /logs/stream/upstream` streams upstream process logs only.
    - `GET /logs/stream/{model_id}` streams logs for one model (including IDs with slashes, like `author/model`).
  - `/health` - just returns "OK"
  - `/metrics` - system and GPU metrics for prometheus
- ✅ API Key support - define keys to restrict access to API endpoints
- ✅ Customization
  - Switch model ID routing at runtime with profiles
  - Run concurrent models with a custom DSL swap matrix ([#643](https://github.com/mostlygeek/herd/issues/643))
  - Automatic unloading of models after timeout by setting a `ttl`
  - Docker and Podman support using `cmd` and `cmdStop` together
  - Preload models on startup with `hooks` ([#235](https://github.com/mostlygeek/herd/pull/235))
  - Apply filters to requests to control inference with `stripParams`, `setParams` and `setParamsByID`

### Core Capabilities Matrix

| Capability | Standard Hot-Swap | Herd Estate Orchestrator |
|---|---|---|
| **Model Fleet** | 1 model active | **75 models routed via AST Matrix** |
| **Connection Handling** | Drop connection on swap | **Zero-downtime SSE keep-alive** |
| **Hardware Offload** | Unmanaged CPU/GPU | **CUDA 8.6 Flash-Attn + Zen 4 AVX-512** |
| **API Endpoints** | OpenAI basic | **OpenAI, Anthropic, Ollama, SDAPI, Rerank, Voice** |
| **Supervisor Integration** | Standalone process | **Pitchfork-LLM & Estate Control Plane (:25100)** |
| **Observability** | CLI logs | **Prometheus Metrics (:25105) + SSE Event Stream** |

---

## 🚀 Architecture & Routing

```mermaid
graph TD
    A[Client Request] --> B[Herd Router :25100]
    B --> C{AST Matrix Classifier}
    C -->|Fast / Reasoning| D[beellama-cpp :25001 - EXAONE 1.2B]
    C -->|Defrag / Fit-Margin| E[ik-llama-cpp :25002 - Heretic 27B]
    C -->|Turbo 96k Context| F[llama-cpp-turboquant :25003 - Gemma 12B]
    C -->|Autonomous Inference| G[HAL Substrate :25143]
    C -->|Remote / NIM Fleet| H[NVIDIA NIM 1M Context Fleet]
    D --> I[Unified OpenAI / Anthropic SSE Response]
    E --> I
    F --> I
    G --> I
    H --> I
```

---

## 🛠️ API & Feature Reference

- ✅ **Full Multi-Format API Support**:
  - `v1/chat/completions`, `v1/completions`, `v1/responses`
  - `v1/messages` (Anthropic Messages API with prompt caching preservation)
  - `v1/embeddings`, `v1/rerank`, `v1/reranking`
  - `v1/audio/speech`, `v1/audio/transcriptions`, `v1/audio/voices`
  - `v1/images/generations`, `v1/images/edits` (SDAPI via stable-diffusion.cpp)
- ✅ **Dynamic Management & Observability**:
  - `GET /health` -> `OK`
  - `GET /metrics` -> Prometheus metrics for memory, active model state, request rates
  - `GET /running` -> Active running models and memory allocations
  - `POST /api/models/unload` & `POST /api/models/unload/:model_id`
  - `GET /logs/stream` & `GET /models/sse` -> Live SSE event streams for editor integration (Zed / QED)

---

## 📦 Build & Run

```bash
# Build with Zen 4 AVX-512 and maximal Go compiler flags
go build -v -ldflags="-s -w" -o herd ./cmd
./herd --config /home/toxic/estate/config/herd.yaml
```
The main build entry is `scripts/mise-build.sh` — it submits the canonical
build+test (`go build ./... && go test -short -count=1 ./internal/...`, matching
the Makefile `test` target) directly through mise. Eligible task artifacts restore through mbx-cache:

```sh
./scripts/mise-build.sh
```

(The `ui/` frontend build, `make ui`, is a separate release step and is not part
of the wired build.)

Note: run the script with the direct bun binary — `herd/mise.toml` is not
mise-trusted, and the `bun` mise shim silently no-ops inside `herd/`:

```sh
/home/toxic/.bun/bin/./scripts/mise-build.sh
```


<details>
<summary>
more examples
</summary>

```shell
# pull latest images per platform
docker pull ghcr.io/mostlygeek/herd:cpu
docker pull ghcr.io/mostlygeek/herd:cuda
docker pull ghcr.io/mostlygeek/herd:vulkan
docker pull ghcr.io/mostlygeek/herd:intel
docker pull ghcr.io/mostlygeek/herd:musa

# tagged herd, platform and llama-server version images
docker pull ghcr.io/mostlygeek/herd:v166-cuda-b6795

# non-root cuda
docker pull ghcr.io/mostlygeek/herd:cuda-non-root

```

</details>

### Homebrew Install (macOS/Linux)

```shell
brew tap mostlygeek/herd
brew install herd
herd --config path/to/config.yaml --listen localhost:8080
```

### MacPorts (macOS)

> [!NOTE]
> Maintained by MacPorts community - [herd port](https://ports.macports.org/port/herd). It is not an official part of herd.

```shell
sudo port install herd
herd --config path/to/config.yaml --listen localhost:8080
```

### WinGet Install (Windows)

> [!NOTE]
> WinGet is maintained by community contributor [Dvd-Znf](https://github.com/Dvd-Znf) ([#327](https://github.com/mostlygeek/herd/issues/327)). It is not an official part of herd.

```shell
# install
C:\> winget install herd

# upgrade
C:\> winget upgrade herd
```

### Pre-built Binaries

Binaries are available on the [release](https://github.com/mostlygeek/herd/releases) page for Linux, Mac, Windows and FreeBSD.

### Building from source

1. Building requires Go and Node.js (for UI).
1. `git clone https://github.com/mostlygeek/herd.git`
1. `make clean all`
1. look in the `build/` subdirectory for the herd binary

## Configuration

```yaml
# minimum viable config.yaml

models:
  model1:
    cmd: llama-server --port ${PORT} --model /path/to/model.gguf
```

That's all you need to get started:

1. `models` - holds all model configurations
2. `model1` - the ID used in API calls
3. `cmd` - the command to run to start the server.
4. `${PORT}` - an automatically assigned port number

Almost all configuration settings are optional and can be added one step at a time:

- Advanced features
  - `matrix` to run concurrent models with a custom swap logic DSL
  - `hooks` to run things on startup
  - `macros` reusable snippets
- Model customization
  - `ttl` to automatically unload models
  - `unloadTimeout` to tune graceful unloads (manual, API and `ttl` expiry)
  - `aliases` to use familiar model names (e.g., "gpt-4o-mini")
  - `env` to pass custom environment variables to inference servers
  - `cmdStop` gracefully stop Docker/Podman containers
  - `useModelName` to override model names sent to upstream servers
  - `${PORT}` automatic port variables for dynamic port assignment
  - `filters` rewrite parts of requests before sending to the upstream server

See the [configuration guide](docs/kb/guides/configuration/configuration-overview.md) for an overview, and
the [knowledge base](docs/kb/) for focused guides on the features people ask about
most.

You can also just ask. The Playground's **Docs** tab is an agent that calls
herd's own documentation tools and answers questions about your
configuration using the real text of `config.example.yaml` and the knowledge
base, running entirely on a local model. Pick a tool-capable model in
**Playground → Docs** and ask away — see
[Setting up tool calling](docs/kb/tutorials/tool-calling-setup.md) if the model
answers without calling anything.

Those same tools are served as an MCP endpoint at `/api/mcp`, so any MCP client
can ask about your configuration too. See
[Connecting an MCP client](docs/kb/guides/api-integration/mcp-endpoint.md).

## How does herd work?

When a request is made to an OpenAI compatible endpoint, herd will extract the `model` value and load the appropriate server configuration to serve it. If the wrong upstream server is running, it will be replaced with the correct one. This is where the "swap" part comes in. The upstream server is automatically swapped to handle the request correctly.

In the most basic configuration herd handles one model at a time. For more advanced use cases, using a `matrix` allows multiple models to be loaded at the same time. You have complete control over how your system resources are used.

## Reverse Proxy Configuration (nginx)

If you deploy herd behind nginx, disable response buffering for streaming endpoints. By default, nginx buffers responses which breaks Server‑Sent Events (SSE) and streaming chat completion. ([#236](https://github.com/mostlygeek/herd/issues/236))

Recommended nginx configuration snippets:

```nginx
# SSE for UI events/logs
location /api/events {
    proxy_pass http://your-herd-backend;
    proxy_buffering off;
    proxy_cache off;
}

# Streaming chat completions (stream=true)
location /v1/chat/completions {
    proxy_pass http://your-herd-backend;
    proxy_buffering off;
    proxy_cache off;
}
```

As a safeguard, herd also sets `X-Accel-Buffering: no` on SSE responses. However, explicitly disabling `proxy_buffering` at your reverse proxy is still recommended for reliable streaming behavior.

## Monitoring Logs on the CLI

```sh
# sends up to the last 10KB of logs
$ curl http://host/logs

# streams combined logs
curl -Ns http://host/logs/stream

# stream herd's proxy status logs
curl -Ns http://host/logs/stream/proxy

# stream logs from upstream processes that herd loads
curl -Ns http://host/logs/stream/upstream

# stream logs only from a specific model
curl -Ns http://host/logs/stream/{model_id}

# stream and filter logs with linux pipes
curl -Ns http://host/logs/stream | grep 'eval time'

# appending ?no-history will disable sending buffered history first
curl -Ns 'http://host/logs/stream?no-history'
```

## Do I need to use llama.cpp's server (llama-server)?

Any OpenAI compatible server would work. herd was originally designed for llama-server and it is the best supported.

For Python based inference servers like vllm or tabbyAPI it is recommended to run them via podman or docker. This provides clean environment isolation as well as responding correctly to `SIGTERM` signals for proper shutdown.


---

## AstMatrix V2 — Production-Grade Cloud Provider Router

AstMatrix provides intelligent routing to cloud LLM providers with production-grade reliability.

### Features

- **8 Routing Strategies**: hybrid, ast_race, sticky_affinity, weighted_elo, least_latency, round_robin, free, circuit_chain
- **Circuit Breakers**: Closed→Open→Half-Open with automatic probe recovery
- **Health Probes**: Background 5s checks every 30s
- **Request Coalescing**: Deduplicates identical concurrent requests
- **Streaming SSE**: Proper flush every 32KB for real-time responses
- **Retry with Backoff**: 3 attempts per provider with exponential backoff
- **Rate Limiting**: Token bucket per provider (60/min paid, 10/min free)
- **Latency Tracking**: Exponential moving average per provider
- **Sticky Sessions**: Session affinity via Authorization header
- **Model Mapping**: Map local model IDs to provider-specific IDs

### Built-in Providers (13)

| Provider | Base URL | Free Tier | Models |
|----------|----------|-----------|--------|
| herd | http://127.0.0.1:25100/v1 | ✓ | local-fast, local-quality, local-longctx |
| openrouter | https://openrouter.ai/api/v1 | | openrouter/auto |
| nvidia | https://integrate.api.nvidia.com/v1 | ✓ | llama-3.1-nemotron-70b |
| groq | https://api.groq.com/openai/v1 | ✓ | llama-3.1-70b-versatile |
| together | https://api.together.xyz/v1 | | llama-3.1-70b |
| cerebras | https://api.cerebras.ai/v1 | ✓ | llama-3.1-70b |
| fireworks | https://api.fireworks.ai/inference/v1 | | llama-3.1-70b |
| hyperbolic | https://api.hyperbolic.xyz/v1 | ✓ | llama-3.1-70b |
| github | https://models.inference.ai.azure.com | ✓ | Phi-4, gpt-4o-mini |
| mistral | https://api.mistral.ai/v1 | | mistral-large-2 |
| openai | https://api.openai.com/v1 | | gpt-4o, gpt-4o-mini, o1-preview |
| perplexity | https://api.perplexity.ai | | sonar |
| siliconflow | https://api.siliconflow.cn/v1 | ✓ | deepseek-v2 |

### Configuration

```yaml
astMatrix:
  enabled: true
  strategy: hybrid
  astStrategy: ast_race
  requestTimeout: 95
  maxRetries: 3
  healthProbeInterval: 30
  enableCoalescing: true
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

### Status Endpoint

```bash
curl http://localhost:25100/astmatrix/status
curl http://localhost:25100/astmatrix/metrics
```

### Architecture

| File | Purpose |
|------|---------|
| `config.go` | YAML configuration structs |
| `circuit.go` | Circuit breaker with half-open support |
| `coalescer.go` | Request deduplication |
| `metrics.go` | Latency histograms, error rates |
| `providers.go` | Provider registry (13 built-in) |
| `healthdb.go` | SQLite health DB + sticky sessions |
| `ratelimit.go` | Token bucket rate limiter |
| `router.go` | Main HTTP handler (8 strategies) |
| `matrix.go` | Coordinator wrapper |
| `ui.go` | Status/metrics HTTP endpoints |
