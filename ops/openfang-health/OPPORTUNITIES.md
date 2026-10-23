# OpenFang track — opportunities (autonomous posture, standing)

Kept live. Act on these; never locked into one approach.

## Done
- [x] HFT-style provider-race with capability-gated validity (2026-09-20):
      `ops/openfang-health/provider-race.py`. Races model endpoints
      concurrently, first VALID (tool_calls emitted) wins. Winner ledger at
      `~/shingle/var/openfang-health/provider-race-winners.jsonl`.
- [x] Per-probe latency in openfang-health.sh (measure every hop).
- [x] supervisor-stale vs real-outage distinction in health checks.

## Open
1. **Wire race winner into pilot routing.** `provider-race` (no --full) prints
   the winner; shingle-pilot / agent1 installer can call it at boot to pick
   the fastest tool-capable model instead of a hardcoded alias. Needs the
   pilot's model-selection path mapped first (openfang agent create --model?).
2. **kimi-auto resolver: sequential → race.** The resolver probes ~18
   candidates sequentially (state.json shows 792ms + 17065ms + 16×401s…).
   HFT: race them, first-valid-wins — cuts selection from sum(latencies) to
   max(latency). Owned by kimi-auto track; offer the pattern.
3. **Hot persistent openfang kernel.** Every `openfang status` boots a kernel
   (~70ms measured, but still a cold boot per CLI call). A persistent kernel
   daemon (or axiom service) would make agent ops push-not-poll. Bigger lift;
   measure first.
4. **Race the health probes themselves.** openfang-health.sh runs ~15 checks
   sequentially (~10-20s). Parallelize independent probes (endpoints, gpu,
   kimi state) → sub-second dashboard. Careful: keep output deterministic.
5. **AgentSight-style trajectory audit.** arXiv 2508.02736: eBPF links
   prompts/tool calls to process/file/network behavior. OpenFang's audit
   chain logs decisions; eBPF would ground them in OS truth. Big lift,
   high novelty.
6. **AgentCgroup enforcement.** arXiv 2602.09345: tool-driven memory peaks hit
   15.4× average; memory is the concurrency bottleneck. cgroupv2 limits on
   agent-spawned processes (llama-server children, tool sandboxes).
7. **provider-race candidates auto-discovery.** Scrape :25100/v1/models for
   ids and race the full local set nightly; record which models gain/lose
   tool-call ability across quant reloads. (exaone-1.2B emitting tool_calls
   on 2026-09-20 was a surprise — track it.)
8. **Stale-cache TTL policy for race winner.** Currently the cached winner
   never expires. Add max_stale (e.g. 24h) after which NO-WINNER is honest.
9. **hodos around squawk sequence allocation** in loop.sh's transition post
   (concurrent writers could collide on filename).
10. **coyote :25143.** Estate/coyote is configured but absent from the live
    pitchfork set. Recon only — do not start without checking with the
    coordinator (may be intentionally parked).
