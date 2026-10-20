#!/usr/bin/env python3
"""
Model Health Checker for Estate AST Matrix
Tests all configured models, handles rate limits, persists results to DB.
"""
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# ─── Load secrets from ~/.secrets ──────────────────────────────────────────
def _load_secrets() -> None:
    for path in (os.path.expanduser("~/.secrets"), "/home/toxic/.secrets"):
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("export "):
                        line = line[7:]
                    if "=" in line:
                        k, v = line.split("=", 1)
                        k, v = k.strip(), v.strip().strip("'\"")
                        if k and v:
                            os.environ.setdefault(k, v)
        except FileNotFoundError:
            pass

_load_secrets()

# ─── Imports after secrets loaded ──────────────────────────────────────────
sys.path.insert(0, "/home/toxic/estate/tools/ast-matrix/estate-ast-matrix")
from router import (
    PROVIDER_MODELS,
    PROVIDERS,
    key_ok,
    state,
    DB,
    MAX_PARALLEL,
)

# ─── Configuration ─────────────────────────────────────────────────────────
MAX_WORKERS = 2
MAX_RETRIES = 2
RATE_LIMIT_DELAY = 3.0  # seconds between calls to same provider

# Known free-tier models per provider
FREE_TIER_MODELS: dict[str, list[str]] = {
    "openrouter": [
        "tencent/hy3:free",
        "poolside/laguna-m.1:free",
        "poolside/laguna-xs-2.1:free",
        "qwen/qwen3-coder:free",
        "google/gemma-4-31b-it:free",
        "google/gemma-4-26b-a4b-it:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3-nano-30b-a3b:free",
        "cohere/north-mini-code:free",
        "openai/gpt-oss-20b:free",
    ],
    "nvidia": [],  # NIM uses credits, not free tier
    "groq": [
        "llama-3.3-70b-versatile",
        "llama-3.1-70b-versatile",
        "mixtral-8x7b-32768",
        "gemma2-9b-it",
    ],
    "cerebras": [
        "zai-glm-4.7",
        "gemma-4-31b",
        "gpt-oss-120b",
    ],
    "google": [
        "gemini-2.0-flash",
        "gemini-2.5-flash",
    ],
    "mistral": [
        "mistral-medium-2505",
        "mistral-medium-2508",
        "open-mistral-nemo",
    ],
}

# Context window limits (approximate)
CONTEXT_LIMITS: dict[str, str] = {
    "tencent/hy3:free": "32k",
    "poolside/laguna-m.1:free": "32k",
    "poolside/laguna-xs-2.1:free": "32k",
    "qwen/qwen3-coder:free": "32k",
    "google/gemma-4-31b-it:free": "8k",
    "google/gemma-4-26b-a4b-it:free": "8k",
    "nvidia/nemotron-3-super-120b-a12b:free": "8k",
    "nvidia/nemotron-3-nano-30b-a3b:free": "8k",
    "cohere/north-mini-code:free": "4k",
    "openai/gpt-oss-20b:free": "4k",
    "nvidia/nemotron-3-super-120b-a12b": "256k",
    "nvidia/nemotron-3-nano-30b-a3b": "256k",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5": "256k",
    "nvidia/llama-3.1-nemotron-ultra-253b-v1": "256k",
    "thinkingmachines/inkling": "8192",
    "meta/llama-3.3-70b-instruct": "128k",
    "meta/llama-3.1-70b-instruct": "128k",
    "qwen/qwen3.5-397b-a17b": "32k",
    "qwen/qwen3.5-122b-a10b": "32k",
    "deepseek-ai/deepseek-v4-pro": "64k",
    "deepseek-ai/deepseek-v4-flash": "64k",
    "mistralai/mistral-large-2-instruct": "128k",
    "mistralai/mistral-large-3-675b-instruct-2512": "128k",
    "google/gemma-4-31b-it": "8k",
    "z-ai/glm-5.2": "32k",
    "llama-3.3-70b-versatile": "128k",
    "llama-3.1-70b-versatile": "128k",
    "mixtral-8x7b-32768": "32k",
    "gemma2-9b-it": "8k",
    "llama3.1-70b": "8192",
    "qwen-3-235b": "8192",
    "gemini-2.0-flash": "1M",
    "gemini-2.5-flash": "1M",
    "gemini-2.5-pro": "2M",
    "mistral-large-latest": "128k",
    "codestral-latest": "32k",
    "mistral-small-latest": "32k",
}


# ─── Core test function ────────────────────────────────────────────────────
def test_model(provider: str, model: str) -> dict[str, Any]:
    """Test a single model, return result dict."""
    if not state.circuit_ok(provider):
        return {"ok": False, "provider": provider, "model": model, "err": "circuit_open", "status": 503}
    
    conf = PROVIDERS[provider]
    url = conf["base"].rstrip("/") + "/chat/completions"
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.getenv(conf['key_env'], '')}",
    }
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://zed.dev"
        headers["X-Title"] = "Estate-AST-Matrix"
    if "key_env_alt" in conf:
        alt = os.getenv(conf["key_env_alt"], "")
        if alt and not headers["Authorization"].endswith("Bearer "):
            headers["Authorization"] = f"Bearer {alt}"
    
    data = json.dumps({"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 10}).encode()
    
    last_result = None
    for attempt in range(MAX_RETRIES + 1):
        start = time.time()
        try:
            req = Request(url, data=data, headers=headers, method="POST")
            resp = urlopen(req, timeout=30)
            latency = time.time() - start
            body = resp.read()
            last_result = {
                "ok": True,
                "provider": provider,
                "model": model,
                "latency": latency,
                "status": resp.status,
                "ctx": CONTEXT_LIMITS.get(model, "?"),
            }
            return last_result
        except HTTPError as e:
            latency = time.time() - start
            body = e.read().decode()[:500] if e.fp else ""
            last_result = {
                "ok": False,
                "provider": provider,
                "model": model,
                "latency": latency,
                "status": e.code,
                "err": f"HTTP {e.code}: {body}",
                "ctx": CONTEXT_LIMITS.get(model, "?"),
            }
            if e.code == 429:
                retry_after = float(e.headers.get("Retry-After", RATE_LIMIT_DELAY))
                time.sleep(min(retry_after, 30))
                continue
            if e.code >= 500:
                time.sleep(2 ** attempt)
                continue
            return last_result
        except Exception as e:
            latency = time.time() - start
            last_result = {
                "ok": False,
                "provider": provider,
                "model": model,
                "latency": latency,
                "status": 0,
                "err": str(e)[:200],
                "ctx": CONTEXT_LIMITS.get(model, "?"),
            }
            time.sleep(1)
    
    return last_result


# ─── Main check loop ───────────────────────────────────────────────────────
def check_all_models() -> dict[str, dict]:
    """Run tests across all providers/models."""
    print(f"Model check started at {time.ctime()}")
    print(f"DB: {DB}")
    print("=" * 70)
    
    # Build task list
    tasks = []
    for provider, models in PROVIDER_MODELS.items():
        if not key_ok(provider):
            print(f"Skipping {provider}: no API key")
            continue
        for model in models:
            tasks.append((provider, model))
    
    print(f"Testing {len(tasks)} models across {len([p for p in PROVIDER_MODELS if key_ok(p)])} providers\n")
    
    results = {}
    provider_last_call: dict[str, float] = {}
    
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {}
        
        # Submit with per-provider rate limiting
        for provider, model in tasks:
            now = time.time()
            last = provider_last_call.get(provider, 0)
            if now - last < RATE_LIMIT_DELAY:
                time.sleep(RATE_LIMIT_DELAY - (now - last))
            
            fut = ex.submit(test_model, provider, model)
            futures[fut] = (provider, model)
            provider_last_call[provider] = time.time()
        
        # Collect results
        for fut in as_completed(futures):
            provider, model = futures[fut]
            result = fut.result()
            key = f"{provider}/{model}"
            results[key] = result
            
            status = "✓" if result.get("ok") else "✗"
            latency = result.get("latency", 0)
            err = result.get("err", "")[:80]
            ctx = result.get("ctx", "?")
            free = "FREE" if model in FREE_TIER_MODELS.get(provider, []) else "paid"
            
            print(f"  {status} {key:<50} ctx={ctx:<7} {free:<5} {latency:.2f}s {err}")
    
    return results


def save_results(results: dict) -> None:
    """Save results to JSON file and update DB."""
    out_path = "/home/toxic/estate/var/data/model_check_results.json"
    with open(out_path, "w") as f:
        json.dump({"timestamp": time.time(), "results": results}, f, indent=2)
    print(f"\nResults saved to {out_path}")
    
    # Update health DB
    for key, r in results.items():
        provider = r["provider"]
        model = r["model"]
        status = 200 if r.get("ok") else r.get("status", 500)
        latency = r.get("latency", 0)
        state.health.record_request(provider, model, status, latency * 1000, strategy="model_check")
        if status == 429:
            state.health.record_rate_limit(provider, model, status)
    print("DB updated.")


def print_summary(results: dict) -> None:
    """Print final summary."""
    print("\n" + "=" * 80)
    print("MODEL CHECK SUMMARY")
    print("=" * 80)
    
    working = [(k, v) for k, v in results.items() if v.get("ok")]
    failed = [(k, v) for k, v in results.items() if not v.get("ok")]
    
    print(f"\n✅ WORKING ({len(working)}):")
    for k, v in working:
        ctx = v.get("ctx", "?")
        free = "FREE" if v["model"] in FREE_TIER_MODELS.get(v["provider"], []) else "paid"
        print(f"  {k:<50} ctx={ctx:<7} {free:<5} {v['latency']:.2f}s")
    
    print(f"\n❌ FAILED ({len(failed)}):")
    for k, v in failed:
        err = v.get("err", "unknown")[:100]
        print(f"  {k:<50} status={v.get('status','?')} {err}")
    
    print("\n📊 PER PROVIDER:")
    for provider in PROVIDER_MODELS:
        if not key_ok(provider):
            continue
        p_models = PROVIDER_MODELS[provider]
        p_working = [m for m in p_models if results.get(f"{provider}/{m}", {}).get("ok")]
        p_free = [m for m in p_working if m in FREE_TIER_MODELS.get(provider, [])]
        print(f"  {provider:<12} total={len(p_models):<2} working={len(p_working):<2} free={len(p_free)}")


if __name__ == "__main__":
    results = check_all_models()
    save_results(results)
    print_summary(results)
    sys.exit(0 if any(r.get("ok") for r in results.values()) else 1)
