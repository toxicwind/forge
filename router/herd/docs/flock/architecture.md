# flock architecture

> **NOTE 2026-09-19.** The in-process Go router (`projects/herd/internal/flock`,
> `astMatrix:` config key) was retired from the shipped herd binary 2026-09-17:
> the binary ignores `astMatrix:` with a warning and 404s on `/flock/status`,
> `/flock/metrics`, `/astmatrix/*`. Live cloud routing is the `flock:`
> delegation key in `config/herd.yaml` pointing at the `:8000` flock daemon
> below. `internal/flock/providers.go` remains the tree's canonical provider
> definitions, but it is not compiled into the shipped binary.

```
                ┌─────────────────────────────────────────┐
                │  flock proxy (Rust)  127.0.0.1:8000      │
                │  rate limiting · history store ·        │
                │  dashboard · OpenAI-compatible API      │
                └───────────────┬─────────────────────────┘
                                │ upstream
                                ▼
                  integrate.api.nvidia.com/v1
```

| Component | Path in `/home/toxic/projects/flock/` | Role |
|---|---|---|
| `proxy/` | Rust service | Local enforcement point: rate limits, request history, operator dashboard, OpenAI-compatible front |
| `client/` | TS + Python clients | Programmatic access to NIM |
| `dashboard/` | Bun dashboard | Benchmark visualization |
| `tools/` | `nvt.py`, `nvidia_nim_inference.py` | CLI toolkit, free-tier inference |
| `research/` | Go research | Inkling API research |
| `benchmarks/` | moonbox trees | Benchmark snapshots + live runs |

flock never serves local models. Local inference is herd/herd's job.
flock is the whole API/routing surface. The Go router package `projects/herd/internal/flock`
**owns the canonical provider definitions** (see `providers.go` — nvidia →
`https://integrate.api.nvidia.com/v1`); the flock proxy daemon (:8000) is the local
enforcement point the routers actually dial.
