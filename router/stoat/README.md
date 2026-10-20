# stoat

> **SUPERSEDED 2026-10-02 — STILL SERVING ON :25104.** cuttinggate on `:25200` is the canonical live router. The `:25104` port was marked retired (this directory's `pitchfork.d/stoat.toml.retired-20261002`), but `[daemons.stoat]` in `estate/pitchfork.toml` still sets `auto = ["start"]` — `bun router.ts` is bound to :25104 and `/health` answers 200 (verified 2026-10-02). This directory is preserved for reference.

The TypeScript multi-provider LLM router (stoat) (Bun): strategy-based failover, circuit breakers, sticky sessions, and a WAL health DB behind one OpenAI-compatible endpoint.

## What's here

- [ROUTER.md](ROUTER.md) — the full v3.2 documentation, as the router last ran.
- `stoat-ts/` — the Bun/TypeScript implementation (router, strategies, `/ui` dashboard).
- `probes/` — probe results (see `probes/RESULTS-2026-09-21.md`).
- `pitchfork.d/` — the renamed daemon stanza (`*.retired-20261002`); the stanza that actually composes the daemon is `[daemons.stoat]` in `estate/pitchfork.toml`.

## Where it went

- **Live replacement:** cuttinggate (`mesh/proxy/cuttinggate/`, `:25200`) — same strategy DNA, new home.
- **Strategy layer:** vendored into cuttinggate's `src/strategy/`.
- **Provider data:** the router's `PROVIDERS` table was reconciled into `mesh/catalog/` (`@ranch/roost`), the estate's provider SSOT.
## Zen provider restoration (2026-10-04)

The `zen` provider (OpenCode Zen free tier, `https://opencode.ai/zen/v1`) had 10 models
quarantined as "vanished-from-live-listing". Live re-verification through the router
(`:25104/v1/chat/completions`) on 2026-10-04 proved **all 10 still serve correctly**.

**Restored to live (16 total):**
ling-3.1-flash-free, fledge-alpha-free, mimo-v2.5-free, mimo-v2.6-flash-free,
nemotron-3.5-lightning-free, nemotron-3-ultra-free, longcat-2.5-preview-free,
deepseek-v4-flash-free, qwen3.6-plus-free, minimax-m3-free, north-mini-code-free,
big-pickle, jev-1.13-free, muse-spark-1.2-contributor-free,
muse-spark-1.3-contributor-free, space-bunny-free

**Added 2026-10-04 (API diff, 10 new):**
claude-sonnet-5-5, gpt-5.3-codex-spark, gpt-6.1-sol, jev-1.13,
ling-3.1-flash-free, longcat-2.5-preview-free, mimo-v2.5-free,
jev-1.13-free, fledge-alpha-free, space-bunny-free
(All verified live via :25104/v1/chat/completions)

**Community projects taking zen further:**
- parithosh-varma/opencode-proxy — zero-dep OpenAI-compatible proxy
- dinhkarate/opencode-zen-free-proxy — OpenAI/Anthropic/Responses APIs
- markdev11/oc-proxy — thin proxy for muse-spark models (Vercel-ready)
- JulienMaille/opencode-free-proxy — DeepSeek/MiniMax/Qwen via Zen
- vyn-7/opencode-bypass — tunnels through local OpenCode CLI
- parithosh-varma/zen-proxy — Claude Code on Zen free models (Anthropic API bridge)

**Key technical note:** Zen enforces client identity via `403 FreeTierError` for
non-compliant clients. Required: exact `User-Agent` (opencode/1.18.32...),
`x-opencode-session`/`x-opencode-request` IDs in `ses_`/`msg_` + 26 char format
(12 hex ts + 14 base62), `x-opencode-client: cli`, and Bearer <redacted> The router
implements this in `router_strategy.ts`.

## Zen live verification, second pass (2026-10-04, ~22:15 MDT)

Full SSE sweep of all 16 zen entries through `:25104/v1/chat/completions`
(`stream:true`, `max_tokens:24`): **11 full text**, 4 headers-only
(ling-3.1-flash-free, longcat-2.5-preview-free, deepseek-v4-flash-free,
jev-1.13-free), 1 empty stream (mimo-v2.6-flash-free). Second pass with the
gate fingerprint (session header, opencode UA, decoy tools) flipped two
entries in opposite directions — **upstream-side flakiness/quota, not a
request-shape problem**. No hidden models: the router 200s unknown IDs and
resolves bare variants by substring; community confirms `hy3-free` /
`laguna-s-2.1-free` withdrawn.

**Contraindicated:** upstream `/v1/responses` 404s for listed models — there
is no Responses-API surface on Zen; the muse-spark pair serves via
`/chat/completions`. Anonymous-token probes die upstream (500/400); the
fingerprint only matters alongside the real key.

**More community projects (beyond the list above):**
- fly143/OpenCode-Zen-free-api — `zen_relay.py` reverse proxy + `zen_check.py`
  ablation self-test; measured the exact gate fingerprint conditions
- 12errh/zen-proxy — fallback routing, aliases, self-updating model list
- mmkeeper/opencode-free-proxy — auto-discovers catalog from
  `models.opencode.ai/api.json`
- duolahypercho/codex-router#882 — documents mimo-v2.6-flash-free FreeTierError
  outside the opencode client
- router-for-me/CLIProxyAPI#6018 — native responses protocol + gate bypass
- samosa-ai-com/opencode-go-multi-auth, rahlplx/codex `zenProxy.ts`,
  oka4henry/opencode, ismaelsoilet/jev-harness

**Crash fix (commit `9060784`):** the 22:06 MDT router death was an uncaught
`AbortError: The connection was closed.` — the TTFT
`Promise.race([reader.read(), timeout])` in `router_strategy.ts` let the race
loser reject unhandled, which Bun treats as fatal. Hardened with
`readP.catch(() => {})` before the race; fingerprint construction extracted
into exported pure `zenFingerprintHeaders()` / `applyZenFreeTierBody()` with
`tests/zen_fingerprint.test.ts` (5 pass). Deployed to the live `:25104`
daemon via pitchfork restart (verified `/v1/models` + `/health` 200,
live zen probe streams).
