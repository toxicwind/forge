#!/usr/bin/env python3
"""provider-race: HFT-style concurrent racing for tool-capable model selection.

User's HFT doctrine applied to agent model routing (novel synthesis):
  - RACE redundant paths concurrently; FIRST VALID wins (hft_fetch.py lineage).
  - VALID = HTTP 200 AND the model actually emits tool_calls — capability-gated,
    not just liveness. This is the openfang pilot's exact blocker (fast=1.2B
    answers but cannot tool-call; a liveness race would crown a dud).
  - FAIL-FAST ceilings per candidate; losers cancelled, no retry spins.
  - WINNER LEDGER: every race appends ts/winner/per-candidate latencies —
    read it to keep the fast path hot.
  - STALE FALLBACK planned before the primary: last known-good winner is
    cached; if every live candidate fails, the cached winner returns flagged
    stale=True (fine for routing display, never for identity/security calls).

Usage:
  provider-race.py [--json] [--ceiling 15] [--candidates PATH]

Exit: 0 with winner on stdout (or JSON doc with --json); 2 if all failed
and no cached winner exists.
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys
import time
import urllib.request

SHINGLE = os.environ.get("SHINGLE_HOME", "/home/toxic/.fleet-bus")
VAR = os.path.join(SHINGLE, "var", "openfang-health")
LEDGER = os.path.join(VAR, "provider-race-winners.jsonl")
CACHE = os.path.join(VAR, "provider-race-winner.json")
DEFAULT_CANDIDATES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "race-candidates.json")

TOOL_PROBE = {
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Compute 17*23 using the calc tool."}],
    "tools": [{
        "type": "function",
        "function": {
            "name": "calc",
            "description": "evaluate an arithmetic expression",
            "parameters": {
                "type": "object",
                "properties": {"expr": {"type": "string"}},
                "required": ["expr"],
            },
        },
    }],
    "tool_choice": {"type": "function", "function": {"name": "calc"}},
}

BUILTIN_CANDIDATES = [
    {"name": "qwen3.5-9b-tool", "url": "http://127.0.0.1:25152/v1/chat/completions",
     "model": "qwen3.5-9b-tool"},
    {"name": "kimi-auto", "url": "http://127.0.0.1:25100/v1/chat/completions",
     "model": "kimi-auto"},
    {"name": "exaone-fast", "url": "http://127.0.0.1:25100/v1/chat/completions",
     "model": "beellama/exaone-4-0-1-2b-iq4xs"},
]


def probe(candidate, ceiling):
    """Return (ok, latency_ms, detail). ok requires a real tool_calls payload."""
    name = candidate["name"]
    body = dict(TOOL_PROBE)
    body["model"] = candidate["model"]
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json",
               "User-Agent": "provider-race/1.0"}
    if candidate.get("api_key_env"):
        key = os.environ.get(candidate["api_key_env"], "")
        if not key:
            return False, 0.0, "no key in env (name only)"
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(candidate["url"], data=data, headers=headers)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=ceiling) as r:
            payload = json.loads(r.read().decode())
        ms = (time.monotonic() - t0) * 1000
        msg = payload["choices"][0]["message"]
        tcs = msg.get("tool_calls") or []
        if tcs and tcs[0].get("function", {}).get("name") == "calc":
            return True, ms, "tool_calls ok"
        return False, ms, "no tool_calls (liveness-only dud)"
    except Exception as e:  # fail fast, fail loud (recorded, not raised)
        ms = (time.monotonic() - t0) * 1000
        return False, ms, f"{type(e).__name__}: {e}"


def race_full(candidates, ceiling):
    """All candidates run to completion; winner = fastest VALID. Full table."""
    results = {}
    with cf.ThreadPoolExecutor(max_workers=len(candidates)) as ex:
        futs = {ex.submit(probe, c, ceiling): c["name"] for c in candidates}
        for f in cf.as_completed(futs, timeout=ceiling + 10):
            name = futs[f]
            try:
                ok, ms, detail = f.result()
            except Exception as e:
                ok, ms, detail = False, 0.0, f"harness: {e}"
            results[name] = {"ok": ok, "latency_ms": round(ms, 1),
                             "detail": detail}
    valid = [(n, r["latency_ms"]) for n, r in results.items() if r["ok"]]
    winner = min(valid, key=lambda x: x[1])[0] if valid else None
    return winner, results


def race(candidates, ceiling):
    """Fire all candidates at once; first VALID wins. Returns (winner, results)."""
    results = {}
    winner = None
    with cf.ThreadPoolExecutor(max_workers=len(candidates)) as ex:
        futs = {ex.submit(probe, c, ceiling): c["name"] for c in candidates}
        deadline = time.monotonic() + ceiling + 5
        pending = set(futs)
        while pending and time.monotonic() < deadline:
            done, pending = cf.wait(pending, timeout=0.2,
                                    return_when=cf.FIRST_COMPLETED)
            for f in done:
                name = futs[f]
                try:
                    ok, ms, detail = f.result()
                except Exception as e:
                    ok, ms, detail = False, 0.0, f"harness: {e}"
                results[name] = {"ok": ok, "latency_ms": round(ms, 1),
                                 "detail": detail}
                if ok and winner is None:
                    winner = name
            if winner:
                for f in pending:
                    f.cancel()
                break
        for f in pending:  # record stragglers as lost
            name = futs[f]
            if name not in results:
                results[name] = {"ok": False, "latency_ms": None,
                                 "detail": "lost the race (cancelled)"}
            f.cancel()
    return winner, results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--ceiling", type=float, default=15.0)
    ap.add_argument("--candidates", default=DEFAULT_CANDIDATES)
    ap.add_argument("--full", action="store_true",
                    help="wait for every candidate; winner = fastest valid "
                         "(full latency table for the ledger)")
    args = ap.parse_args()

    os.makedirs(VAR, exist_ok=True)
    if os.path.isfile(args.candidates):
        candidates = json.load(open(args.candidates))
    else:
        candidates = BUILTIN_CANDIDATES

    t0 = time.monotonic()
    if args.full:
        winner, results = race_full(candidates, args.ceiling)
    else:
        winner, results = race(candidates, args.ceiling)
    race_ms = (time.monotonic() - t0) * 1000

    entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
             "winner": winner, "race_ms": round(race_ms, 1),
             "stale": False, "results": results}
    if winner:
        with open(CACHE, "w") as f:
            json.dump({"winner": winner, "ts": entry["ts"],
                       "latency_ms": results[winner]["latency_ms"]}, f)
    else:
        # stale fallback: planned before the primary
        if os.path.isfile(CACHE):
            cached = json.load(open(CACHE))
            entry["winner"] = cached["winner"]
            entry["stale"] = True
    with open(LEDGER, "a") as f:
        f.write(json.dumps(entry) + "\n")

    if args.json:
        print(json.dumps(entry, indent=2))
    else:
        print(entry["winner"] if entry["winner"] else "NO-WINNER")
    return 0 if entry["winner"] else 2


if __name__ == "__main__":
    sys.exit(main())
