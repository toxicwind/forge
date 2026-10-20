"""
Estate AST Matrix v3 — Maximal free coding gateway for Zed
=============================================================
5 routing strategies (research-backed: RouteLLM, agent-router, PORT,
LLM-Runner-Router, radlab llm-router, circuit-breaker patterns):
  1. fifo_matrix      — bounded FIFO queue, back-pressure
  2. ast_race         — parallel race of 4; first AST/code-shaped response wins
  3. sticky_affinity  — session sticky 30 min for multi-turn coherence
  4. weighted_elo     — dynamic weight from recent success/latency (RouteLLM-style)
  5. circuit_chain    — sequential fallback with circuit-breaker open/half-open

Default: hybrid (sticky -> ast_race of top-weighted -> circuit_chain on failure).

DB: SQLite WAL mode for model health tracking + healing detection.
    Tracks per-model-per-provider success rate, latency percentiles,
    rate-limit events, and healing recovery timestamps.

No local GPU. Cloud-only. Basedpyright-clean types.
"""


from __future__ import annotations
from router_config import DB, MAX_PARALLEL, PROVIDER_MODELS, PROVIDERS, key_ok
from router_matrix import state
from router_server import main


if __name__ == "__main__":
    main()
