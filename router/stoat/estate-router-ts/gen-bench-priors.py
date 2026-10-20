#!/usr/bin/env python3
"""Generate bench-priors.json: bench-derived Elo priors per router provider.

Sources (all real measured data, no guesses):
  1. GuideLLM v3  ranking-eval-20260920-170706.json  (deterministic
     instruction-following quality 0-2 + latency p50 per model, all via
     OpenRouter)            -> openrouter provider prior
  2. MODEL-MAX    phase1.json (liveness: 1 real completion per herd model,
     healthy bool + latency) -> llama-swap provider prior (the herd)
  3. router-proof router-proof-20260921.json (intelligent vs dumb
     head-to-head)           -> router-level availability note + small
     local-lane bonus (not a per-provider quality signal)

Mapping rule: quality_mean (0-2 scale) -> elo = 1000 + (q - 1.0) * 80.
Liveness: local-lane healthy_frac -> elo = 1000 + (hf - 0.5) * 120.
Latency is DELIBERATELY excluded from priors: the router's live
candidateScore already penalizes latency via latencyEMA/50, and a
lane-wide p50 is dominated by models the router never picks.

Providers with no bench coverage keep the flat 1000 and are marked
"unbenched" -- honest about what we don't know.

Re-run:  python3 gen-bench-priors.py
Output:  bench-priors.json (same dir; the router hot-reloads it on
         /admin/reload and SIGHUP, seeding only providers untouched by
         live traffic).
"""

import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

GUIDELLM = os.path.join(REPO, "projects", "openrouter-probe",
                        "ranking-eval-20260920-170706.json")
MODELMAX = os.path.join(REPO, "projects", "model-max", "phase1.json")
ROUTERPROOF = os.path.join(REPO, "projects", "openrouter-probe",
                           "router-proof-20260921.json")
OUT = os.path.join(HERE, "bench-priors.json")

ROUTER_PROVIDERS = ["llama-swap", "nim-local", "kimi-auto", "openrouter",
                    "nvidia", "groq", "cerebras", "google", "mistral"]


def load_json(path):
    with open(path) as f:
        return json.load(f)


def main():
    # Guard (2026-09-30): bench-priors.json may now carry provider-bench priors
    # merged by merge-provider-priors.ts. This legacy generator writes the file
    # wholesale and would ERASE them. Refuse instead of clobbering.
    if os.path.exists(OUT):
        try:
            existing = load_json(OUT)
            if isinstance(existing, dict) and "provider_bench" in (existing.get("sources") or {}):
                print("REFUSING: bench-priors.json already contains provider_bench priors.",
                      file=sys.stderr)
                print("Run merge-provider-priors.ts instead (it preserves legacy sources).",
                      file=sys.stderr)
                sys.exit(2)
        except (OSError, ValueError):
            pass

    missing = [p for p in (GUIDELLM, MODELMAX, ROUTERPROOF) if not os.path.exists(p)]
    if missing:
        print("missing sources:", missing, file=sys.stderr)
        sys.exit(1)

    priors = {}
    sources = {}

    # --- 1. GuideLLM -> openrouter ---------------------------------------
    g = load_json(GUIDELLM)
    results = [r for r in g["results"] if r.get("status") == "ok"]
    tot_w = sum(r.get("n_successful", 0) for r in results) or 1
    qmean = sum(r["quality_mean"] * r.get("n_successful", 0) for r in results) / tot_w
    lat_p50_ms = (sum(r["latency_p50_s"] * r.get("n_successful", 0) for r in results)
                  / tot_w * 1000)
    # catalog drift check: how many benched models are still in the live
    # openrouter catalog (router_config.ts PROVIDER_MODELS.openrouter,
    # 2026-09-21 sweep). Provider-level prior stays valid for the lane;
    # the overlap count is recorded so drift is visible, not hidden.
    live_catalog = {
        "poolside/laguna-xs-2.1:free",
        "google/gemma-4-31b-it:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "inclusionai/ling-3.0-flash-fin:free",
    }
    overlap = [m for m in (r["model"] for r in results) if m in live_catalog]
    elo = 1000 + (qmean - 1.0) * 80
    priors["openrouter"] = {
        "elo": round(elo),
        "quality_mean": round(qmean, 3),
        "latency_p50_ms": round(lat_p50_ms, 1),
        "n_models": len(results),
        "models": [r["model"] for r in results],
        "catalog_overlap": overlap,
        "catalog_drift_note": ("benched 2026-09-20; catalog rotated 2026-09-21; "
                               "prior is lane-level, live Elo corrects per model"),
        "basis": "guidellm",
    }
    sources["guidellm"] = {
        "path": os.path.relpath(GUIDELLM, REPO),
        "run_ts": g.get("ts"),
        "n_models": len(results),
        "instrument": "deterministic instruction-following (exact=2/contains=1/empty=0), 6 req/model",
    }

    # --- 2. MODEL-MAX -> llama-swap (the herd) -----------------------------
    # Local lane only: the router's llama-swap provider serves LOCAL_ROLES
    # (local models). Cloud-lane health says nothing about the local lane,
    # so mixing them would punish local models for cloud outages.
    m = load_json(MODELMAX)
    local = [v for v in m.values() if v.get("lane") == "local"]
    healthy = [v for v in local if v.get("healthy")]
    hf = len(healthy) / len(local) if local else 0.0
    elo = 1000 + (hf - 0.5) * 120
    # router-proof showed the local lane staying up when cloud keypools died
    elo += 10
    priors["llama-swap"] = {
        "elo": round(elo),
        "healthy_frac": round(hf, 3),
        "healthy_n": len(healthy),
        "n_models": len(local),
        "lane": "local",
        "basis": "model-max+router-proof",
    }
    sources["model_max"] = {
        "path": os.path.relpath(MODELMAX, REPO),
        "n_models": len(local),
        "lane": "local",
        "instrument": "liveness: 1 real completion/model, semantic-failure aware",
    }

    # --- 3. router-proof: router-level, not per-provider --------------------
    rp = load_json(ROUTERPROOF)
    summ = rp.get("summary", {})
    a = summ.get("A_intelligent", {})
    sources["router_proof"] = {
        "path": os.path.relpath(ROUTERPROOF, REPO),
        "run_ts": rp.get("started"),
        "design": "intelligent :25104 vs dumb :25100, 180 requests + 60 judge calls",
        "verdict": ("intelligent wins on availability "
                    f"(exact {a.get('exact', {}).get('success_rate')}, "
                    f"quality {a.get('quality', {}).get('success_rate')}, "
                    f"code {a.get('code', {}).get('success_rate')}); "
                    "failover under dead keypool, not per-model quality"),
    }

    # --- unbenched providers stay flat --------------------------------------
    for p in ROUTER_PROVIDERS:
        if p not in priors:
            priors[p] = {"elo": 1000, "basis": "unbenched"}

    doc = {
        "generated_ts": datetime.now(timezone.utc).isoformat(),
        "sources": sources,
        "priors": priors,
        "elo_rule": ("quality_mean(0-2)->1000+(q-1)*80; "
                     "local-lane healthy_frac->1000+(hf-0.5)*120; "
                     "router-proof local-lane availability +10; "
                     "latency excluded from priors (live candidateScore owns it); "
                     "live outcomes keep updating Elo"),
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=2)
    print("wrote", OUT)
    for p, pr in priors.items():
        print(f"  {p:12s} elo={pr['elo']:4d} basis={pr['basis']}")


if __name__ == "__main__":
    main()
