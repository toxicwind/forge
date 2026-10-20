#!/usr/bin/env python3
"""
Long-context engagement probe — needle-in-haystack retrieval at 100k / 500k / 1M tokens.

Built per oracle verdict DECISION 12097 (mission 4e621a18): the 1m-context promotion
is only decidable with passing probe data. This script is the probe.

Usage:
    python3 long-context-probe.py --lane nvidia --model nvidia/nemotron-3-super-120b-a12b \
        --size 100k --db /home/toxic/estate/data/ast_matrix.db --session 1m-probe-<id>
    python3 long-context-probe.py --lane nvidia --model ... --size ping   # tiny liveness ping

Lanes:
    nvidia      -> https://integrate.api.nvidia.com/v1  (key: $NVIDIA_API_KEY)
    openrouter  -> https://openrouter.ai/api/v1        (key: $OPENROUTER_API_KEY_FREE,
                                                        fallback $OPENROUTER_API_KEY_1)

Method: a synthetic haystack of ~4 chars/token is built (seeded RNG, reproducible),
a unique secret passphrase ("needle") is embedded at ~45% depth, and the model is
asked to output ONLY the passphrase. Accuracy = exact substring match of the secret
in the response. Sizes run 100k -> 500k -> 1m; if a size fails for a context-related
reason (4xx context_length_exceeded etc.) larger sizes are skipped — a lane that
cannot do 100k cannot do 1M.

Results are recorded BOTH as a JSON run record (stdout + --runs-dir file) AND as a
row in the router's health DB `requests` table (same schema as router winner rows:
ts, provider, model, status, latency_ms, strategy='longctx-probe', winner=1/0,
session_id). winner=1 means the lane completed the run with accurate retrieval
(solo race); winner=0 otherwise. strategy/session_id keep probe rows attributable
so they never silently pollute race-eval statistics.

Secrets never leave the machine: keys are read from the environment, never logged,
never written into run records.

Exit codes: 0 = run completed and recorded (even on lane failure — failure is
evidence); 2 = usage/config error (missing key, unknown lane).
"""

import argparse
import hashlib
import json
import os
import random
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

SIZES = {"ping": 0, "100k": 100_000, "500k": 500_000, "1m": 1_000_000}
CHARS_PER_TOKEN = 4.0  # approximation; reported as such
TIMEOUT_S = {"ping": 90, "100k": 300, "500k": 600, "1m": 1500}
MAX_TOKENS_OUT = 2048

LANES = {
    "nvidia": {
        "base": "https://integrate.api.nvidia.com/v1",
        "env": ["NVIDIA_API_KEY"],
        "provider": "nvidia",
    },
    "openrouter": {
        "base": "https://openrouter.ai/api/v1",
        "env": ["OPENROUTER_API_KEY_FREE", "OPENROUTER_API_KEY_1"],
        "provider": "openrouter",
    },
}

# Small vocabulary for synthetic haystack text. Deliberately plain so the needle
# stands out only by its exact secret, not by style.
_WORDS = (
    "river stone cloud paper lantern market garden signal tower bridge field "
    "harbor engine wheel clock feather ink copper drum bell rope sail anchor "
    "meadow orchard willow sparrow foxglove amber slate moss birch alder elm "
    "cinder ember frost dew mist rain snow hail thunder spring autumn winter "
    "harvest sowing reaping threshing milling baking brewing weaving dyeing "
    "carving turning joining planing sanding oiling polishing hammer anvil "
    "tongs forge bellows quench temper grind hone strop shear clip comb brush "
    "ledger invoice tally count measure weigh gauge plumb level square bevel "
    "compass chart atlas globe orbit comet meteor aurora eclipse solstice "
).split()


def build_haystack(target_tokens: int, secret: str, seed: int):
    """Return (haystack_text, needle_char_offset, total_chars)."""
    rng = random.Random(seed)
    target_chars = int(target_tokens * CHARS_PER_TOKEN)
    paras = []
    chars = 0
    while chars < target_chars:
        n_words = rng.randint(40, 90)
        para = " ".join(rng.choice(_WORDS) for _ in range(n_words)).capitalize() + "."
        paras.append(para)
        chars += len(para) + 2
    needle_para = (
        f"The secret passphrase is {secret}. "
        f"Write it down: the secret passphrase is {secret}."
    )
    # Insert at ~45% depth by character count.
    total = sum(len(p) + 2 for p in paras)
    acc = 0
    idx = len(paras) - 1
    for i, p in enumerate(paras):
        acc += len(p) + 2
        if acc >= total * 0.45:
            idx = i
            break
    paras.insert(idx, needle_para)
    text = "\n\n".join(paras)
    offset = sum(len(p) + 2 for p in paras[:idx])
    return text, offset, len(text)


def make_secret(run_tag: str) -> str:
    digest = hashlib.sha256(run_tag.encode()).hexdigest().upper()
    return "QX" + re.sub(r"[^A-Z0-9]", "", digest)[:10]


def post_chat(base: str, key: str, model: str, prompt: str, timeout_s: int):
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": MAX_TOKENS_OUT,
        }
    ).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://estate.local/probe",
            "X-Title": "estate-longctx-probe",
        },
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            latency_ms = (time.monotonic() - t0) * 1000
            payload = json.loads(resp.read().decode("utf-8", "replace"))
            return 200, latency_ms, payload, None
    except urllib.error.HTTPError as e:
        latency_ms = (time.monotonic() - t0) * 1000
        try:
            err_body = e.read().decode("utf-8", "replace")[:2000]
        except Exception:
            err_body = ""
        return e.code, latency_ms, None, err_body
    except Exception as e:  # timeout, DNS, TLS, connection reset...
        latency_ms = (time.monotonic() - t0) * 1000
        return None, latency_ms, None, f"{type(e).__name__}: {e}"


def classify(status, err_body, accurate):
    """Return (outcome, error_class). outcome in ok|retrieval_fail|lane_down|
    credit_dead|rate_limited|context_too_big|timeout|error."""
    if status == 200:
        return ("ok" if accurate else "retrieval_fail",
                None if accurate else "wrong_or_missing_needle")
    if status == 402:
        return "credit_dead", "http_402_insufficient_credits"
    if status == 429:
        return "rate_limited", "http_429"
    if status in (400, 413, 422):
        blob = (err_body or "").lower()
        if "context" in blob or "too long" in blob or "max" in blob and "token" in blob:
            return "context_too_big", f"http_{status}_context"
        return "lane_down", f"http_{status}_client"
    if status and 500 <= status < 600:
        return "lane_down", f"http_{status}_upstream"
    if status is None:
        if err_body and "Timeout" in err_body:
            return "timeout", "timeout"
        return "error", "transport_error"
    return "error", f"http_{status}"


def record_db(db_path, provider, model, status, latency_ms, winner, session_id):
    if not db_path:
        return "skipped (no --db)"
    code = status if isinstance(status, int) else (599 if status is None else 598)
    con = sqlite3.connect(db_path, timeout=30)
    try:
        con.execute("PRAGMA busy_timeout=30000")
        con.execute(
            "INSERT INTO requests (ts, provider, model, status, latency_ms, strategy, winner, session_id)"
            " VALUES (?, ?, ?, ?, ?, 'longctx-probe', ?, ?)",
            (time.time(), provider, model, code, latency_ms, winner, session_id),
        )
        con.commit()
        return "recorded"
    finally:
        con.close()


def run(args):
    lane = LANES[args.lane]
    key = next((os.environ.get(v) for v in lane["env"] if os.environ.get(v)), None)
    if not key:
        print(f"missing key: none of {lane['env']} set in environment", file=sys.stderr)
        return 2

    target_tokens = SIZES[args.size]
    run_tag = f"{args.session}/{args.lane}/{args.model}/{args.size}"
    secret = make_secret(run_tag)

    if args.size == "ping":
        prompt = args.prompt_text or "Reply with exactly the word PONG and nothing else."
        haystack_chars = 0
        needle_offset = 0
    else:
        seed = int(hashlib.sha256(run_tag.encode()).hexdigest()[:8], 16)
        haystack, needle_offset, haystack_chars = build_haystack(target_tokens, secret, seed)
        prompt = (
            "You are given a long document below. Find the secret passphrase hidden in it.\n\n"
            f"DOCUMENT:\n{haystack}\n\n"
            "QUESTION: What is the secret passphrase? Output ONLY the passphrase, nothing else. "
            "Do not explain."
        )

    status, latency_ms, payload, err_body = post_chat(
        lane["base"], key, args.model, prompt, TIMEOUT_S[args.size]
    )

    text = ""
    if payload:
        try:
            text = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            text = ""
    accurate = (
        bool(text.strip())
        if (args.size == "ping" and args.prompt_text)
        else (bool(secret) and secret in text if args.size != "ping" else ("PONG" in text.upper()))
    )
    outcome, error_class = classify(status, err_body, accurate)
    winner = 1 if outcome == "ok" else 0

    record = {
        "run_tag": run_tag,
        "session": args.session,
        "lane": args.lane,
        "provider": lane["provider"],
        "model": args.model,
        "size": args.size,
        "target_tokens": target_tokens,
        "token_basis": f"chars/{CHARS_PER_TOKEN} approximation",
        "haystack_chars": haystack_chars,
        "needle_char_offset": needle_offset,
        "secret_sha256": hashlib.sha256(secret.encode()).hexdigest(),
        "latency_ms": round(latency_ms, 1),
        "http_status": status,
        "outcome": outcome,
        "error_class": error_class,
        "error_body": (err_body or "")[:500],
        "accurate": accurate,
        "response_head": text[:200],
        "db": record_db(args.db, lane["provider"], args.model, status, latency_ms, winner, args.session),
        "winner": winner,
    }

    if args.runs_dir:
        os.makedirs(args.runs_dir, exist_ok=True)
        fname = re.sub(r"[^A-Za-z0-9_.-]", "_", run_tag) + ".json"
        with open(os.path.join(args.runs_dir, fname), "w") as f:
            json.dump(record, f, indent=2)

    print(json.dumps(record, indent=2))
    return 0


def main():
    ap = argparse.ArgumentParser(description="Long-context needle-in-haystack probe.")
    ap.add_argument("--lane", required=True, choices=list(LANES))
    ap.add_argument("--model", required=True)
    ap.add_argument("--size", required=True, choices=list(SIZES))
    ap.add_argument("--db", default="")
    ap.add_argument("--session", required=True)
    ap.add_argument("--runs-dir", default="")
    ap.add_argument("--prompt-text", default="",
                    help="ping mode only: override the tiny liveness prompt")
    args = ap.parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
