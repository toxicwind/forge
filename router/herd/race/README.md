# herd/race — universal code racer as a first-class Herd model

> **STATUS (2026-09-20):** this service is planned, not yet built — `main.go`, the `herd-race` binary, the pitchfork entry (`estate/herd-race`), the `herd.yaml` peer block, and `config/herd-race.json` do not exist yet. Treat this README as a design doc until the service lands.

`herd/race` is the universal code racer ported into Herd natively. It is a
selectable model like any other: send `{"model": "herd-race/herd/race"}` to
`http://127.0.0.1:25100/v1/chat/completions` and the racer fans the request out
to every code backend concurrently. **First valid completion wins** — not
first response.

## Architecture

```
client -> :25100 (herd) -> peer herd-race -> :25161 (this service)
                                              |-- nim-nemotron   (:25104 NIM proxy)
                                              |-- herd-local     (:25100 qwen-flash-128k)
                                              |-- herd-local-fast(:25122 beellama EXAONE)
                                              |-- pollinations-anon (text.pollinations.ai, keyless)
                                              +-- kimi           (:25100 openrouter-kimi, usually 401)
```

- **Service:** Go, `main.go` → binary `herd-race`, supervised by pitchfork
  (`estate/herd-race`), config `/home/toxic/estate/config/herd-race.json`,
  port `25161` (`HERD_RACE_PORT` in `ports.env`).
- **Herd wiring:** peer `herd-race` in `/home/toxic/estate/config/herd.yaml`
  (`proxy: http://127.0.0.1:25161`, `models: [herd/race]`). Herd's
  `--watch-config` picks it up without restart; it appears in `/v1/models`
  as `herd-race/herd/race` (house peer-qualified convention).
- **No credentials in this service.** NIM goes through the local `:25104`
  proxy (no key needed); Kimi reuses the existing Herd route; Pollinations
  uses the anonymous keyless lane. Nothing secret is stored or logged.

## Racer doctrine (ported from `~/workspace/skills/race/`)

- Concurrent redundant strategies; first **valid** wins.
- Validity gate per completion: HTTP 200 + parseable OpenAI body + non-empty
  content + sane finish reason + head-of-content scan rejects error/budget/
  auth/queue notices that arrive as HTTP 200 (e.g. Pollinations' 538-char
  budget notice — caught 2026-09-20).
- Per-attempt fail-fast ceilings: adaptive `p50*2+2s`, clamped to
  `[min_timeout_s, max_timeout_s]` (12s/25s). Slow history never buys a
  longer leash; overall race deadline = `max_timeout_s`. Slow is a kind of
  wrong — timeouts count as circuit failures.
- No sequential retry-spin. Losers are cancelled the moment a winner is
  validated (`context.WithCancel`); cancellation is never recorded as a
  backend failure.
- Circuit breaker per contestant: 3 consecutive failures → open 60s
  (skipped from races), half-open probe after cooldown, closes on success.
  Observed 2026-09-20: Kimi's 401 route parked itself after 3 races.
- Persistent HTTP/2 transports, tuned pools; microsecond/monotonic timing
  on every attempt.
- JSONL winner history: `~/.cache/fleet-bus/hft_race_winners.jsonl` (tag
  `herd/race`); startup seeds latency/wins from it so the racer leads with
  historical winners.
- Telemetry: `X-Race-Winner`, `X-Race-Attempts` (per-contestant ms),
  `X-Race-Total-Ms` response headers; `GET /health` exposes per-contestant
  circuit state, wins, p50/p99, failures, adaptive timeout.
- Streaming callers get a synthesized SSE stream replaying the winning
  non-streaming completion.

## Operations

```bash
# health + per-contestant circuits
curl -s http://127.0.0.1:25161/health | python3 -m json.tool

# supervised lifecycle
/home/toxic/estate/stack/pf.sh start|stop estate/herd-race

# model visible through the router?
curl -s http://127.0.0.1:25100/v1/models | python3 -c \
  "import json,sys; print([m['id'] for m in json.load(sys.stdin)['data'] if 'race' in m['id']])"
```

## Selection notes (live, 2026-09-20)

Contestants are chosen for liveness, not static rank. Observed behavior that
shaped the config:

- NIM Nemotron: best quality signal in audits but free-tier 429s under load —
  the breaker absorbs those.
- Pollinations anonymous: fastest at times, but the shared budget drains and
  the API returns HTTP 200 with a not-enough-credits notice — the validity
  gate (not the status code) is what saves us.
- qwen-flash-128k: reasoning model; burns tokens thinking, often returns
  empty `content` on small `max_tokens` — correctly rejected as invalid.
- beellama EXAONE (`fast`, :25122): 0.3s valid answers; the reason the race
  usually finishes sub-second.
- Kimi K3 route: 100% 401 in audits; breaker parks it automatically.

## Files

| Path | Role |
| ---- | ---- |
| `main.go`, `main_test.go`, `go.mod` | Service source (also mirrored in `~/workspace/audit-fix/race-port/herd-race/`) |
| `herd-race` | Built binary (rebuilt on yote; `go build -o herd-race .`) |
| `/home/toxic/estate/config/herd-race.json` | Contestants, timeouts, breaker, log path |
| `/home/toxic/estate/config/herd.yaml` | `herd-race` peer block |
| `/home/toxic/estate/pitchfork.toml` | `[daemons.herd-race]` supervision |
| `/home/toxic/estate/config/ports.env` | `HERD_RACE_PORT=25161` |
