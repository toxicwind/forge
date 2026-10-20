# ⚠️  DEPRECATED 2026-10-04 — superseded by Rust flock on :25193.
# Kept for reference; do not deploy. See flock-ssot/ROUTER_CANON.md.
from __future__ import annotations
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from router_config import CODING, DB, MAX_PARALLEL, PORT, PROVIDER_MODELS, PROVIDERS, STRATEGY, key_ok
from router_matrix import state
from router_strategy import ROUTERS, call_one_stream, pick_weighted, route_hybrid
from router_types import ChatBody




# ---------------------------------------------------------------------------
# Streaming SSE proxy
# ---------------------------------------------------------------------------
def proxy_stream(
    resp: Any,
    handler: "H",
    provider: str,
    model: str,
) -> None:
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("X-Routed-Via", f"{provider}/{model}")
    handler.end_headers()
    try:
        while True:
            chunk: bytes = resp.read(4096)
            if not chunk:
                break
            handler.wfile.write(chunk)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        resp.close()




# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class H(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        import sys
        print(f"[matrix] {format % args}", file=sys.stderr)

    def do_GET(self) -> None:
        if self.path in ("/v1/models", "/models"):
            ms: list[dict[str, str]] = [{"id": k, "object": "model"} for k in CODING]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"object": "list", "data": ms}).encode())
        elif self.path == "/health":
            key_status: dict[str, str] = {}
            for p in PROVIDERS:
                key_status[p] = "configured" if key_ok(p) else "no_key"
            # Merge DB health scores
            db_summary = state.health.get_provider_summary()
            providers_data: dict[str, dict[str, Any]] = {}
            for p in PROVIDERS:
                pd: dict[str, Any] = {
                    "keys": key_status[p],
                    "elo": round(state.elo.get(p, 1000), 1),
                    "circuit": state.circuit.get(p, "unknown"),
                    "models": len(PROVIDER_MODELS.get(p, [])),
                }
                if p in db_summary:
                    pd["health"] = db_summary[p]
                providers_data[p] = pd
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "status": "ok",
                        "router": "estate-ast-matrix",
                        "version": "v3.1",
                        "strategy": STRATEGY,
                        "parallel": MAX_PARALLEL,
                        "providers": providers_data,
                    }
                ).encode()
            )
        elif self.path == "/debug/sqlite":
            try:
                rows = state.health.conn.execute(
                    "SELECT model, provider, status, count(*), avg(latency_ms)"
                    " FROM requests GROUP BY model, provider, status"
                    " ORDER BY count(*) DESC LIMIT 20"
                ).fetchall()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(rows).encode())
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == "/debug/health":
            try:
                summary = state.health.get_provider_summary()
                healing: dict[str, list[dict[str, Any]]] = {}
                for p in PROVIDERS:
                    healing[p] = state.health.get_recent_healing(p)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "summary": summary,
                            "healing": healing,
                        }
                    ).encode()
                )
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:
        if "/chat/completions" not in self.path:
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length", 0))
        body: ChatBody = json.loads(self.rfile.read(n) or b"{}")
        sid = (
            self.headers.get("X-Session-Id")
            or hashlib.md5(
                json.dumps(body.get("messages", [])[:1]).encode()
            ).hexdigest()[:12]
        )
        strat = self.headers.get("X-Estate-Strategy", STRATEGY)
        is_stream: bool = body.get("stream", False)
        if is_stream:
            self._handle_stream(body, sid, strat)
        else:
            self._handle_sync(body, sid, strat)

    def _handle_sync(self, body: ChatBody, sid: str, strat: str) -> None:
        fn = ROUTERS.get(strat, route_hybrid)
        r = fn(body, sid)
        if r.get("ok"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Routed-Via", f"{r['provider']}/{r['model']}")
            self.send_header("X-Latency", str(round(r.get("lat", 0), 3)))
            self.send_header("X-Strategy", strat)
            self.end_headers()
            self.wfile.write(r["data"])
        else:
            self.send_response(r.get("status", 503))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "error": r.get("err", "exhausted"),
                        "status": r.get("status"),
                    }
                ).encode()
            )

    def _handle_stream(self, body: ChatBody, sid: str, strat: str) -> None:
        model = body.get("model", "auto")
        # FIX: Explicit model -> skip sticky, route to correct provider
        if model in CODING and CODING[model] is not None:
            pair = CODING[model]
            assert pair is not None
            p, mid = pair
            r = call_one_stream(p, mid, body)
            if r.get("ok"):
                state.sticky_set(sid, p, mid)
                proxy_stream(r["resp"], self, p, mid)
                return
        else:
            # auto/fcm: try sticky first
            sp, sm = state.sticky_get(sid)
            if sp is not None and key_ok(sp) and state.circuit_ok(sp):
                r = call_one_stream(sp, sm or model, body)
                if r.get("ok"):
                    state.sticky_set(sid, sp, r["model"])
                    proxy_stream(r["resp"], self, sp, r["model"])
                    return
        candidates: list[tuple[str, str]] = []
        if model in CODING and CODING[model] is not None:
            pair = CODING[model]
            assert pair is not None
            candidates = [pair]
        else:
            candidates = pick_weighted(MAX_PARALLEL)
        for p, mid in candidates:
            r = call_one_stream(p, mid, body)
            if r.get("ok"):
                state.sticky_set(sid, p, mid)
                proxy_stream(r["resp"], self, p, mid)
                return
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({"error": "all_stream_providers_exhausted"}).encode()
        )




def main() -> None:
    print(f"Estate AST Matrix v3.1 on http://127.0.0.1:{PORT}/v1")
    print(
        f"Strategy={STRATEGY} | 5 routes: fifo_matrix, ast_race, sticky_affinity,"
        f" weighted_elo, circuit_chain (+ hybrid)"
    )
    print(
        f"Streaming=SSE proxy | Providers: {', '.join(p for p in PROVIDERS if key_ok(p))}"
    )
    print(
        "No local GPU. Cloud-only: NVIDIA NIM + OpenRouter + Groq + Cerebras + Google + Mistral"
    )
    print(f"Health DB: {DB} (WAL mode)")

    # Periodic cleanup every hour
    def _cleanup() -> None:
        while True:
            time.sleep(3600)
            _ = state.health.cleanup_old(days=7)

    t = threading.Thread(target=_cleanup, daemon=True)
    t.start()
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
