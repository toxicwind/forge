from __future__ import annotations
import json
import queue
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FutTimeout
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from router_config import AST_RE, CODING, MAX_PARALLEL, PROVIDER_MODELS, PROVIDERS, STRATEGY, first_model_for, get_key, is_ast, key_ok, resolve_model
from router_matrix import state
from router_types import ChatBody, RouteResult




# ---------------------------------------------------------------------------
# Provider call - supports streaming
# ---------------------------------------------------------------------------
def call_one(provider: str, model: str, body: ChatBody) -> RouteResult:
    if not state.circuit_ok(provider):
        return {
            "ok": False,
            "status": 503,
            "provider": provider,
            "lat": 0,
            "err": "circuit_open",
        }
    conf = PROVIDERS[provider]
    url = conf["base"].rstrip("/") + "/chat/completions"
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {get_key(provider)}",
        "User-Agent": "Mozilla/5.0 (compatible; EstateASTMatrix/3.1)",
    }
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://zed.dev"
        headers["X-Title"] = "Estate-AST-Matrix"
    start = time.time()
    try:
        req = Request(url, data=data, headers=headers, method="POST")
        resp = urlopen(req, timeout=120)
        lat = time.time() - start
        is_stream: bool = body.get("stream", False)
        if is_stream:
            return {
                "ok": True,
                "status": resp.status,
                "resp": resp,
                "provider": provider,
                "model": model,
                "lat": lat,
                "stream": True,
            }
        raw = resp.read()
        state.record(model, provider, resp.status, lat, strategy=STRATEGY)
        if state.circuit.get(provider) == "half":
            state.circuit[provider] = "closed"
        return {
            "ok": True,
            "status": resp.status,
            "data": raw,
            "provider": provider,
            "model": model,
            "lat": lat,
        }
    except HTTPError as e:
        lat = time.time() - start
        state.record(model, provider, e.code, lat, strategy=STRATEGY)
        return {
            "ok": False,
            "status": e.code,
            "provider": provider,
            "lat": lat,
            "err": str(e.read()[:500]),
        }
    except Exception as e:
        lat = time.time() - start
        state.record(model, provider, 500, lat, strategy=STRATEGY)
        return {
            "ok": False,
            "status": 500,
            "provider": provider,
            "lat": lat,
            "err": str(e),
        }




def call_one_stream(provider: str, model: str, body: ChatBody) -> RouteResult:
    if not state.circuit_ok(provider):
        return {
            "ok": False,
            "status": 503,
            "provider": provider,
            "lat": 0,
            "err": "circuit_open",
        }
    conf = PROVIDERS[provider]
    url = conf["base"].rstrip("/") + "/chat/completions"
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {get_key(provider)}",
        "User-Agent": "Mozilla/5.0 (compatible; EstateASTMatrix/3.1)",
    }
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://zed.dev"
        headers["X-Title"] = "Estate-AST-Matrix"
    stream_body: ChatBody = {**body, "model": model, "stream": True}
    data = json.dumps(stream_body).encode()
    start = time.time()
    try:
        req = Request(url, data=data, headers=headers, method="POST")
        resp = urlopen(req, timeout=180)
        lat = time.time() - start
        state.record(model, provider, 200, lat, strategy=STRATEGY)
        if state.circuit.get(provider) == "half":
            state.circuit[provider] = "closed"
        return {
            "ok": True,
            "status": resp.status,
            "resp": resp,
            "provider": provider,
            "model": model,
            "lat": lat,
            "stream": True,
        }
    except HTTPError as e:
        lat = time.time() - start
        state.record(model, provider, e.code, lat, strategy=STRATEGY)
        return {
            "ok": False,
            "status": e.code,
            "provider": provider,
            "lat": lat,
            "err": str(e.read()[:500]),
        }
    except Exception as e:
        lat = time.time() - start
        state.record(model, provider, 500, lat, strategy=STRATEGY)
        return {
            "ok": False,
            "status": 500,
            "provider": provider,
            "lat": lat,
            "err": str(e),
        }




# ---------------------------------------------------------------------------
# Strategy: pick weighted candidates (ELO + jitter, no dead providers)
# ---------------------------------------------------------------------------
def pick_weighted(n: int = MAX_PARALLEL) -> list[tuple[str, str]]:
    scored: list[tuple[float, str, str]] = []
    for p in PROVIDERS:
        if not key_ok(p) or not state.circuit_ok(p):
            continue
        sc = state.elo.get(p, 1000) + random.random() * 10
        mid = first_model_for(p)
        if mid:
            scored.append((sc, p, mid))
    scored.sort(reverse=True)
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for _, p, mid in scored:
        if p not in seen:
            seen.add(p)
            out.append((p, mid))
        if len(out) >= n:
            break
    if not out and key_ok("openrouter"):
        out = [("openrouter", "tencent/hy3:free")]
    return out




# ---------------------------------------------------------------------------
# Strategy routes
# ---------------------------------------------------------------------------
def route_ast_race(body: ChatBody, session: str) -> RouteResult:
    model = body.get("model", "auto")
    # FIX: Explicit model -> route to THAT provider only, no race, no fallthrough
    if model in CODING and CODING[model] is not None:
        pair = CODING[model]
        assert pair is not None
        p, mid = pair
        r = call_one(p, mid, body)
        if r.get("ok"):
            state.sticky_set(session, p, mid)
            state.record(mid, p, 200, r["lat"], winner=1, strategy="ast_race")
        return r
    # auto/fcm/unknown: race across providers
    cands = pick_weighted(MAX_PARALLEL)
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as ex:
        futs = {ex.submit(call_one, p, mid, body): (p, mid) for p, mid in cands}
        best: RouteResult | None = None
        try:
            for fut in as_completed(futs, timeout=95):
                r = fut.result()
                if not r.get("ok"):
                    continue
                try:
                    j = json.loads(r["data"])
                    content = (
                        j.get("choices", [{}])[0].get("message", {}).get("content", "")
                    )
                except Exception:
                    content = ""
                if is_ast(content):
                    state.sticky_set(session, r["provider"], r["model"])
                    state.record(
                        r["model"],
                        r["provider"],
                        200,
                        r["lat"],
                        winner=1,
                        strategy="ast_race",
                    )
                    return r
                if best is None:
                    best = r
        except FutTimeout:
            pass
        if best is not None:
            state.sticky_set(session, best["provider"], best["model"])
            return best
    return {"ok": False, "status": 503, "err": "ast_race_exhausted"}




def route_sticky(body: ChatBody, session: str) -> RouteResult:
    model = body.get("model", "auto")
    # FIX: Explicit model -> skip sticky, go direct
    if model in CODING and CODING[model] is not None:
        return route_ast_race(body, session)
    p, m = state.sticky_get(session)
    if p is not None and key_ok(p) and state.circuit_ok(p):
        r = call_one(p, m or model, body)
        if r.get("ok"):
            return r
    return route_ast_race(body, session)




def route_weighted(body: ChatBody, session: str) -> RouteResult:
    cands = pick_weighted(1)
    if not cands:
        return {"ok": False, "status": 503, "err": "no_providers"}
    p, mid = cands[0]
    r = call_one(p, mid, body)
    if r.get("ok"):
        state.sticky_set(session, p, mid)
    return r




def route_circuit_chain(body: ChatBody, session: str) -> RouteResult:
    model = body.get("model", "auto")
    # FIX: Explicit model -> try only that provider, don't cascade
    if model in CODING and CODING[model] is not None:
        pair = CODING[model]
        assert pair is not None
        p, mid = pair
        if key_ok(p) and state.circuit_ok(p):
            r = call_one(p, mid, body)
            if r.get("ok"):
                state.sticky_set(session, p, mid)
                return r
        return {"ok": False, "status": 502, "err": f"explicit_provider_unavailable:{p}"}
    # auto/fcm: cascade by ELO
    order = sorted(PROVIDERS.keys(), key=lambda p: -state.elo.get(p, 1000))
    for p in order:
        if not key_ok(p) or not state.circuit_ok(p):
            continue
        mid = first_model_for(p)
        if not mid:
            continue
        r = call_one(p, mid, body)
        if r.get("ok"):
            state.sticky_set(session, p, mid)
            return r
    return {"ok": False, "status": 503, "err": "circuit_chain_exhausted"}




def route_fifo(body: ChatBody, session: str) -> RouteResult:
    try:
        state.fifo.put_nowait(1)
    except queue.Full:
        return {"ok": False, "status": 429, "err": "fifo_full"}
    try:
        return route_ast_race(body, session)
    finally:
        try:
            state.fifo.get_nowait()
        except Exception:
            pass




def route_hybrid(body: ChatBody, session: str) -> RouteResult:
    model = body.get("model", "auto")
    # FIX: Explicit model -> resolve once, call directly, no sticky/cascade
    if model in CODING and CODING[model] is not None:
        p, mid = resolve_model(model)
        r = call_one(p, mid, body)
        if r.get("ok"):
            state.sticky_set(session, p, mid)
            state.record(mid, p, 200, r["lat"], winner=1, strategy="hybrid_direct")
            return r
        return r
    # auto/fcm: sticky -> ast_race -> circuit_chain
    p, m = state.sticky_get(session)
    if p is not None and key_ok(p) and state.circuit_ok(p):
        r = call_one(p, m or model, body)
        if r.get("ok"):
            return r
    r2 = route_ast_race(body, session)
    if r2.get("ok"):
        return r2
    return route_circuit_chain(body, session)




ROUTERS: dict[str, Any] = {
    "fifo_matrix": route_fifo,
    "ast_race": route_ast_race,
    "sticky_affinity": route_sticky,
    "weighted_elo": route_weighted,
    "circuit_chain": route_circuit_chain,
    "hybrid": route_hybrid,
}
