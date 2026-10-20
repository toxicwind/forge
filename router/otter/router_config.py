from __future__ import annotations
import os
import re




# old TypedDict removed
# ok: bool
# status: int
# provider: str
# model: str
# lat: float
# data: bytes
# resp: Any
# stream: bool
# err: str
# winner: int


# ---------------------------------------------------------------------------
# Load secrets from ~/.secrets
# ---------------------------------------------------------------------------
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



# Port SSOT: estate/.env.local AST_MATRIX_PORT=25104
# process-compose sets ESTATE_PORT=${AST_MATRIX_PORT}; Zed hits :25104/v1
PORT = int(
    os.getenv("ESTATE_PORT")
    or os.getenv("AST_MATRIX_PORT")
    or "25104"
)


DB = os.getenv("ESTATE_DB", "/home/toxic/estate/var/data/ast_matrix.db")


MAX_PARALLEL = 4


STICKY_TTL = 1800


FIFO_MAX = 64


STRATEGY = os.getenv("ESTATE_STRATEGY", "hybrid")



# ---------------------------------------------------------------------------
# Provider model mappings
# ---------------------------------------------------------------------------
PROVIDER_MODELS: dict[str, list[str]] = {
    "openrouter": [
        "tencent/hy3:free",
        "poolside/laguna-m.1:free",
        "poolside/laguna-xs-2.1:free",
        "google/gemma-4-31b-it:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3-nano-30b-a3b:free",
        "qwen/qwen3-coder:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "nousresearch/hermes-3-llama-3.1-405b:free",
        "openai/gpt-oss-20b:free",
    ],
    "nvidia": [
        "nvidia/nemotron-3-super-120b-a12b",
        "nvidia/nemotron-3-nano-30b-a3b",
        "meta/llama-3.1-70b-instruct",
        "meta/llama-3.3-70b-instruct",
        "qwen/qwen3.5-397b-a17b",
        "qwen/qwen3.5-122b-a10b",
        "deepseek-ai/deepseek-v4-flash",
        "deepseek-ai/deepseek-v4-pro",
        "mistralai/mistral-large-3-675b-instruct-2512",
        "google/gemma-4-31b-it",
        "z-ai/glm-5.2",
        "thinkingmachines/inkling",
    ],
    "groq": [
        "llama-3.3-70b-versatile",
        "qwen/qwen3-32b",
        "qwen/qwen3.6-27b",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "meta-llama/llama-4-scout-17b-16e-instruct",
    ],
    "cerebras": [
        # all 403 - key issue
    ],
    "google": [
        "models/gemini-2.5-flash",
        "models/gemini-2.5-flash-lite",
        "models/gemini-2.0-flash",
        "models/gemma-4-31b-it",
    ],
    "mistral": [
        "mistral-small-latest",
        "codestral-latest",
        "mistral-large-latest",
        "mistral-medium-latest",
    ],
}



# Friendly alias -> (provider, actual_model_id)
# Discovered from provider /models endpoints (see discover_models.py)
CODING: dict[str, tuple[str, str] | None] = {
    "auto": None,
    "fcm": None,
    # OpenRouter free
    "hy3": ("openrouter", "tencent/hy3:free"),
    "laguna-m1": ("openrouter", "poolside/laguna-m.1:free"),
    "laguna-xs": ("openrouter", "poolside/laguna-xs-2.1:free"),
    "gemma4-31b": ("openrouter", "google/gemma-4-31b-it:free"),
    "nemotron-super": ("openrouter", "nvidia/nemotron-3-super-120b-a12b:free"),
    "nemotron-nano": ("openrouter", "nvidia/nemotron-3-nano-30b-a3b:free"),
    "qwen3-coder": ("openrouter", "qwen/qwen3-coder:free"),
    "llama-3.3-70b-free": ("openrouter", "meta-llama/llama-3.3-70b-instruct:free"),
    "hermes-3-405b": ("openrouter", "nousresearch/hermes-3-llama-3.1-405b:free"),
    "gpt-oss-20b": ("openrouter", "openai/gpt-oss-20b:free"),
    # NVIDIA NIM direct (credit-based)
    "nim-nemotron-super": ("nvidia", "nvidia/nemotron-3-super-120b-a12b"),
    "nim-nemotron-nano": ("nvidia", "nvidia/nemotron-3-nano-30b-a3b"),
    "nim-llama-3.1-70b": ("nvidia", "meta/llama-3.1-70b-instruct"),
    "nim-llama-3.3-70b": ("nvidia", "meta/llama-3.3-70b-instruct"),
    "nim-qwen3.5-397b": ("nvidia", "qwen/qwen3.5-397b-a17b"),
    "nim-qwen3.5-122b": ("nvidia", "qwen/qwen3.5-122b-a10b"),
    "nim-deepseek-v4-flash": ("nvidia", "deepseek-ai/deepseek-v4-flash"),
    "nim-deepseek-v4-pro": ("nvidia", "deepseek-ai/deepseek-v4-pro"),
    "nim-mistral-large-3": ("nvidia", "mistralai/mistral-large-3-675b-instruct-2512"),
    "nim-gemma4-31b": ("nvidia", "google/gemma-4-31b-it"),
    "nim-glm5.2": ("nvidia", "z-ai/glm-5.2"),
    "nim-inkling": ("nvidia", "thinkingmachines/inkling"),
    # Google (via OpenAI-compat)
    "gemini-2.5-flash": ("google", "models/gemini-2.5-flash"),
    "gemini-2.5-flash-lite": ("google", "models/gemini-2.5-flash-lite"),
    "gemini-2.0-flash": ("google", "models/gemini-2.0-flash"),
    "gemma4-31b-google": ("google", "models/gemma-4-31b-it"),
    # Mistral
    "mistral-small": ("mistral", "mistral-small-latest"),
    "codestral": ("mistral", "codestral-latest"),
    "mistral-large": ("mistral", "mistral-large-latest"),
    "mistral-medium": ("mistral", "mistral-medium-latest"),
    # Groq (fast inference, free tier)
    "groq-llama-3.3-70b": ("groq", "llama-3.3-70b-versatile"),
    "groq-qwen3-32b": ("groq", "qwen/qwen3-32b"),
    "groq-qwen3.6-27b": ("groq", "qwen/qwen3.6-27b"),
    "groq-gpt-oss-120b": ("groq", "openai/gpt-oss-120b"),
    "groq-gpt-oss-20b": ("groq", "openai/gpt-oss-20b"),
    "groq-llama-4-scout": ("groq", "meta-llama/llama-4-scout-17b-16e-instruct"),
}



PROVIDERS: dict[str, dict[str, str]] = {
    "openrouter": {
        "base": "https://openrouter.ai/api/v1",
        "key_env": "OPENROUTER_API_KEY",
    },
    "nvidia": {
        "base": "https://integrate.api.nvidia.com/v1",
        "key_env": "NVIDIA_API_KEY",
        "key_env_alt": "NVIDIA_NIM_API_KEY",
    },
    "groq": {
        "base": "https://api.groq.com/openai/v1",
        "key_env": "GROQ_API_KEY",
    },
    "cerebras": {
        "base": "https://api.cerebras.ai/v1",
        "key_env": "CEREBRAS_API_KEY",
    },
    "google": {
        "base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_env": "GOOGLE_API_KEY",
    },
    "mistral": {
        "base": "https://api.mistral.ai/v1",
        "key_env": "MISTRAL_API_KEY",
    },
}



AST_RE = re.compile(
    r"(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |"
    r"async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|```)",
    re.I,
)




# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_key(p: str) -> str:
    conf = PROVIDERS[p]
    env: str = conf.get("key_env", "")
    alt: str = conf.get("key_env_alt", "")
    return os.getenv(env, "") or (os.getenv(alt, "") if alt else "") or ""




def key_ok(p: str) -> bool:
    return bool(get_key(p))




def first_model_for(p: str) -> str:
    models = PROVIDER_MODELS.get(p, [])
    return models[0] if models else ""




def resolve_model(model: str) -> tuple[str, str]:
    if model in CODING and CODING[model] is not None:
        pair = CODING[model]
        assert pair is not None
        return pair
    if model in ("auto", "fcm"):
        for p in ("openrouter", "nvidia", "groq", "cerebras", "google", "mistral"):
            if key_ok(p):
                mid = first_model_for(p)
                if mid:
                    return p, mid
        return "openrouter", "tencent/hy3:free"
    for p, models in PROVIDER_MODELS.items():
        if model in models:
            return p, model
    if key_ok("openrouter"):
        return "openrouter", model
    if key_ok("nvidia"):
        return "nvidia", model
    return "openrouter", "tencent/hy3:free"




def is_ast(text: str) -> bool:
    return bool(text and (AST_RE.search(text[:5000]) or "```" in text))
