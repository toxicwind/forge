# flock × herd integration

## Who dials flock

| Caller | How |
|---|---|
| estate-scripts-router-ts `nvidia` provider | `http://127.0.0.1:8000` (OpenAI-compatible) |
| flock Go router (`projects/herd/internal/flock`) | provider definitions point at upstream `integrate.api.nvidia.com/v1`; the flock proxy daemon is the optional local enforcement layer |

## Ownership

- **flock owns provider definitions.** Model lists, base URLs, and strategy
  live in `projects/herd/internal/flock/`.
- **The flock proxy daemon owns local enforcement.** Rate limiting, history, dashboard, key
  handling for the NIM surface on :8000. It does not define herd's provider catalog — the
  flock Go router package does.

## Naming

Renamed in full 2026-09-17: `nim-proxy` → `flock` (crate, strings, icons,
daemon, docs). Upstream provenance (miztertea/nim-proxy, MIT) is preserved in
`proxy/Cargo.toml` and the OpenAPI contact block.
