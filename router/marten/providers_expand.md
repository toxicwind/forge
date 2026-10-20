Expand PROVIDERS in gateway.py with more from freellmapi (28+) and free-llm-gateway (24+):
- cloudflare, cohere, together, fireworks, sambanova, huggingface, siliconflow, pollinations, llm7, ovh, kilo, nara, aih orde, etc.
- For each add base URL (OpenAI compat path), key_env, and preferred free models.
- Routing already prefers openrouter for our July free coding models (Hy3, Laguna M.1/XS, Qwen3-Coder, Gemma4, Nemotron).
- Sticky sessions and failure counters implement the core of the three sources' reliability.
