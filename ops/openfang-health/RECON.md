# OpenFang / Coyote recon — status 2026-09-20

## What was found (live, yote)
- OpenFang 0.6.9. `openfang status` boots an in-process kernel; 4 persistent
  agents restored (coyote, shingle-pilot, squawk-relay, assistant). Audit chain
  integrity OK (352 entries at last check). No persistent API daemon on 25203.
- Endpoints: :25100 llama-swap (206 models) live, :25102 yote live,
  :25115 mesh live, :25152 qwen3.5-9b-tool live, :25143 coyote closed.
- kimi-auto resolver: picked kimi-k3-nim, healthy (431ms best latency).
- Rig fork: /home/toxic/projects/openfang (origin toxicwind/rig); .git/HEAD
  repaired 2026-09-20 (was missing).
- Agent 1: NO persona deployed (User 2026-09-14 directive: agent1 names
  itself). Installer `ops/openfang-agent1-instantiate.sh` refuses the
  PROPOSAL draft unless --i-accept-proposal. Proposal doc at
  ~/shingle/agent1-persona-PROPOSAL.md.

## What was built (this track)
- `ops/openfang-health/`: openfang-health.sh (15 checks, per-probe latency,
  supervisor-stale vs outage distinction), loop.sh (5-min loop, squawk
  transition posts), provider-race.py + race-candidates.json (HFT concurrent
  model race, capability-gated on tool_calls, winner ledger + stale fallback),
  README.md, OPPORTUNITIES.md.
- Symlinks in ~/shingle/bin/: openfang-health.sh, provider-race.

## Key results
- **Tool-capable model PROVEN**: qwen3.5-9b-tool @ :25152 emits valid
  tool_calls (calc{"expr":"17*23"} → 391 path verified). Race winner
  739ms; exaone-fast 1582ms; kimi-auto 2636ms — all tool-capable, qwen
  fastest. Pilot's model blocker is unblocked at the endpoint level.
- **pitchfork does not expand ${} in ready_http** — must use literal ports
  there (sibling track's fix in working tree; uncommitted).
- **supervisor-stale pattern**: pitchfork listed toolcall-llm errored while
  :25152 served fine; awrawr-ws-exec errored (EADDRINUSE) while :8379 serves.
  Health script now downgrades these to warn instead of fail.
- beellama-fast daemon is DOWN as of 2026-09-20 00:07 MDT (sibling track's
  daemon; not touched).

## Open threads
- Wire race winner into shingle-pilot model selection (opp #1).
- coyote :25143 intentionally parked? Ask coordinator.
- Agent 1 persona still awaits Agent 1 / lead decision.
- **:25100 llama-swap WEDGED as of 2026-09-20 00:10 MDT** — process
  842136 alive since Sep 18 and listening, but /health and /v1/models hang
  (20s+ timeouts; was 19ms at 00:07). NOT pitchfork-managed; herd track
  was building in projects/herd at 00:09. Do not touch — herd/kimi-auto
  track owns it. Health dashboard correctly reports FAIL.
