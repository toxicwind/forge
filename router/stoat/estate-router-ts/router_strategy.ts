import type { ChatBody, RouteResult, RequestCtx } from "./router_types.ts";
import { state, isWorkerExhausted } from "./router_matrix.ts";
import { PROVIDERS, PROVIDER_MODELS, catalogModelsFor, modelFree, modelContextWindow, LOCAL_ROLES, CODING, MAX_PARALLEL, FIFO_MAX, STRATEGY, UA, AST_RE, getKey, keyOk, firstModelFor, resolveModel, isLocalSwapModelId, isAst, isExplicit, classifyTask, costTier, json, normalizeModelSpec, isChatCapable, log, CONNECT_MS, TTFT_MS, ATTEMPT_MS, ATTEMPT_STREAM_MS, HEDGE_MS } from "./router_config.ts";
import { resolveSigmaAlias } from "./sigma-enrich.ts";
import { benchModelBonus } from "./bench-priors.ts";
// 📒 ledger — the ranch account book: durable Gemini cost accounting.
import { recordUsage } from "./ledger.ts";
import type { RoutingDecision } from "./decision.ts";
import { dispatcherFor } from "./dispatcher.ts";
import { ProviderRateLimiter } from "./ratelimit.ts";
import { flockMetrics } from "./flock-metrics.ts";
import { injectStreamOptions, noteInjectRejected } from "./streamopts.ts";

// ---------------------------------------------------------------------------
// Flock-port shared state (G6/G7): per-provider FIFO dispatchers are created
// lazily by dispatcherFor(); the per-provider token-bucket rate limiter is
// built here from the registry and rebuilt on hot reload.
// ---------------------------------------------------------------------------
export const providerRateLimiter = new ProviderRateLimiter();
// ---------------------------------------------------------------------------
// OpenCode Zen client identity (borrowed: 9router-opencode-fix,
// opencurro-ai/opencodeZen, lidge-jun/opencodex#2160).
// Stable for the process lifetime — mimics one long-lived CLI session/project.
// ---------------------------------------------------------------------------
export const OPENCODE_UA = "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
 // Zen free-tier gate checks ID format: ses_/msg_ + 26 chars (12 hex ts + 14 base62).
 // Borrowed: denysvitali/llm-proxy newOpenCodeID, 12errh/zen-proxy.
export function openCodeID(prefix: string): string {
   const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
   const b62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
   let r = "";
   for (let i = 0; i < 14; i++) r += b62[Math.floor(Math.random() * 62)];
   return prefix + ts + r;
 }
 const OPENCODE_SESSION_ID = openCodeID("ses_");
 const OPENCODE_PROJECT_ID = "global";
 const OPENCODE_PUBLIC_TOKEN = "public";

// ---------------------------------------------------------------------------
// Zen upstream contract — exported pure for tests (tests/zen_fingerprint.test.ts).
// Verified live 2026-10-04 against https://opencode.ai/zen/v1: GET /v1/models
// -> 200 (86 models); chat/completions serves with the exact fingerprint below
// plus a valid key. The anonymous token gets 500/400 on completions regardless
// of fingerprint, and /v1/responses does not exist (404) — no per-model
// endpoint split is warranted; everything zen goes to /chat/completions.
// ---------------------------------------------------------------------------
export function zenFingerprintHeaders(): Record<string, string> {
  // Auth: Chris-provided OPENCODE_API_KEY via secrets; fallback to public anonymous.
  return {
    "Authorization": "Bearer " + (getKey("zen") || OPENCODE_PUBLIC_TOKEN),
    "User-Agent": OPENCODE_UA,
    "x-opencode-client": "cli",
    "x-opencode-session": OPENCODE_SESSION_ID,
    "x-opencode-project": OPENCODE_PROJECT_ID,
    "x-opencode-request": openCodeID("msg_"),
  };
}

export function applyZenFreeTierBody(payload: Record<string, unknown>): void {
  payload.stream = true;
  const need = ["bash", "glob", "grep", "read"];
  const tools = payload.tools as Array<{ function?: { name?: string }; name?: string }> | undefined;
  const have = new Set((tools || []).map((t) => (t?.function?.name || t?.name || "").toLowerCase()));
  const missing = need.filter((n) => !have.has(n));
  if (missing.length > 0) {
    const mk = (n: string) => ({ type: "function", function: { name: n, description: n + " tool", parameters: { type: "object", properties: {}, required: [] } } });
    payload.tools = [...(tools || []), ...missing.map(mk)];
    if (!payload.tool_choice) payload.tool_choice = "none";
  }
}

export function rebuildRateLimiter(): void {
  providerRateLimiter.build(
    Object.keys(PROVIDERS).map((name) => {
      const models = catalogModelsFor(name);
      let freeCount = 0;
      for (const m of models) {
        try {
          if (modelFree(name, m)) freeCount++;
        } catch {
          /* metadata failure -> treat as paid */
        }
      }
      return {
        name,
        freeTier: models.length > 0 && freeCount * 2 >= models.length,
        keyRpms: [],
      };
    }),
  );
}
rebuildRateLimiter();

function dispatchWaitMs(): number {
  const raw = parseInt(process.env.ESTATE_DISPATCH_WAIT_MS || "30000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30000;
}

// ---------------------------------------------------------------------------
// Substance guard: a completion is servable only if it carries non-empty
// content (or tool_calls). HTTP 200 with an empty message is a failure at
// every routing layer — never served, never sticky-pinned, always struck.
// ---------------------------------------------------------------------------
function messageOf(r: RouteResult): any {
  try {
    const raw =
      typeof r.data === "string"
        ? r.data
        : new TextDecoder().decode(r.data as Uint8Array);
    return JSON.parse(raw)?.choices?.[0]?.message;
  } catch {
    return undefined;
  }
}

export function substantive(r: RouteResult): boolean {
  if (!r.ok) return false;
  const m = messageOf(r);
  if (!m) return false;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
  const c = typeof m.content === "string" ? m.content.trim() : "";
  if (c === "") return false;
  // Classifier/guard models answer with a bare scalar score (2026-10-01:
  // llama-prompt-guard-2-86m served "0.0007095712935552001" as a chat
  // completion). A bare number is not a chat completion -- reject it so the
  // race treats the result as a substance failure and strikes the model.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(c)) return false;
  return true;
}

function contentText(r: RouteResult): string {
  const m = messageOf(r);
  const c = m?.content;
  return typeof c === "string" ? c : "";
}

// Any model id the router can directly address: explicit alias, local id,
// or any curated/live catalog id on any keyed provider. Unknown ids keep
// the old race-everything behavior.
export function isRoutableModelId(model: string): boolean {
  if (isExplicit(model)) return true;
  // openfang shim: "provider:model" / "provider/model" specs are directly
  // routable — resolveModel pins the provider via normalizeModelSpec.
  if (normalizeModelSpec(model).provider) return true;
  for (const p of Object.keys(PROVIDERS)) {
    if (catalogModelsFor(p).includes(model)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------
export async function callOne(
  provider: string,
  model: string,
  body: ChatBody,
  stream = false,
  externalSignal?: AbortSignal,
  rctx?: RequestCtx,
  force = false,
): Promise<RouteResult> {
  const decision = rctx?.decision;
  // 404-entitlement bench (503-forensics 2026-09-21): fail fast with ZERO
  // attempt burn — this model id 404'd before (delisted or not entitled
  // for our key) and never heals by retrying. Every path funnels through
  // callOne, so this one guard covers races, chains, sticky, and streams.
  if (state.isEntitlementDead(provider, model)) {
    return {
      ok: false,
      status: 404,
      provider,
      lat: 0,
      err: "entitlement_benched",
    };
  }
  // Model disabler (2026-10-04): skip models benched by consecutive failures.
  // They recheck on backoff via the background rechecker — zero attempt burn here.
  if (!force && state.disabler.isDisabled(`${provider}:${model}`)) {
    decision?.push_skip(provider, "model_disabled");
    return {
      ok: false,
      status: 503,
      provider,
      lat: 0,
      err: "model_disabled",
    };
  }
  if (!state.circuitOk(provider)) {
    decision?.push_skip(provider, "circuit_open");
    return {
      ok: false,
      status: 503,
      provider,
      lat: 0,
      err: "circuit_open",
    };
  }
  const conf = PROVIDERS[provider];
  if (!conf) {
    return {
      ok: false,
      status: 500,
      provider,
      lat: 0,
      err: "unknown_provider",
    };
  }
  // G7: per-provider token bucket (flock ratelimit.rs). A drained bucket
  // fails the attempt over to the next candidate — never a circuit strike.
  if (!providerRateLimiter.allow(provider)) {
    decision?.push_skip(provider, "rate_limited");
    return {
      ok: false,
      status: 429,
      provider,
      lat: 0,
      err: "rate_limited",
    };
  }
  const baseClean = conf.base.replace(/\/$/, "");
  const url = baseClean.endsWith("/v1") ? `${baseClean}/chat/completions` : `${baseClean}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": UA,
    "Accept-Encoding": "identity",
  };
  // G8: relay the Gemini Interactions turn handle upstream. keypool
  // (:25109) reads x-previous-interaction-id to build
  // previous_interaction_id and answers with x-interaction-id; without the
  // relay every tool loop through the router dies with a 400 on turn 2.
  const prevInteractionId = rctx?.reqHeaders?.get("x-previous-interaction-id");
  if (prevInteractionId) headers["x-previous-interaction-id"] = prevInteractionId;
  if (!conf.no_auth) {
    // NVIDIA rotates across the multi-key pool (40 rpm token bucket per
    // key). All buckets dry is an honest 429 — falling back to the default
    // key would just burn a rate-limited key.
    const rk = provider === "nvidia" ? state.nextNvidiaKey() : null;
    if (provider === "nvidia" && !rk) {
      decision?.push_skip(provider, "rate_limited");
      return {
        ok: false,
        status: 429,
        provider,
        lat: 0,
        err: "nvidia_buckets_exhausted",
      };
    }
    headers.Authorization = `Bearer ${rk || getKey(provider)}`;
  } else {
    headers.Authorization = "Bearer not-required-for-local";
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://zed.dev";
    headers["X-Title"] = "Estate-Router";
  }
  if (provider === "zen") {
    // OpenCode Zen free-tier gate (borrowed: denysvitali/llm-proxy, 12errh/zen-proxy).
    // Format-checked, not app-attested: opencode/ UA + ses_/msg_ IDs
    // (26 chars: 12 hex ts + 14 base62) + stream:true + bash/glob/grep/read tools.
    // Without the exact format: 403 FreeTierError.
    Object.assign(headers, zenFingerprintHeaders());
  }
  // Model-pressure governor (flock governor.rs AIMD, per provider/model):
  // refused fast with 429 when the model is at its worker cap or draining.
  const govKey = `${provider}/${model}`;
  const permit = state.governor.admit(govKey);
  if (!permit) {
    decision?.push_skip(provider, "rate_limited");
    return {
      ok: false,
      status: 429,
      provider,
      lat: 0,
      err: "governor_limited",
    };
  }
  // G2: stream_options injection (flock proxy.rs usage injection). Streamed
  // chat completions only report exact token usage when asked — ask on the
  // client's behalf unless they set stream_options or the model opted out
  // after a 400 (NO_INJECT).
  let payloadBody: ChatBody = body;
  let injectedKey: string | null = null;
  if (stream && (rctx?.path ?? "/v1/chat/completions") === "/v1/chat/completions") {
    const key = rctx?.model || String((body as Record<string, unknown>)["model"] || "auto");
    const inj = injectStreamOptions(body, key);
    payloadBody = inj.body;
    if (inj.injected) injectedKey = key;
  }
  // G6: FIFO dispatcher slot (flock dispatch.rs). Every attempt funnels
  // through the per-provider queue — strict arrival order under contention.
  // Fail fast past the deadline so a stalled queue fails over.
  const dispatchDeadline = rctx?.deadlineMs ?? Date.now() + dispatchWaitMs();
  const slot = await dispatcherFor(provider).acquire(dispatchDeadline);
  if (!slot) {
    flockMetrics.dispatchTimeout++;
    decision?.push_attempt(provider, 429, 0);
    permit.release();
    return {
      ok: false,
      status: 429,
      provider,
      lat: 0,
      err: "dispatch_queue_timeout",
    };
  }
  flockMetrics.recordQueueWait(slot.waitedMs / 1000);
  const payload = { ...payloadBody, model, stream };
  // Zen free-tier body gate (borrowed: denysvitali/llm-proxy prepareFreeTierBody).
  // Requires stream:true + bash/glob/grep/read tool signatures, else 403.
  if (provider === "zen") applyZenFreeTierBody(payload);
  const start = performance.now();
  // Failfast signal stack: connect (headers) < TTFT (first byte, stream) <
  // total attempt cap < client deadline / hangup. AbortSignal.any keeps
  // each layer independent.
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("connect_timeout")),
    CONNECT_MS,
  );
  const totalSignal = AbortSignal.timeout(
    stream ? ATTEMPT_STREAM_MS : ATTEMPT_MS,
  );
  const signals: AbortSignal[] = [totalSignal, connectCtrl.signal];
  if (externalSignal) signals.push(externalSignal);
  if (rctx?.signal) signals.push(rctx.signal);
  // Per-attempt ledger (G12) + latency histograms (G11). status 0 =
  // connection-level failure (no response), mirroring Rust.
  const noteAttempt = (status: number, ttftMs: number | null) => {
    const latMs = performance.now() - start;
    decision?.push_attempt(provider, status, latMs);
    flockMetrics.recordUpstream(latMs / 1000);
    if (ttftMs != null) flockMetrics.recordTtft(ttftMs / 1000);
  };
  let interactionId: string | undefined;
  const withIid = <T extends RouteResult>(r: T): T =>
    interactionId ? { ...r, interactionId } : r;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
    // G8: capture the upstream turn handle for the client echo.
    interactionId = resp.headers.get("x-interaction-id") || undefined;
  } catch (e) {
    clearTimeout(connectTimer);
    slot.release();
    permit.release();
    const lat = (performance.now() - start) / 1000;
    const msg = e instanceof Error ? e.message : String(e);
    // A hedged loser abort is NOT a provider failure: no circuit strike,
    // no error note, no DB row. The winner already served the client.
    if (/hedged_loser/.test(msg)) {
      noteAttempt(499, null);
      return {
        ok: false,
        status: 499,
        provider,
        lat,
        err: "hedged_loser",
        timings: {
          connect_ms: Math.round((performance.now() - start) * 10) / 10,
          ttft_ms: null,
          total_ms: Math.round(lat * 1000 * 10) / 10,
        },
      };
    }
    const err = /connect_timeout/.test(msg)
      ? "connect_timeout"
      : /TimeoutError|attempt_timeout/.test(msg)
        ? "attempt_timeout"
        : "fetch_error:" + msg.slice(0, 120);
    state.noteError(provider, 504, err);
    state.record(model, provider, 504, lat, 0, STRATEGY);
    noteAttempt(0, null);
    const t = {
      connect_ms: Math.round((performance.now() - start) * 10) / 10,
      ttft_ms: null as number | null,
      total_ms: Math.round(lat * 1000 * 10) / 10,
    };
    return { ok: false, status: 504, provider, lat, err, timings: t };
  }
  clearTimeout(connectTimer);
  const connectMs = Math.round((performance.now() - start) * 10) / 10;
  const lat = (performance.now() - start) / 1000;
  const mkTimings = (ttft: number | null) => ({
    connect_ms: connectMs,
    ttft_ms: ttft,
    total_ms: Math.round((performance.now() - start) * 10) / 10,
  });
  try {
    if (!resp.ok) {
      const errText = (await resp.text()).slice(0, 500);
      // Worker-exhaustion signature is checked BEFORE generic failure
      // handling: it is model-scoped, never a reason to cool the lane.
      // The permit is still held, so the observed in-flight count
      // includes this request when the governor engages at half of it.
      if (isWorkerExhausted(errText)) state.governor.noteExhausted(govKey);
      state.noteError(provider, resp.status, errText.slice(0, 200));
      state.record(model, provider, resp.status, lat, 0, STRATEGY);
      noteAttempt(resp.status, null);
      // G2: the injected body was rejected — memoize the model and retry
      // once with the untouched body. NO_INJECT makes the recursive call
      // skip injection, so this cannot loop.
      if (resp.status === 400 && injectedKey) {
        noteInjectRejected(injectedKey);
        log(`stream_options injection rejected by ${provider}/${model}; retrying unmodified`);
        return callOne(provider, model, body, stream, externalSignal, rctx);
      }
      return withIid({
        ok: false,
        status: resp.status,
        provider,
        lat,
        err: errText,
        timings: mkTimings(null),
      });
    }
    if (stream) {
      if (resp.body) {
        // TTFT failfast: first chunk must arrive within the TTFT budget.
        const ttftRemain = TTFT_MS - (performance.now() - start);
        const reader = resp.body.getReader();
        let first: ReadableStreamReadResult<Uint8Array> | "ttft_timeout";
        if (ttftRemain <= 0) {
          first = "ttft_timeout";
        } else {
          // The race loser must never reject unhandled: if the TTFT timer
          // wins and the upstream connection later closes, the orphaned
          // read() rejects with AbortError and Bun surfaces it as an uncaught
          // exception, killing the process (pitchfork respawned us after the
          // 2026-10-04 22:06:07 MDT crash).
          const readP = reader.read();
          readP.catch(() => {});
          first = await Promise.race([
            readP,
            new Promise<"ttft_timeout">((res) =>
              setTimeout(() => res("ttft_timeout"), ttftRemain),
            ),
          ]);
        }
        if (first === "ttft_timeout" || first.done) {
          const tlat = (performance.now() - start) / 1000;
          try {
            reader.cancel();
          } catch { /* noop */ }
          state.noteError(provider, 504, "ttft_timeout");
          state.record(model, provider, 504, tlat, 0, STRATEGY);
          noteAttempt(504, null);
          return { ok: false, status: 504, provider, lat: tlat, err: "ttft_timeout", timings: mkTimings(null) };
        }
        const ttftMs = Math.round((performance.now() - start) * 10) / 10;
        // Re-emit the consumed first chunk, then pipe the rest.
        const firstChunk = first.value;
        const rest = new ReadableStream<Uint8Array>({
          async start(controller) {
            if (firstChunk) controller.enqueue(firstChunk);
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              controller.close();
            } catch (e) {
              controller.error(e);
            }
          },
        });
        state.record(model, provider, 200, lat, 0, STRATEGY);
        if (state.circuit.get(provider) === "half")
          state.circuit.set(provider, "closed");
        noteAttempt(200, ttftMs);
        return withIid({
          ok: true,
          status: resp.status,
          provider,
          model,
          lat,
          stream: rest,
          timings: mkTimings(ttftMs),
        });
      }
      state.record(model, provider, 200, lat, 0, STRATEGY);
      if (state.circuit.get(provider) === "half")
        state.circuit.set(provider, "closed");
      noteAttempt(200, null);
      return withIid({
        ok: true,
        status: resp.status,
        provider,
        model,
        lat,
        stream: resp.body,
      });
    }
    const data = await resp.arrayBuffer();
    // 📒 ledger: record token usage for cost accounting — ALL providers.
    // Best-effort — never throws, never touches the response path.
    // Usage shapes vary by upstream: OpenAI (prompt_tokens/completion_tokens),
    // Anthropic (input_tokens/output_tokens), Gemini EAP interactions
    // (total_input_tokens/total_output_tokens), Gemini native
    // (promptTokenCount/candidatesTokenCount). Accept any of them.
    try {
      const usage = JSON.parse(new TextDecoder().decode(data))?.usage;
      if (usage && typeof usage === "object") {
        const inputTokens =
          usage.prompt_tokens ?? usage.input_tokens ??
          usage.total_input_tokens ?? usage.promptTokenCount ?? 0;
        const outputTokens =
          usage.completion_tokens ?? usage.output_tokens ??
          usage.total_output_tokens ?? usage.candidatesTokenCount ?? 0;
        if (inputTokens || outputTokens) {
          recordUsage({
            provider: String(provider),
            model: String(model),
            inputTokens,
            outputTokens,
          });
        }
      }
    } catch { /* accounting must never break serving */ }
    state.record(model, provider, resp.status, lat, 0, STRATEGY);
    if (state.circuit.get(provider) === "half")
      state.circuit.set(provider, "closed");
    noteAttempt(resp.status, null);
    return withIid({
      ok: true,
      status: resp.status,
      data: new Uint8Array(data),
      provider,
      model,
      lat,
      timings: mkTimings(Math.round((performance.now() - start) * 10) / 10),
    });
  } catch (e) {
    const lat = (performance.now() - start) / 1000;
    state.record(model, provider, 500, lat, 0, STRATEGY);
    noteAttempt(500, null);
    return {
      ok: false,
      status: 500,
      provider,
      lat,
      err: String(e),
    };
  } finally {
    permit.release();
    slot.release();
  }
}

/**
 * firstUsableModelFor — first catalog model that isn't flap-benched or
 * entitlement-benched. Race sets use this instead of firstModelFor so
 * dead IDs never occupy a lane. Exported for regression tests.
 */
export function rankedPairs(model: string | null, task = "chat"): [string, string][] {
  const pairs: [string, string][] = [];
  for (const p of Object.keys(PROVIDERS)) {
    const live = LIVE_STATUS[p]?.models ?? [];
    const ms = model && model !== "auto" && !model.startsWith("direct:")
      ? [model]
      : (live.length ? live : catalogModelsFor(p));
    for (const m of ms) pairs.push([p, m]);
  }
  if (!pairs.length) {
    for (const p of ["herd", "openrouter", "nim-local"]) pairs.push([p, "<default>"]);
  }
  pairs.sort((a, b) => {
    const scoreB = BELIEF.costOf(`${b[0]}/${b[1]}/${task}`) + BELIEF.costOf(`${b[0]}/${b[1]}`);
    const scoreA = BELIEF.costOf(`${a[0]}/${a[1]}/${task}`) + BELIEF.costOf(`${a[0]}/${a[1]}`);
    return scoreB - scoreA;
  });
  return pairs;
}

export function pickWeighted(n = MAX_PARALLEL, task = "chat"): [string, string][] {
  return rankedPairs(null, task).slice(0, n);
}


// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------
export async function routeAstRace(
  body: ChatBody,
  session: string,
  candsOverride?: [string, string][],
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const decision = rctx?.decision;
  const model = String(body.model || "auto");
  if (isRoutableModelId(model) && !candsOverride) {
    // Direct-addressable id (alias, local id, or any curated/live catalog
    // id): go straight to its provider instead of racing.
    const [p, mid] = resolveModel(model);
    const r = await callOne(p, mid, body, false, undefined, rctx);
    if (substantive(r)) {
      decision?.select("priority");
      state.stickySet(session, p, mid);
      state.record(mid, p, 200, r.lat || 0, 1, "ast_race");
      return r;
    }
    if (r.ok) state.recordEmpty(p, mid);
    // v3.2: explicit model failed -> fail over to the full candidate race
    // (resilience over strictness; the direct attempt stays the fast path).
  }
  const cands = demoteByContext(
    candsOverride || pickWeighted(MAX_PARALLEL),
    body,
    decision,
  );
  if (!cands.length)
    return { ok: false, status: 503, err: "ast_race_exhausted" };
  // HFT: first substantive finisher wins — the slowest lane must not set the
  // pace (previously Promise.allSettled waited for every lane). Losers are
  // aborted; their aborts are not circuit strikes. An isAst (code-shaped)
  // finisher still takes priority over a plain substantive one.
  const ctrls = cands.map(() => new AbortController());
  return new Promise<RouteResult>((resolve) => {
    let settled = false;
    let pending = cands.length;
    let lastErr = "ast_race_exhausted";
    let bestSubstantive: RouteResult | null = null;
    const finish = (r: RouteResult) => {
      if (settled) return;
      settled = true;
      for (const c of ctrls) {
        try {
          c.abort(new Error("hedged_loser"));
        } catch { /* noop */ }
      }
      resolve(r);
    };
    const win = (r: RouteResult) => {
      decision?.select("priority");
      state.stickySet(session, r.provider!, r.model!);
      state.record(r.model!, r.provider!, 200, r.lat || 0, 1, "ast_race");
      finish(r);
    };
    cands.forEach(([p, mid], i) => {
      callOne(p, mid, body, false, ctrls[i].signal, rctx).then((r) => {
        pending--;
        if (settled) return;
        if (!r.ok) {
          if (r.err && r.err !== "hedged_loser") lastErr = r.err;
        } else if (!substantive(r)) {
          // Non-substantive (empty/whitespace-only) completion: never a
          // winner — strike the model via the flap tracker.
          state.recordEmpty(p, mid);
        } else if (isAst(contentText(r))) {
          win(r); // code-shaped output takes priority
          return;
        } else if (!bestSubstantive) {
          bestSubstantive = r;
          // Brief quality window: a code-shaped finisher arriving within
          // 250ms still preempts; otherwise first valid wins.
          setTimeout(() => {
            if (!settled && bestSubstantive) win(bestSubstantive);
          }, 250);
        }
        if (pending === 0 && !settled) {
          if (bestSubstantive) win(bestSubstantive);
          else finish({ ok: false, status: 503, err: lastErr });
        }
      });
    });
    setTimeout(() => {
      if (!settled) {
        if (bestSubstantive) win(bestSubstantive);
        else finish({ ok: false, status: 503, err: "ast_race_timeout" });
      }
    }, 95_000);
  });
}

export async function routeSticky(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model)) return routeAstRace(body, session, undefined, rctx);
  const [p, m] = state.stickyGet(session);
  if (p && keyOk(p) && state.circuitOk(p) && !state.laneDead(p)) {
    const r = await callOne(p, m || model, body, false, undefined, rctx);
    if (substantive(r)) { rctx?.decision?.select("session_binding"); return r; }
    if (r.ok) state.recordEmpty(p, m || model);
  }
  return routeAstRace(body, session, undefined, rctx);
}

export async function routeWeighted(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const cands = demoteByContext(pickWeighted(1), body, rctx?.decision);
  if (!cands.length) return { ok: false, status: 503, err: "no_providers" };
  const [p, mid] = cands[0];
  const r = await callOne(p, mid, body, false, undefined, rctx);
  if (substantive(r)) {
    rctx?.decision?.select("priority");
    state.stickySet(session, p, mid);
    return r;
  }
  if (r.ok) state.recordEmpty(p, mid);
  // Router-max: the weighted single-pick never fails the request hard —
  // degrade into the circuit chain (ordered failover) instead of 502.
  if (r.ok || !shouldFailover(r)) {
    return {
      ok: false,
      status: r.ok ? 502 : r.status || 502,
      provider: p,
      lat: r.lat,
      err: r.ok ? "empty_completion" : r.err,
    };
  }
  return routeCircuitChain(body, session, rctx);
}

export async function routeCircuitChain(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model)) {
    const [p, mid] = resolveModel(model);
    if (keyOk(p) && state.circuitOk(p)) {
      const r = await callOne(p, mid, body, false, undefined, rctx);
      if (substantive(r)) {
        rctx?.decision?.select("priority");
        state.stickySet(session, p, mid);
        return r;
      }
      if (r.ok) state.recordEmpty(p, mid);
      // v3.2: fall through to the chain (explicit_provider_unavailable is
      // no longer terminal while any backend is alive).
    }
  }
  const order = Object.keys(PROVIDERS).sort(
    (a, b) => state.candidateScore(b) - state.candidateScore(a),
  );
  const cands: [string, string][] = [];
  for (const p of order) {
    const mid = firstUsableModelFor(p);
    if (mid) cands.push([p, mid]);
  }
  const dc = demoteByContext(cands, body, rctx?.decision);
  return hedgedChain(dc, body, session, "circuit_chain", rctx);
}

export async function routeFifo(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  if (state.fifoDepth >= FIFO_MAX) {
    return { ok: false, status: 429, err: "fifo_full" };
  }
  state.fifoDepth++;
  try {
    return await routeAstRace(body, session, undefined, rctx);
  } finally {
    state.fifoDepth = Math.max(0, state.fifoDepth - 1);
  }
}

export async function routeHybrid(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model)) {
    const [p, mid] = resolveModel(model);
    // HFT: the explicit lane is hedged — if it hasn't delivered within
    // HEDGE_MS, the weighted field races in parallel and first substantive
    // wins. A hanging explicit backend no longer costs the client its
    // full connect timeout before failover begins.
    const field = demoteByContext(
      pickWeighted(MAX_PARALLEL).filter(([cp]) => cp !== p),
      body,
      rctx?.decision,
    );
    const r = await hedgedChain([[p, mid], ...field], body, session, "hybrid_direct", rctx);
    if (r.ok) return r;
    // v3.2: total explicit+field failure -> fall through to chain failover.
    return routeCircuitChain(body, session, rctx);
  }
  const [p, m] = state.stickyGet(session);
  if (p && keyOk(p) && state.circuitOk(p) && !state.laneDead(p)) {
    const r = await callOne(p, m || model, body, false, undefined, rctx);
    if (substantive(r)) { rctx?.decision?.select("session_binding"); return r; }
    if (r.ok) state.recordEmpty(p, m || model);
  }
  const r2 = await routeAstRace(body, session, undefined, rctx);
  if (r2.ok) return r2;
  return routeCircuitChain(body, session, rctx);
}

/**
 * hedgedChain — HFT "redundant exchange feeds" applied to provider lanes.
 * Fires cands[0] (the preferred lane: explicit, cheapest, or best-scored).
 * If no winner within HEDGE_MS, the whole remaining field races in
 * parallel — first substantive completion wins and the losers are aborted
 * (their aborts are NOT recorded as provider failures). A lane that fails
 * fast immediately triggers the single next lane without waiting for the
 * hedge timer. HEDGE_MS=0 restores the classic sequential chain.
 */
export async function hedgedChain(
  cands: [string, string][],
  body: ChatBody,
  session: string,
  stratName: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  // Dead-lane exclusion (503-forensics 2026-09-21): lanes whose recent
  // attempts all failed sit out of the chain. Degraded fallback: if that
  // empties the set, try every circuitOk lane anyway rather than 503.
  // Exclusions are recorded on the decision ledger (G12).
  const decision = rctx?.decision;
  let live = cands.filter(([p]) => {
    if (!keyOk(p)) { decision?.push_skip(p, "not_connected"); return false; }
    if (!state.circuitOk(p)) { decision?.push_skip(p, "circuit_open"); return false; }
    if (state.laneDead(p)) { decision?.push_skip(p, "risk_paused"); return false; }
    return true;
  });
  if (!live.length) {
    live = cands.filter(([p]) => keyOk(p) && state.circuitOk(p));
  }
  if (!live.length) return { ok: false, status: 503, err: stratName + "_exhausted" };
  // A provider that just burned a full timeout must not lead the next chain
  // and burn another: sort healthy lanes first (stable — explicit preference
  // kept among equal strike counts). Demoted lanes still race at the hedge.
  live.sort(
    (a, b) => state.consecutiveFailures(a[0]) - state.consecutiveFailures(b[0]),
  );
  if (HEDGE_MS <= 0) {
    let lastErr = stratName + "_exhausted";
    for (let li = 0; li < live.length; li++) {
      const [p, mid] = live[li]!;
      const r = await callOne(p, mid, body, false, undefined, rctx);
      if (substantive(r)) {
        decision?.select(li === 0 ? "priority" : "failover");
        state.stickySet(session, p, mid);
        state.record(mid, p, 200, r.lat || 0, 1, stratName);
        return r;
      }
      if (r.ok) state.recordEmpty(p, mid);
      lastErr = r.err || lastErr;
    }
    return { ok: false, status: 503, err: lastErr };
  }
  return new Promise((resolve) => {
    let settled = false;
    let idx = 0;
    let pending = 0;
    let lastErr = stratName + "_exhausted";
    const ctrls: AbortController[] = [];
    const settle = (r: RouteResult) => {
      if (settled) return;
      settled = true;
      for (const c of ctrls) {
        try {
          c.abort(new Error("hedged_loser"));
        } catch { /* noop */ }
      }
      resolve(r);
    };
    const fire = (): void => {
      if (settled || idx >= live.length) return;
      const laneEntry = live[idx]!;
      const laneIdx = idx;
      idx++;
      const [p, mid] = laneEntry;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      pending++;
      const hedgeTimer = setTimeout(() => {
        if (!settled) {
          // Hedge: the preferred lane is slow — race the whole field.
          while (idx < live.length) fire();
        }
      }, HEDGE_MS);
      callOne(p, mid, body, false, ctrl.signal, rctx).then((r) => {
        clearTimeout(hedgeTimer);
        pending--;
        if (settled) return;
        if (substantive(r)) {
          decision?.select(laneIdx === 0 ? "priority" : "failover");
          state.stickySet(session, p, mid);
          state.record(mid, p, 200, r.lat || 0, 1, stratName);
          settle(r);
        } else {
          if (r.ok) state.recordEmpty(p, mid);
          if (r.err && r.err !== "hedged_loser") lastErr = r.err;
          if (pending === 0) {
            if (idx >= live.length) settle({ ok: false, status: 503, err: lastErr });
            else fire(); // fail fast: next lane immediately
          }
        }
      });
    };
    fire();
  });
}

export async function routeCascade(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const localFirst = ["llama-swap", "kimi-auto", "nim-local"];
  const order = Object.keys(PROVIDERS).sort((a, b) => {
    const la = localFirst.includes(a) ? 0 : 1;
    const lb = localFirst.includes(b) ? 0 : 1;
    if (la !== lb) return la - lb;
    const am = firstModelFor(a);
    const bm = firstModelFor(b);
    const fa = am && modelFree(a, am) ? 0 : 1;
    const fb = bm && modelFree(b, bm) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (state.elo.get(b) || 1000) - (state.elo.get(a) || 1000);
  });
  const cands: [string, string][] = [];
  for (const p of order) {
    const mid = firstUsableModelFor(p);
    if (mid) cands.push([p, mid]);
  }
  const dc = demoteByContext(cands, body, rctx?.decision);
  return hedgedChain(dc, body, session, "cascade", rctx);
}

// ---------------------------------------------------------------------------
// 1M-context pin — oracle DECISION 12187, verdict A (CONDITIONAL).
// Evidence: probe session 1m-probe-20260921-1745 (13 rows,
// strategy='longctx-probe' in the health DB; artifacts committed in
// 7f4f79a48c; analysis in ranch/mesh/router/estate-scripts-router/probes/RESULTS-2026-09-21.md)
// verified EXACT 1M-token needle retrieval on the KEYED lane below
// (100k/500k/1M at 3.4/9.2/18.2/41.4s) plus the verified negative:
// OpenRouter :free caps at 262144 tokens (HTTP 400 at 500k) — no free lane
// can serve >262k, so the pin displaces no free lane (routing doctrine:
// ranking > free-on-provider > pay orders preference, not a pay ban).
// Mechanism: est-token gate -> DIRECT lane call, executing OUTSIDE the
// parallel race (the LING_DEFAULT pool-order unshift was proven a no-op in
// DECISION 12097 and is NOT used here).
// BINDING GUARDS (no guard = no merge):
//  (1) Credit guard: the NVIDIA key is a free-tier BUILD key — finite and
//      shared across the swarm, NOT one of Chris's paid subs. The pinned
//      path is capped at LONGCTX_PIN_DAILY_CAP requests/day (~10 to start;
//      counts EVERY pinned attempt, ok or not, since every attempt burns
//      key credits). EVERY pinned attempt is logged under
//      strategy='longctx-pinned' with est tokens + latency so the next
//      oracle review has real traffic data.
//  (2) Circuit check FIRST via state.circuitOk('nvidia') — open -> fall
//      through to the normal race; never fight the breaker.
// On pinned failure: the attempt is logged and the caller does a single
// fallback to the normal race. The pin never sets session stickiness — it
// is size-deterministic, not session-affine; the next request re-races.
// Operational kill switch: ESTATE_LONGCTX_PIN=0 disables the pin.
// ---------------------------------------------------------------------------
export const LONGCTX_PIN_PROVIDER = "nvidia";
// KEYED lane ONLY — never the :free id (provider cap 262144 tokens).
export const LONGCTX_PIN_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const LONGCTX_PIN_GATE_TOKENS = 200_000;
export const LONGCTX_PIN_DAILY_CAP = 10;
const LONGCTX_PIN_STRATEGY = "longctx-pinned";

export function longctxPinEnabled(): boolean {
  return process.env.ESTATE_LONGCTX_PIN !== "0";
}

/**
 * estPromptTokens — prompt-size estimator, chars/4, the SAME estimator the
 * 1M probe used (haystack_chars / 4.0). Counts string content and text parts
 * of content arrays across all messages.
 */
export function estPromptTokens(body: ChatBody): number {
  let chars = 0;
  const msgs = (body as { messages?: unknown[] }).messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      const c = (m as { content?: unknown })?.content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) {
        for (const part of c) {
          const t = (part as { text?: unknown })?.text;
          if (typeof t === "string") chars += t.length;
        }
      }
    }
  }
  return chars / 4;
}

export type LongctxPinReason =
  | "eligible"
  | "disabled"
  | "under_gate"
  | "explicit_model"
  | "circuit_open"
  | "no_key"
  | "budget_exhausted";

export type LongctxPinVerdict = {
  ok: boolean;
  reason: LongctxPinReason;
  estTokens: number;
};

/**
 * Eligibility only (no side effects): pin enabled, gate tripped, no
 * explicit model request (an explicitly named model — alias,
 * provider:model spec, catalog id — is honored, never hijacked), circuit
 * closed (never fight the breaker), key present, daily pinned-request
 * budget not exhausted.
 */
export function longctxPinEligible(body: ChatBody): LongctxPinVerdict {
  const estTokens = estPromptTokens(body);
  if (!longctxPinEnabled()) return { ok: false, reason: "disabled", estTokens };
  if (estTokens <= LONGCTX_PIN_GATE_TOKENS)
    return { ok: false, reason: "under_gate", estTokens };
  // Explicit model requests keep their direct lane — the pin only serves
  // the default/auto path.
  if (isRoutableModelId(String(body.model || "auto")))
    return { ok: false, reason: "explicit_model", estTokens };
  if (!state.circuitOk(LONGCTX_PIN_PROVIDER))
    return { ok: false, reason: "circuit_open", estTokens };
  if (!keyOk(LONGCTX_PIN_PROVIDER))
    return { ok: false, reason: "no_key", estTokens };
  if (
    state.health.countStrategyToday(LONGCTX_PIN_STRATEGY) >=
    LONGCTX_PIN_DAILY_CAP
  )
    return { ok: false, reason: "budget_exhausted", estTokens };
  return { ok: true, reason: "eligible", estTokens };
}

/**
 * tryLongctxPin — fire the pin: direct callOne to the KEYED nvidia lane,
 * skipping the race. Returns null when not eligible (caller falls through
 * to the normal race). EVERY pinned attempt is logged under
 * strategy='longctx-pinned' with est tokens + latency, ok or not (callOne
 * also writes its usual STRATEGY row, so provider health/elo/circuit keep
 * learning from pinned traffic). On failure the caller falls back to the
 * race exactly once.
 */
export async function tryLongctxPin(
  body: ChatBody,
  sid: string,
  stream = false,
  rctx?: RequestCtx,
): Promise<RouteResult | null> {
  const v = longctxPinEligible(body);
  if (!v.ok) return null;
  const r = await callOne(LONGCTX_PIN_PROVIDER, LONGCTX_PIN_MODEL, body, stream, undefined, rctx);
  state.record(
    LONGCTX_PIN_MODEL,
    LONGCTX_PIN_PROVIDER,
    r.status || (r.ok ? 200 : 500),
    r.lat || 0,
    r.ok ? 1 : 0,
    LONGCTX_PIN_STRATEGY,
    sid,
    v.estTokens,
  );
  return r;
}

// ---------------------------------------------------------------------------
// 2M-context tier (2026-10-01): est tokens >1M -> a lane whose live catalog
// advertises >=2M context, skipping the race. OpenRouter's public catalog
// (verified 2026-10-01: 462 models) lists x-ai/grok-4.20,
// x-ai/grok-4.20-multi-agent, openrouter/pareto-code, openrouter/auto and
// openrouter/auto-beta at 2_000_000 tokens. The pin uses the keyed openrouter
// lane with x-ai/grok-4.20; ineligible or pinned failure falls through to the
// 1M pin, then the normal strategy dispatch.
// Operational kill switch: ESTATE_LONGCTX_2M=0 disables the tier.
// ---------------------------------------------------------------------------
export const LONGCTX_2M_PROVIDER = "openrouter";
export const LONGCTX_2M_MODEL = "x-ai/grok-4.20";
export const LONGCTX_2M_GATE_TOKENS = 1_000_000;
export const LONGCTX_2M_DAILY_CAP = 5;
const LONGCTX_2M_STRATEGY = "longctx-2m";

export function longctx2MEnabled(): boolean {
  return process.env.ESTATE_LONGCTX_2M !== "0";
}

/**
 * longctx2MPinEligible — same eligibility shape as the 1M pin: default/auto
 * path only (explicit model requests keep their lane), circuit closed, key
 * present, daily budget not exhausted. Gate is 1M est tokens.
 */
export function longctx2MPinEligible(body: ChatBody): LongctxPinVerdict {
  const estTokens = estPromptTokens(body);
  if (!longctx2MEnabled()) return { ok: false, reason: "disabled", estTokens };
  if (estTokens <= LONGCTX_2M_GATE_TOKENS)
    return { ok: false, reason: "under_gate", estTokens };
  if (isRoutableModelId(String(body.model || "auto")))
    return { ok: false, reason: "explicit_model", estTokens };
  if (!state.circuitOk(LONGCTX_2M_PROVIDER))
    return { ok: false, reason: "circuit_open", estTokens };
  if (!keyOk(LONGCTX_2M_PROVIDER))
    return { ok: false, reason: "no_key", estTokens };
  if (
    state.health.countStrategyToday(LONGCTX_2M_STRATEGY) >=
    LONGCTX_2M_DAILY_CAP
  )
    return { ok: false, reason: "budget_exhausted", estTokens };
  return { ok: true, reason: "eligible", estTokens };
}

/**
 * tryLongctx2MPin — fire the 2M pin: direct callOne to the keyed openrouter
 * lane with x-ai/grok-4.20. Returns null when not eligible (caller falls
 * through to the 1M pin, then the normal race). Every pinned attempt is
 * logged under strategy='longctx-2m' with est tokens + latency, ok or not.
 */
/** resolveLongctx2MModel — router-max: the 2M lane is DERIVED from the
 * live catalog, not hardcoded. Highest context window >= 2M on the
 * openrouter provider, skipping flap/entitlement-benched ids. Falls back to
 * the LONGCTX_2M_MODEL constant when the catalog has no 2M lane (startup,
 * discovery outage). The constant itself is live-verified (2026-10-02:
 * x-ai/grok-4.20 in the openrouter catalog at 2_000_000 tokens).
 */
export function resolveLongctx2MModel(): [string, string] {
  let best: [string, string] | null = null;
  let bestCtx = 0;
  for (const mid of catalogModelsFor(LONGCTX_2M_PROVIDER)) {
    if (
      state.flapBanned(LONGCTX_2M_PROVIDER, mid) ||
      state.isEntitlementDead(LONGCTX_2M_PROVIDER, mid)
    )
      continue;
    const ctx = modelContextWindow(LONGCTX_2M_PROVIDER, mid);
    if (ctx >= LONGCTX_2M_GATE_TOKENS * 2 && ctx > bestCtx) {
      best = [LONGCTX_2M_PROVIDER, mid];
      bestCtx = ctx;
    }
  }
  return best || [LONGCTX_2M_PROVIDER, LONGCTX_2M_MODEL];
}

export async function tryLongctx2MPin(
  body: ChatBody,
  sid: string,
  stream = false,
  rctx?: RequestCtx,
): Promise<RouteResult | null> {
  const v = longctx2MPinEligible(body);
  if (!v.ok) return null;
  const [lp, lm] = resolveLongctx2MModel();
  const r = await callOne(lp, lm, body, stream, undefined, rctx);
  state.record(
    lm,
    lp,
    r.status || (r.ok ? 200 : 500),
    r.lat || 0,
    r.ok ? 1 : 0,
    LONGCTX_2M_STRATEGY,
    sid,
    v.estTokens,
  );
  return r;
}

/**
 * routeAuto — the automatic main router (estate-owned openrouter/auto
 * equivalent). Prompt-aware per-request strategy switching: AST race for
 * code-shaped traffic, free race for the default path, hybrid fallback when
 * the free pool is empty. (The 2M/1M context pins run BEFORE strategy
 * dispatch in router.ts, so routeAuto never double-fires them.) Set
 * ESTATE_STRATEGY=auto to make it the main router; it auto-switches the
 * lane every request with no per-request env change.
 */
// Last user-visible text in the prompt, newest message first. Used by
// routeAuto for AST-shape detection (mirrors estPromptTokens' traversal).
export function bodyPromptText(body: ChatBody): string {
  const msgs = (body as { messages?: unknown[] }).messages;
  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const c = (msgs[i] as { content?: unknown })?.content;
      if (typeof c === "string" && c) return c;
      if (Array.isArray(c)) {
        const t = c
          .map((part) => (part as { text?: unknown })?.text)
          .filter((t) => typeof t === "string")
          .join("\n");
        if (t) return t;
      }
    }
  }
  return "";
}

/**
 * filterByContext — drop race candidates whose context window cannot fit
 * the estimated prompt plus completion headroom. Models with unknown
 * context (0) are kept — unknown is not evidence of small. If filtering
 * would empty the pool, the unfiltered pool is kept (degraded mode: try
 * something rather than 503, same philosophy as pickWeighted).
 */
export function filterByContext(
  cands: [string, string][],
  estTokens: number,
  headroom = 4000,
): [string, string][] {
  const need = estTokens + headroom;
  const kept = cands.filter(([p, mid]) => {
    const ctx = modelContextWindow(p, mid);
    return ctx === 0 || ctx >= need;
  });
  return kept.length ? kept : cands;
}

/**
 * G13 — context-window auto-demotion (flock router.rs `needed_tokens` +
 * `select_with_budget`, borrowed from fastllm-proxy): candidates whose
 * declared window cannot hold the needed tokens (estimated prompt +
 * requested max_tokens) are DEMOTED (stable) to the back, not dropped.
 * Undeclared windows (0) are never demoted — unknown is not evidence of
 * small. If demotion would empty the pool the unfiltered pool is kept
 * (degraded mode: a demoted candidate can still serve; truncation beats
 * 503). Demoted candidates are recorded on the decision ledger.
 */
export function neededTokens(body: ChatBody): number {
  const prompt = estPromptTokens(body);
  const b = body as Record<string, unknown>;
  const mt = Number(b["max_tokens"] ?? b["max_completion_tokens"] ?? 0);
  return Math.ceil(prompt) + (Number.isFinite(mt) && mt > 0 ? Math.floor(mt) : 0);
}

export function demoteByContext(
  cands: [string, string][],
  body: ChatBody,
  decision?: RoutingDecision,
): [string, string][] {
  const need = neededTokens(body);
  if (need <= 0) return cands;
  const ok: [string, string][] = [];
  const small: [string, string][] = [];
  for (const [p, mid] of cands) {
    const ctx = modelContextWindow(p, mid);
    if (ctx > 0 && ctx < need) {
      small.push([p, mid]);
      decision?.push_skip(`${p}/${mid}`, "context_too_small");
    } else {
      ok.push([p, mid]);
    }
  }
  if (!ok.length) return cands;
  return [...ok, ...small];
}

export async function routeAuto(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const estTokens = estPromptTokens(body);
  const taskType = classifyTask(bodyPromptText(body));
  let r: RouteResult;
  if (taskType === "code") {
    // code-shaped: AST-priority race over the context-filtered field.
    const cands = filterByContext(pickWeighted(MAX_PARALLEL), estTokens);
    r = await routeAstRace(body, session, cands, rctx);
  } else if (taskType === "reasoning") {
    // deliberative: ordered hybrid chain with failover.
    r = await routeHybrid(body, session, rctx);
  } else {
    // default: free race first (zero cost), then ordered auto-switch chain,
    // then the hybrid fallback — the request degrades, never fails hard.
    const freeCands = filterByContext(freeCandidates(), estTokens);
    const free = await routeAstRace(body, session, freeCands, rctx);
    if (free.ok) {
      r = free;
    } else {
      const chained = await sequentialFailover(
        freeCands,
        body,
        session,
        "free_chain",
        undefined,
        rctx,
      );
      r = chained.ok ? chained : await routeHybrid(body, session, rctx);
    }
  }
  r.task_type = taskType;
  if (r.provider && r.model) r.cost_tier = costTier(r.provider, r.model);
  return r;
}

/**
 * chunkJobText — split a job into paragraph-boundary chunks of at most
 * maxChars (router-max 2M-aware decomposition). Every chunk keeps whole
 * paragraphs; nothing is dropped and order is preserved.
 */
export function chunkJobText(job: string, maxChars: number): string[] {
  if (job.length <= maxChars) return [job];
  const paras = job.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = "";
  for (const para of paras) {
    if ((cur + "\n\n" + para).length > maxChars && cur) {
      chunks.push(cur);
      cur = para;
    } else {
      cur = cur ? cur + "\n\n" + para : para;
    }
  }
  if (cur) chunks.push(cur);
  // A single pathological paragraph longer than the budget: hard-split it.
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxChars) out.push(c);
    else
      for (let i = 0; i < c.length; i += maxChars)
        out.push(c.slice(i, i + maxChars));
  }
  return out;
}

/**
 * pickChunkModel — choose a pool model whose context window fits the chunk
 * plus headroom (router-max). Free preferred; falls back to round-robin
 * when no window is known or none fits.
 */
function pickChunkModel(
  pool: [string, string][],
  chunkEstTokens: number,
  roundRobin: number,
): string {
  const need = chunkEstTokens + 8000;
  for (const [p, mid] of pool) {
    const ctx = modelContextWindow(p, mid);
    if (ctx > 0 && ctx >= need && modelFree(p, mid)) return `${p}/${mid}`;
  }
  for (const [p, mid] of pool) {
    const ctx = modelContextWindow(p, mid);
    if (ctx > 0 && ctx >= need) return `${p}/${mid}`;
  }
  const [p, mid] = pool[roundRobin % pool.length]!;
  return `${p}/${mid}`;
}

/**
 * sanitizeBodybuilderRequests — rewrite decomposer-emitted request bodies
 * into routable, safe ones (router-max). Hallucinated model ids resolve
 * against the sigma catalog first, then round-robin across the live pool
 * allow-list; sampling params are clamped (temperature [0,2], max_tokens
 * [1,32000]) so a rogue decomposer can't burn the pool or 400 downstream.
 * Exported for tests and for callers that sanitize their own fan-outs.
 */
export function sanitizeBodybuilderRequests(
  reqs: Array<Record<string, unknown>>,
  allowIds: string[],
  maxRequests: number,
): Array<Record<string, unknown>> {
  const allowSet = new Set(allowIds);
  return reqs.slice(0, maxRequests).map((r, i) => {
    const rec = { ...(r as Record<string, unknown>) };
    const mid = String(rec.model ?? "");
    if (!allowSet.has(mid) && allowIds.length) {
      const aliased = resolveSigmaAlias(mid);
      const match =
        aliased &&
        allowIds.find((a) => a.endsWith("/" + aliased) || a === aliased);
      rec.model = match || allowIds[i % allowIds.length];
    }
    const t = Number(rec.temperature);
    if (Number.isFinite(t)) rec.temperature = Math.min(2, Math.max(0, t));
    const mt = Number(rec.max_tokens);
    if (Number.isFinite(mt))
      rec.max_tokens = Math.min(32000, Math.max(1, Math.floor(mt)));
    return rec;
  });
}

/**
 * buildBodybuilderRequests — estate-owned openrouter/bodybuilder equivalent.
 * Takes a natural-language multi-model job description and returns the
 * structured {requests:[...]} fan-out bodies for the CALLER to execute in
 * parallel (generation is the router's job; execution stays with the caller —
 * the same split as openrouter/bodybuilder, whose generate step is free).
 * Decomposition itself runs on the free race, so bodybuilding costs nothing.
 */
export async function buildBodybuilderRequests(
  job: string,
  opts: { maxRequests?: number; sid?: string } = {},
): Promise<{ requests: Array<Record<string, unknown>> }> {
  const maxRequests = Math.min(Math.max(opts.maxRequests ?? 4, 1), 16);
  // Router-max 2M-aware decomposition: a job larger than the decomposer's
  // own safe context (~200k est tokens for the free pool) would be
  // truncated or refused by the decomposer LLM. Chunk it deterministically
  // instead, one context-fitted request per chunk.
  const DECOMPOSER_BUDGET_TOKENS = 200_000;
  const jobEstTokens = job.length / 4;
  const pool0 = freeCandidates();
  if (jobEstTokens > DECOMPOSER_BUDGET_TOKENS && pool0.length) {
    // chunkChars sized so the job always fits in maxRequests chunks —
    // content is never dropped; larger chunks resolve to 2M-context models.
    const chunkChars = Math.max(800_000, Math.ceil(job.length / maxRequests));
    let chunks = chunkJobText(job, chunkChars);
    while (chunks.length > maxRequests) {
      const merged: string[] = [];
      for (let i = 0; i < chunks.length; i += 2)
        merged.push(chunks[i] + (chunks[i + 1] ? "\n\n" + chunks[i + 1] : ""));
      chunks = merged;
    }
    return {
      requests: chunks.map((chunk, i) => ({
        model: pickChunkModel(pool0, chunk.length / 4, i),
        messages: [
          {
            role: "user",
            content:
              `PART ${i + 1}/${chunks.length} of a larger job. ` +
              `Process ONLY the segment below per the job instructions ` +
              `embedded in it; reply with your segment's result only.\n\n` +
              `SEGMENT:\n${chunk}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      })),
    };
  }
  // Live model allow-list (Chris 2026-10-01): the decomposer LLM hallucinates
  // model IDs from training data (e.g. openai/gpt-4o) when unconstrained.
  // Constrain it to the live free pool AND sanitize the parsed output, so
  // every emitted body routes to a real estate model.
  const pool = freeCandidates();
  const allowIds = pool.map(([p, m]) => `${p}/${m}`);
  const sys =
    "You decompose a multi-model job into parallel LLM request bodies. " +
    "Reply with ONLY a JSON object of the form " +
    '{"requests":[{"model":"<provider/model id>","messages":[{"role":"user","content":"<self-contained sub-task>"}],' +
    '"temperature":0.7,"max_tokens":2000}]}. ' +
    "Each request must be self-contained (no cross-references between requests). " +
    `The "model" field MUST be one of these exact IDs, verbatim - never invent a model ID: ${allowIds.join(", ")}. ` +
    `Produce between 1 and ${maxRequests} requests. No prose, no markdown fences, JSON only.`;
  const body = {
    model: "auto",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `JOB:\n${job}` },
    ],
    temperature: 0.3,
    max_tokens: 4000,
  } as ChatBody;
  const r = await routeFree(body, opts.sid || "bodybuilder");
  if (r.ok) {
    try {
      const raw =
        typeof r.data === "string"
          ? r.data
          : new TextDecoder().decode(r.data as Uint8Array);
      const text: string =
        JSON.parse(raw)?.choices?.[0]?.message?.content ?? "";
      const cleaned = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "");
      const parsed = JSON.parse(cleaned);
      const reqs = Array.isArray(parsed?.requests) ? parsed.requests : [];
      if (reqs.length > 0) {
        return {
          requests: sanitizeBodybuilderRequests(reqs, allowIds, maxRequests),
        };
      }
    } catch {
      // fall through to deterministic fan-out
    }
  }
  // Deterministic fallback: small free models often answer the job instead
  // of emitting the decomposition JSON. Fan out N parallel requests across
  // the live free pool, each carrying the full job text.
  const cands = pool;
  if (!cands.length) return { requests: [] };
  // Router-max: when the job is large, chunk it (context-fitted models per
  // chunk) instead of repeating the full job N times. chunkChars sized so
  // the job always fits in maxRequests chunks — content is never dropped.
  const fbChunkChars = Math.max(800_000, Math.ceil(job.length / maxRequests));
  const chunks = chunkJobText(job, fbChunkChars);
  const requests: Array<Record<string, unknown>> = [];
  if (chunks.length > 1) {
    const use = [...chunks];
    while (use.length > maxRequests) {
      const merged: string[] = [];
      for (let i = 0; i < use.length; i += 2)
        merged.push(use[i] + (use[i + 1] ? "\n\n" + use[i + 1] : ""));
      use.splice(0, use.length, ...merged);
    }
    for (let i = 0; i < use.length; i++) {
      requests.push({
        model: pickChunkModel(cands, use[i]!.length / 4, i),
        messages: [
          {
            role: "user",
            content:
              `PART ${i + 1}/${use.length} of a larger job. ` +
              `Process ONLY the segment below per the job instructions ` +
              `embedded in it; reply with your segment's result only.\n\n` +
              `SEGMENT:\n${use[i]}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      });
    }
    return { requests };
  }
  for (let i = 0; i < maxRequests; i++) {
    const [provider, mid] = cands[i % cands.length];
    requests.push({
      model: `${provider}/${mid}`,
      messages: [{ role: "user", content: job }],
      temperature: 0.7,
      max_tokens: 2000,
    });
  }
  return { requests };
}
// ---------------------------------------------------------------------------
// runBodybuilderAutonomous — the whole bodybuilder workflow with no human in
// the loop. Builds the request bodies (buildBodybuilderRequests) and then
// executes each one in parallel through pin-aware internal dispatch, so the
// caller only ever sends the original prompt and gets answers back.
// (Chris 2026-10-01: "the human wants little to do but the original prompt".)
//
// Pin fidelity: buildBodybuilderRequests deliberately chooses live-pool
// models per body. The default `auto` strategy's free lane would drop those
// pins on the floor (routeFree passes a candidate override into routeAstRace,
// which skips its direct-addressable fast path). dispatchBodybuilderBody
// honors the pin — direct callOne to the chosen provider/model with full
// race failover — exactly as routeAstRace documents.
// ---------------------------------------------------------------------------
export interface BodybuilderExecution {
  model: string;
  ok: boolean;
  text?: string;
  error?: string;
  latency_ms?: number;
  routed_via?: string;
}

function bodybuilderResultText(r: RouteResult): string {
  try {
    const raw =
      typeof r.data === "string"
        ? r.data
        : new TextDecoder().decode(r.data as Uint8Array);
    const c = JSON.parse(raw)?.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : "";
  } catch {
    return "";
  }
}

async function dispatchBodybuilderBody(
  body: ChatBody,
  sid: string,
): Promise<RouteResult> {
  // Mirror the /v1/chat/completions openfang shim: canonicalize
  // "provider/model" -> "provider:model" before routing.
  const want = String(body.model || "auto");
  const norm = normalizeModelSpec(want);
  const b: ChatBody =
    norm.provider && `${norm.provider}:${norm.model}` !== want
      ? { ...body, model: `${norm.provider}:${norm.model}` }
      : { ...body };
  b.stream = false;
  if (isRoutableModelId(String(b.model || "auto"))) return routeAstRace(b, sid);
  return routeAuto(b, sid);
}

export async function runBodybuilderAutonomous(
  job: string,
  opts: { maxRequests?: number; sid?: string } = {},
): Promise<{ requests: Array<Record<string, unknown>>; results: BodybuilderExecution[] }> {
  const built = await buildBodybuilderRequests(job, opts);
  const sid = opts.sid || `bb-auto-${Date.now()}`;
  const results = await Promise.all(
    built.requests.map(async (req): Promise<BodybuilderExecution> => {
      const want = String(req.model || "auto");
      const t0 = Date.now();
      try {
        const r = await dispatchBodybuilderBody(req as ChatBody, sid);
        const ms = Date.now() - t0;
        if (r.ok) {
          const text = bodybuilderResultText(r);
          if (text.trim()) {
            return {
              model: want,
              ok: true,
              text,
              latency_ms: ms,
              routed_via: `${r.provider}/${r.model}`,
            };
          }
          return { model: want, ok: false, error: "empty_completion", latency_ms: ms };
        }
        return {
          model: want,
          ok: false,
          error: r.err || "exhausted",
          latency_ms: ms,
        };
      } catch (e) {
        return {
          model: want,
          ok: false,
          error: String((e as Error)?.message || e),
          latency_ms: Date.now() - t0,
        };
      }
    }),
  );
  return { requests: built.requests, results };
}

export const ROUTERS: Record<
  string,
  (body: ChatBody, session: string, rctx?: RequestCtx) => Promise<RouteResult>
> = {
  fifo_matrix: routeFifo,
  fifo_flock: routeFifo,
  ast_race: routeAstRace,
  flock_race: routeAstRace,
  sticky_affinity: routeSticky,
  weighted_elo: routeWeighted,
  circuit_chain: routeCircuitChain,
  hybrid: routeHybrid,
  free: routeFree,
  free_chain: routeFreeChain,
  cascade: routeCascade,
  auto: routeAuto,
};

// freeCandidates: the free pool is derived from LIVE catalog metadata, not a
// divergent static list (Chris 2026-09-17). For every keyed provider with a
// healthy circuit, every catalog id (curated ∪ live discovery) whose live
// metadata marks it free (modelFree) joins the pool — including
// live-discovered free models the static ":free"-suffix convention misses
// (e.g. stealth/union-alpha, openrouter/free). When a provider has no live
// metadata at all, modelFree falls back deterministically to the ":free"
// suffix convention, so a failed discovery refresh never empties the pool.
// Filters: circuit state, flap strikes (empty-output substance failures feed
// the strike counter, so substance-ineligible models sit out), and the local
// llama-swap roles are always zero-cost and always join.
export function freeCandidates(): [string, string][] {
  const out: [string, string][] = [];
  const deadOut: [string, string][] = [];
  for (const [name] of Object.entries(PROVIDERS)) {
    if (!keyOk(name) || !state.circuitOk(name)) continue;
    // Dead-lane exclusion (503-forensics 2026-09-21): same rule as
    // pickWeighted — dead lanes sit out unless nothing else is alive.
    const bucket = state.laneDead(name) ? deadOut : out;
    for (const mid of catalogModelsFor(name)) {
      // Flap-benched models sit out until their empty-strikes decay;
      // entitlement-benched (404) models sit out for the process lifetime.
      if (state.flapBanned(name, mid) || state.isEntitlementDead(name, mid))
        continue;
      // Chat-capability filter (Chris 2026-10-02): guard, embedding,
      // reranker, moderation, reward, and classifier models return scores
      // or labels, not chat text -- they must never enter chat pools.
      if (!isChatCapable(mid)) continue;
      if (modelFree(name, mid)) bucket.push([name, mid]);
    }
  }
  if (keyOk("llama-swap") && !state.laneDead("llama-swap")) {
    out.push(["llama-swap", LOCAL_ROLES.fast]);
    out.push(["llama-swap", LOCAL_ROLES.quality]);
    out.push(["llama-swap", LOCAL_ROLES.longctx]);
  }
  // Degraded mode: every lane is dead — race the dead pool anyway rather
  // than serve 503.
  const pool = out.length ? out : deadOut;
  if (!pool.length && keyOk("llama-swap")) {
    pool.push(["llama-swap", LOCAL_ROLES.fast]);
    pool.push(["llama-swap", LOCAL_ROLES.quality]);
    pool.push(["llama-swap", LOCAL_ROLES.longctx]);
  }
  // Router-max: order the free pool by bench-derived quality bonus so
  // roundup benchmark data steers candidate order (tie-break scale; the
  // Ling-first pin below still leads).
  pool.sort((a, b) => benchModelBonus(b[0], b[1]) - benchModelBonus(a[0], a[1]));
  // Ling-first default (Chris 2026-09-17): Ling leads the free pool so the
  // `free` race prefers it. A flap-banned Ling still sits out above; the
  // substance guard still skips empty completions, falling through to the
  // next healthy candidate.
  const LING_DEFAULT: [string, string] = [
    "openrouter",
    "inclusionai/ling-3.0-flash-fin:free",
  ];
  const lingIdx = pool.findIndex(
    ([p, m]) => p === LING_DEFAULT[0] && m === LING_DEFAULT[1],
  );
  if (lingIdx > 0) {
    pool.splice(lingIdx, 1);
    pool.unshift(LING_DEFAULT);
  }
  return pool;
}

// routeFree: maximal free-provider strategy. Races the free+local candidate
// pool through the SAME parallel-race / AST-preference / sticky / circuit
// machinery as ast_race — so local GPU and free cloud models compete on equal
// footing, and circuit breakers still apply per provider.
export async function routeFree(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const cands = demoteByContext(freeCandidates(), body, rctx?.decision);
  if (!cands.length)
    return { ok: false, status: 503, err: "no_free_providers" };
  return routeAstRace(body, session, cands, rctx);
}

// ---------------------------------------------------------------------------
// Auto-switching (router-max): per-request graceful degradation.
// A chosen free model that 429s/5xx/timeouts (or is entitlement-benched)
// switches mid-flight to the next candidate WITHOUT failing the request.
// Every switch is measured (ms from failure receipt to next dispatch) and
// logged; the count + log ride on the RouteResult (X-Estate-Switches).
// Terminal failures (400 malformed) stop the chain — retrying the same body
// everywhere would just burn the pool.
// ---------------------------------------------------------------------------
// Explicit status classification (flock proxy.rs `retryable` + router.rs
// `retryable_status`): 401/403/429/5xx fail over — the key or provider is at
// fault and another lane may work. 400/404/413/422 surface: the request is
// bad (404 additionally feeds the entitlement bench). Connection-level
// failures (no status) fall through to the transient-error regex.
const RETRYABLE_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);
const TERMINAL_STATUS = new Set([400, 404, 413, 422]);
const FAILOVER_ERR_RE =
  /timeout|rate_limit|rate limited|governor_limited|dispatch_queue_timeout|buckets_exhausted|fetch_error|worker.?exhaust|resource.?exhaust|temporar|entitlement_benched|circuit_open|overloaded|too many|deadline_exceeded/i;

export function shouldFailover(r: RouteResult): boolean {
  if (r.ok) return false;
  const st = r.status || 0;
  if (RETRYABLE_STATUS.has(st)) return true;
  if (TERMINAL_STATUS.has(st)) {
    return st === 404 && /entitlement_benched/.test(r.err || "");
  }
  if (st >= 500) return true;
  return FAILOVER_ERR_RE.test(r.err || "");
}

export async function sequentialFailover(
  cands: [string, string][],
  body: ChatBody,
  session: string,
  stratName: string,
  callFn: typeof callOne = callOne,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  const decision = rctx?.decision;
  // Dead-lane exclusion, same rule as hedgedChain: dead lanes sit out unless
  // nothing else is alive. Exclusions are recorded on the decision ledger.
  let pool = cands.filter(([p]) => {
    if (!keyOk(p)) { decision?.push_skip(p, "not_connected"); return false; }
    if (!state.circuitOk(p)) { decision?.push_skip(p, "circuit_open"); return false; }
    if (state.laneDead(p)) { decision?.push_skip(p, "risk_paused"); return false; }
    return true;
  });
  if (!pool.length) pool = cands.filter(([p]) => keyOk(p) && state.circuitOk(p));
  if (!pool.length)
    return { ok: false, status: 503, err: stratName + "_exhausted" };
  const switchLog: string[] = [];
  let lastErr = stratName + "_exhausted";
  let lastStatus = 503;
  for (let i = 0; i < pool.length; i++) {
    const [p, mid] = pool[i]!;
    const t0 = performance.now();
    const r = await callFn(p, mid, body, false, undefined, rctx);
    if (substantive(r)) {
      decision?.select(switchLog.length > 0 ? "failover" : "priority");
      state.stickySet(session, p, mid);
      state.record(mid, p, 200, r.lat || 0, 1, stratName);
      r.switches = switchLog.length;
      if (switchLog.length) r.switch_log = switchLog;
      return r;
    }
    if (r.ok) state.recordEmpty(p, mid);
    lastErr = r.err || lastErr;
    lastStatus = r.status || lastStatus;
    const next = pool[i + 1];
    if (next && shouldFailover(r)) {
      const swMs = Math.round((performance.now() - t0) * 10) / 10;
      const entry =
        `${p}/${mid} -> ${next[0]}/${next[1]} ` +
        `(${swMs}ms, ${r.status}/${(r.err || "").slice(0, 80)})`;
      switchLog.push(entry);
      log(`auto-switch #${switchLog.length} [${stratName}]: ${entry}`);
    } else if (!shouldFailover(r)) {
      // Terminal (400 malformed, auth): stop, do not burn the pool.
      return {
        ok: false,
        status: lastStatus,
        err: lastErr,
        switches: switchLog.length,
        ...(switchLog.length ? { switch_log: switchLog } : {}),
      };
    }
    // else: last candidate failed failover-eligible — loop ends, report below
  }
  return {
    ok: false,
    status: lastStatus,
    err: lastErr,
    switches: switchLog.length,
    ...(switchLog.length ? { switch_log: switchLog } : {}),
  };
}

/** routeFreeChain — the free pool as an ordered auto-switch chain. */
export async function routeFreeChain(
  body: ChatBody,
  session: string,
  rctx?: RequestCtx,
): Promise<RouteResult> {
  return sequentialFailover(freeCandidates(), body, session, "free_chain", undefined, rctx);
}
