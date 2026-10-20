#!/usr/bin/env python3
"""
Merged Free LLM Gateway for Zed (and any OpenAI client)
Synthesized from:
- MrFadiAi/free-llm-gateway (Python OpenAI compat + fallback + dashboard ideas + rate tracking)
- tashfeenahmed/freellmapi (TS routing strategies, sticky sessions, context handoff, encrypted keys, catalog)
- vava-nessa/free-coding-models (coding model focus, daemon OpenAI endpoint, tool install patterns, ~190 models catalog idea)

Instantly usable: run this, point Zed language_models openai api_url to http://127.0.0.1:19280/v1
Supports auto routing to free providers, fallback on 429/5xx, sticky sessions, coding-preferred models (Hy3, Laguna, Qwen3-Coder, Gemma4, Nemotron etc).
No external deps beyond stdlib + httpx/openai if available; pure for restricted boxes.
Save keys in .env or env vars. Expand providers as needed.
"""
import os, json, time, hashlib, threading, sqlite3, traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor
import random

PORT = int(os.getenv("FREE_GATEWAY_PORT", "19280"))
DB_PATH = os.getenv("FREE_GATEWAY_DB", "/tmp/free_zed_gateway.db")
STICKY_TTL = 1800  # 30 min like the sources
MAX_FALLBACKS = 8

# Coding-first free model aliases (merged from previous research + the three repos)
CODING_MODELS = {
    "auto": None,  # router decides
    "fcm": None,   # free-coding-models style virtual
    "hy3": ["tencent/hy3:free", "openrouter"],
    "laguna-m1": ["poolside/laguna-m.1:free", "openrouter"],
    "laguna-xs": ["poolside/laguna-xs-2.1:free", "openrouter"],
    "qwen3-coder": ["qwen/qwen3-coder:free", "openrouter"],
    "gemma4-31b": ["google/gemma-4-31b-it:free", "openrouter"],
    "gemma4-26b": ["google/gemma-4-26b-a4b-it:free", "openrouter"],
    "nemotron-super": ["nvidia/nemotron-3-super-120b-a12b:free", "openrouter"],
    "nemotron-nano": ["nvidia/nemotron-3-nano-30b-a3b:free", "openrouter"],
    "north-mini": ["cohere/north-mini-code:free", "openrouter"],
    "gpt-oss": ["openai/gpt-oss-20b:free", "openrouter"],
}

# Provider endpoints (expand with keys from env; free tiers from the three sources)
PROVIDERS = {
    "openrouter": {
        "base": "https://openrouter.ai/api/v1",
        "key_env": "OPENROUTER_API_KEY",
        "models": list(CODING_MODELS.keys()),
    },
    "groq": {
        "base": "https://api.groq.com/openai/v1",
        "key_env": "GROQ_API_KEY",
        "models": ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile"],
    },
    "cerebras": {
        "base": "https://api.cerebras.ai/v1",
        "key_env": "CEREBRAS_API_KEY",
        "models": ["llama3.1-70b", "qwen-3-235b"],
    },
    "nvidia": {
        "base": "https://integrate.api.nvidia.com/v1",
        "key_env": "NVIDIA_API_KEY",
        "models": ["meta/llama-3.1-70b-instruct", "nvidia/nemotron"],
    },
    "google": {
        "base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_env": "GOOGLE_API_KEY",
        "models": ["gemini-2.0-flash", "gemini-2.5-flash"],
    },
    "mistral": {
        "base": "https://api.mistral.ai/v1",
        "key_env": "MISTRAL_API_KEY",
        "models": ["mistral-large-latest", "codestral-latest"],
    },
    # Add more from freellmapi list as keys become available: cloudflare, cohere, together, fireworks, sambanova, etc.
    "local": {
        "base": os.getenv("LOCAL_LLM_URL", "http://127.0.0.1:8020/v1"),  # club3090 style
        "key_env": None,
        "models": ["*"],
    },
}

# Simple sticky + rate tracking (inspired by all three)
class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.sticky = {}  # session -> (provider, model, ts)
        self.failures = {}  # provider -> (count, last)
        self.init_db()

    def init_db(self):
        self.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        self.conn.execute("CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, ts REAL, model TEXT, provider TEXT, status INTEGER, latency REAL)")
        self.conn.commit()

    def record(self, model, provider, status, latency):
        with self.lock:
            self.conn.execute("INSERT INTO requests (ts, model, provider, status, latency) VALUES (?,?,?,?,?)",
                              (time.time(), model, provider, status, latency))
            self.conn.commit()

    def get_sticky(self, session):
        with self.lock:
            if session in self.sticky:
                p, m, ts = self.sticky[session]
                if time.time() - ts < STICKY_TTL:
                    return p, m
                del self.sticky[session]
        return None, None

    def set_sticky(self, session, provider, model):
        with self.lock:
            self.sticky[session] = (provider, model, time.time())

state = State()

def get_key(provider):
    env = PROVIDERS[provider].get("key_env")
    if not env:
        return "local"
    return os.getenv(env) or os.getenv(env.replace("_API_KEY", "")) or ""

def choose_provider(model, session=None):
    # Sticky first (from freellmapi + free-llm-gateway)
    if session:
        p, m = state.get_sticky(session)
        if p and get_key(p):
            return p, m or model
    # Coding preference + healthy (merged ranking)
    candidates = []
    for pname, pconf in PROVIDERS.items():
        if not get_key(pname) and pname != "local":
            continue
        if model in ("auto", "fcm") or model in pconf.get("models", []) or "*" in pconf.get("models", []):
            fail = state.failures.get(pname, (0, 0))
            score = 100 - fail[0] * 10 + random.random()  # simple reliable + balanced
            if "openrouter" in pname and model in CODING_MODELS:
                score += 50  # prefer for our free coding models
            candidates.append((score, pname, model if model not in ("auto", "fcm") else (CODING_MODELS.get(model) or ["hy3"])[0] if isinstance(CODING_MODELS.get(model), list) else "hy3"))
    if not candidates:
        return "openrouter", "tencent/hy3:free"
    candidates.sort(reverse=True)
    return candidates[0][1], candidates[0][2]

def proxy_request(provider, model, body, headers):
    pconf = PROVIDERS[provider]
    key = get_key(provider)
    url = pconf["base"].rstrip("/") + "/chat/completions"
    req_headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    if provider == "openrouter":
        req_headers["HTTP-Referer"] = "https://zed.dev"
        req_headers["X-Title"] = "Zed Free Gateway"
    data = json.dumps({**body, "model": model}).encode()
    start = time.time()
    try:
        req = Request(url, data=data, headers=req_headers, method="POST")
        with urlopen(req, timeout=120) as resp:
            out = resp.read()
            latency = time.time() - start
            state.record(model, provider, resp.status, latency)
            return resp.status, out, dict(resp.headers)
    except HTTPError as e:
        latency = time.time() - start
        state.record(model, provider, e.code, latency)
        with state.lock:
            c, _ = state.failures.get(provider, (0, 0))
            state.failures[provider] = (c + 1, time.time())
        return e.code, e.read(), {}
    except Exception as e:
        latency = time.time() - start
        state.record(model, provider, 500, latency)
        return 500, json.dumps({"error": str(e)}).encode(), {}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # quiet

    def do_GET(self):
        if self.path in ("/v1/models", "/models"):
            models = [{"id": k, "object": "model"} for k in list(CODING_MODELS.keys()) + ["auto", "fcm"]]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"object": "list", "data": models}).encode())
        elif self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok","gateway":"free-zed-merged"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if "/chat/completions" not in self.path:
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        model = body.get("model", "auto")
        session = self.headers.get("X-Session-Id") or hashlib.md5(json.dumps(body.get("messages", [])[:1]).encode()).hexdigest()[:16]
        # Fallback loop (core from all three)
        tried = []
        for attempt in range(MAX_FALLBACKS):
            provider, resolved = choose_provider(model, session)
            if (provider, resolved) in tried:
                continue
            tried.append((provider, resolved))
            status, data, rh = proxy_request(provider, resolved, body, self.headers)
            if status == 200:
                state.set_sticky(session, provider, resolved)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-Routed-Via", f"{provider}/{resolved}")
                self.send_header("X-Fallback-Attempts", str(attempt + 1))
                self.end_headers()
                self.wfile.write(data)
                return
            if status not in (429, 500, 502, 503, 529):
                break
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "all free providers exhausted", "tried": tried}).encode())

def main():
    print(f"Free Zed Gateway (merged 3 sources) on http://127.0.0.1:{PORT}/v1")
    print("Point Zed language_models openai api_url here. Models: auto, fcm, hy3, laguna-m1, qwen3-coder, ...")
    print("Set OPENROUTER_API_KEY etc for real free tiers. Local club3090 on :8020 also supported.")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

if __name__ == "__main__":
    main()
