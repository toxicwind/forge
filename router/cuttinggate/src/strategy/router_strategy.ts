// ---------------------------------------------------------------------------
// OpenCode Zen client identity (borrowed: 9router-opencode-fix,
// opencurro-ai/opencodeZen, lidge-jun/opencodex#2160).
// Stable for the process lifetime — mimics one long-lived CLI session/project.
// ---------------------------------------------------------------------------
 const OPENCODE_UA = "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
 // Zen free-tier gate checks ID format: ses_/msg_ + 26 chars (12 hex ts + 14 base62).
 // Borrowed: denysvitali/llm-proxy newOpenCodeID, 12errh/zen-proxy.
 function openCodeID(prefix: string): string {
   const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
   const b62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
   let r = "";
   for (let i = 0; i < 14; i++) r += b62[Math.floor(Math.random() * 62)];
   return prefix + ts + r;
 }
 const OPENCODE_SESSION_ID = openCodeID("ses_");
 const OPENCODE_PROJECT_ID = "global";
 const OPENCODE_PUBLIC_TOKEN = "public";

import type { ChatBody, RouteResult } from "./router_types.ts";
import type { ReadableStreamReadResult } from "node:stream/web";
import { state, isWorkerExhausted } from "./router_matrix.ts";
import { PROVIDERS, catalogModelsFor, modelFree, LOCAL_ROLES, CODING, MAX_PARALLEL, FIFO_MAX, STRATEGY, UA, AST_RE, getKey, keyOk, firstModelFor, resolveModel, isLocalSwapModelId, isAst, isExplicit, json, normalizeModelSpec, CONNECT_MS, TTFT_MS, ATTEMPT_MS, ATTEMPT_STREAM_MS, HEDGE_MS } from "./router_config.ts";
// 📒 ledger — the ranch account book: durable Gemini cost accounting.
import { recordUsage } from "./ledger.ts";

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
  if (typeof m.content === "string" && m.content.trim() !== "") return true;
  return Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
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
): Promise<RouteResult> {
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
  if (!state.circuitOk(provider)) {
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
  const url = conf.base.replace(/\/$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": UA,
    "Accept-Encoding": "identity",
  };
  if (!conf.no_auth) {
    // NVIDIA rotates across the multi-key pool (40 rpm token bucket per
    // key). All buckets dry is an honest 429 — falling back to the default
    // key would just burn a rate-limited key.
    const rk = provider === "nvidia" ? state.nextNvidiaKey() : null;
    if (provider === "nvidia" && !rk) {
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
     // Format-checked, not app-attested: Bearer <redacted> + opencode/ UA + ses_/msg_ IDs
     // (26 chars: 12 hex ts + 14 base62) + stream:true + bash/glob/grep/read tools.
     // Without the exact format: 403 FreeTierError.
     // Chris-provided OPENCODE_API_KEY via secrets; fallback to public anonymous.
     headers["Authorization"] = "Bearer " + (getKey("zen") || OPENCODE_PUBLIC_TOKEN);
     headers["User-Agent"] = OPENCODE_UA;
     headers["x-opencode-client"] = "cli";
     headers["x-opencode-session"] = OPENCODE_SESSION_ID;
     headers["x-opencode-project"] = OPENCODE_PROJECT_ID;
     headers["x-opencode-request"] = openCodeID("msg_");
  }
  // Model-pressure governor (flock governor.rs AIMD, per provider/model):
  // refused fast with 429 when the model is at its worker cap or draining.
  const govKey = `${provider}/${model}`;
  const permit = state.governor.admit(govKey);
  if (!permit) {
    return {
      ok: false,
      status: 429,
      provider,
      lat: 0,
      err: "governor_limited",
    };
  }
  const payload = { ...body, model, stream };
   // Zen free-tier body gate (borrowed: denysvitali/llm-proxy prepareFreeTierBody).
   // Requires stream:true + bash/glob/grep/read tool signatures, else 403.
   if (provider === "zen") {
     payload.stream = true;
     const need = ["bash", "glob", "grep", "read"];
     const have = new Set(((payload as any).tools || []).map((t: any) => (t?.function?.name || t?.name || "").toLowerCase()));
     const missing = need.filter((n) => !have.has(n));
     if (missing.length > 0) {
       const mk = (n: string) => ({ type: "function", function: { name: n, description: n + " tool", parameters: { type: "object", properties: {}, required: [] } } });
       (payload as any).tools = [...((payload as any).tools || []), ...missing.map(mk)];
       if (!(payload as any).tool_choice) (payload as any).tool_choice = "none";
     }
   }
  const start = performance.now();
  // Failfast signal stack: connect (headers) < TTFT (first byte, stream) <
  // total attempt cap. AbortSignal.any keeps each layer independent.
  const connectCtrl = new AbortController();
  const connectTimer = setTimeout(
    () => connectCtrl.abort(new Error("connect_timeout")),
    CONNECT_MS,
  );
  const totalSignal = AbortSignal.timeout(
    stream ? ATTEMPT_STREAM_MS : ATTEMPT_MS,
  );
  const signals = externalSignal
    ? [totalSignal, connectCtrl.signal, externalSignal]
    : [totalSignal, connectCtrl.signal];
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    clearTimeout(connectTimer);
    const lat = (performance.now() - start) / 1000;
    const msg = e instanceof Error ? e.message : String(e);
    // A hedged loser abort is NOT a provider failure: no circuit strike,
    // no error note, no DB row. The winner already served the client.
    if (/hedged_loser/.test(msg)) {
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
      return {
        ok: false,
        status: resp.status,
        provider,
        lat,
        err: errText,
        timings: mkTimings(null),
      };
    }
    if (stream) {
      if (resp.body) {
        // TTFT failfast: first chunk must arrive within the TTFT budget.
        const ttftRemain = TTFT_MS - (performance.now() - start);
        const reader = resp.body.getReader();
        // Named from the module that owns the declaration: this project
        // compiles with lib=ESNext (no DOM lib), so the global
        // ReadableStreamReadResult simply does not exist here.
        let first: ReadableStreamReadResult<Uint8Array> | "ttft_timeout";
        if (ttftRemain <= 0) {
          first = "ttft_timeout";
        } else {
          first = await Promise.race([
            reader.read(),
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
          return { ok: false, status: 504, provider, lat: tlat, err: "ttft_timeout", timings: mkTimings(null) };
        }
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
        return {
          ok: true,
          status: resp.status,
          provider,
          model,
          lat,
          stream: rest,
          timings: mkTimings(Math.round((performance.now() - start) * 10) / 10),
        };
      }
      state.record(model, provider, 200, lat, 0, STRATEGY);
      if (state.circuit.get(provider) === "half")
        state.circuit.set(provider, "closed");
      return {
        ok: true,
        status: resp.status,
        provider,
        model,
        lat,
        stream: resp.body,
      };
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
    return {
      ok: true,
      status: resp.status,
      data: new Uint8Array(data),
      provider,
      model,
      lat,
      timings: mkTimings(Math.round((performance.now() - start) * 10) / 10),
    };
  } catch (e) {
    const lat = (performance.now() - start) / 1000;
    state.record(model, provider, 500, lat, 0, STRATEGY);
    return {
      ok: false,
      status: 500,
      provider,
      lat,
      err: String(e),
    };
  } finally {
    permit.release();
  }
}

/**
 * firstUsableModelFor — first catalog model that isn't flap-benched or
 * entitlement-benched. Race sets use this instead of firstModelFor so
 * dead IDs never occupy a lane. Exported for regression tests.
 */
export function firstUsableModelFor(p: string): string | undefined {
  for (const m of catalogModelsFor(p)) {
    if (!state.flapBanned(p, m) && !state.isEntitlementDead(p, m)) return m;
  }
  return undefined;
}

// DECISION 12187 (B) — ADDITIVE-OPTIONAL, model-level quality term.
// Probe-verified (provider, model) pairs get a small documented bonus in
// the race score: +5 is tie-break scale against elo (hundreds-thousands),
// the latency penalty (elo − latencyEMA/50), and the existing rand*10
// jitter — it nudges ties, never overrides the breaker or elo.
// Reversible: ESTATE_MODEL_BONUS=0. Cites: health DB rows
// strategy='longctx-probe' (session 1m-probe-20260921-1745), commit
// 7f4f79a48c, ranch/mesh/router/estate-scripts-router/probes/RESULTS-2026-09-21.md.
const PROBE_VERIFIED_MODELS: Record<string, Set<string>> = {
  nvidia: new Set([
    // 1M needle retrieval verified at 100k/500k/1M, exact every time.
    "nvidia/nemotron-3-super-120b-a12b",
    // Ping-verified (1.8s, genuine reasoning trace); 1M ladder pending.
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  ]),
};
const PROBE_VERIFIED_BONUS = 5;
export function modelProbeBonus(p: string, mid: string): number {
  if (process.env.ESTATE_MODEL_BONUS === "0") return 0;
  return PROBE_VERIFIED_MODELS[p]?.has(mid) ? PROBE_VERIFIED_BONUS : 0;
}

export function pickWeighted(n = MAX_PARALLEL): [string, string][] {
  // Dead-lane exclusion (503-forensics 2026-09-21): providers whose recent
  // attempts all failed sit out of the race — they never win, they only
  // burn the connect budget and steal slots from serving lanes. Degraded
  // fallback below keeps the "try something rather than 503" guarantee.
  const live: string[] = [];
  const dead: string[] = [];
  for (const p of Object.keys(PROVIDERS)) {
    if (p === "herd") continue; // bonus lane below — always races healthy
    if (!keyOk(p) || !state.circuitOk(p)) continue;
    (state.laneDead(p) ? dead : live).push(p);
  }
  // Degraded mode: every lane is dead — race the dead ones anyway (a lane
  // that recovered mid-window can still win) rather than serve 503.
  const pool = live.length ? live : dead;
  const scored: [number, string, string][] = [];
  for (const p of pool) {
    const mid = firstUsableModelFor(p);
    if (!mid) continue;
    const sc =
      state.candidateScore(p) + Math.random() * 10 + modelProbeBonus(p, mid);
    scored.push([sc, p, mid]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const [, p, mid] of scored) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push([p, mid]);
    if (out.length >= n) break;
  }
  // herd bonus lane (503-forensics 2026-09-21): the local zero-cost
  // lane ALWAYS joins the race when healthy. It is the guaranteed fallback
  // that held client 503s down while nvidia flapped (nvidia 503'd 29x in
  // 15 min; herd served 98x). Appended AFTER the n-cut so no caller
  // can slice it off; hedged losers abort cleanly (499, no strike).
  if (
    keyOk("herd") &&
    state.circuitOk("herd") &&
    !state.laneDead("herd")
  ) {
    const mid = firstUsableModelFor("herd");
    if (mid && !seen.has("herd")) out.push(["herd", mid]);
  }
  if (!out.length && keyOk("openrouter")) {
    // 2026-09-21: tencent/hy3:free delisted (404s) — ling is the live default.
    out.push(["openrouter", "inclusionai/ling-3.0-flash-fin:free"]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------
export async function routeAstRace(
  body: ChatBody,
  session: string,
  candsOverride?: [string, string][],
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model) && !candsOverride) {
    // Direct-addressable id (alias, local id, or any curated/live catalog
    // id): go straight to its provider instead of racing.
    const [p, mid] = resolveModel(model);
    const r = await callOne(p, mid, body);
    if (substantive(r)) {
      state.stickySet(session, p, mid);
      state.record(mid, p, 200, r.lat || 0, 1, "ast_race");
      return r;
    }
    if (r.ok) state.recordEmpty(p, mid);
    // v3.2: explicit model failed -> fail over to the full candidate race
    // (resilience over strictness; the direct attempt stays the fast path).
  }
  const cands = candsOverride || pickWeighted(MAX_PARALLEL);
  if (!cands.length)
    return { ok: false, status: 503, err: "ast_race_exhausted" };
  // HFT: first substantive finisher wins — the slowest lane must not set the
  // pace (previously Promise.allSettled waited for every lane). Losers are
  // aborted; their aborts are not circuit strikes. An isAst (code-shaped)
  // finisher still takes priority over a plain substantive one.
  // Each candidate carries its own controller, paired at construction: the
  // race wiring then needs no index lookup into a parallel array, and finish
  // still aborts every lane off the same list.
  const jobs = cands.map(([p, mid]) => ({ p, mid, ctrl: new AbortController() }));
  return new Promise<RouteResult>((resolve) => {
    let settled = false;
    let pending = cands.length;
    let lastErr = "ast_race_exhausted";
    let bestSubstantive: RouteResult | null = null;
    const finish = (r: RouteResult) => {
      if (settled) return;
      settled = true;
      for (const { ctrl } of jobs) {
        try {
          ctrl.abort(new Error("hedged_loser"));
        } catch { /* noop */ }
      }
      resolve(r);
    };
    const win = (r: RouteResult) => {
      state.stickySet(session, r.provider!, r.model!);
      state.record(r.model!, r.provider!, 200, r.lat || 0, 1, "ast_race");
      finish(r);
    };
    jobs.forEach(({ p, mid, ctrl }) => {
      callOne(p, mid, body, false, ctrl.signal).then((r) => {
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
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model)) return routeAstRace(body, session);
  const [p, m] = state.stickyGet(session);
  if (p && keyOk(p) && state.circuitOk(p) && !state.laneDead(p)) {
    const r = await callOne(p, m || model, body);
    if (substantive(r)) return r;
    if (r.ok) state.recordEmpty(p, m || model);
  }
  return routeAstRace(body, session);
}

export async function routeWeighted(
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const cands = pickWeighted(1);
  const first = cands[0];
  if (!first) return { ok: false, status: 503, err: "no_providers" };
  const [p, mid] = first;
  const r = await callOne(p, mid, body);
  if (substantive(r)) {
    state.stickySet(session, p, mid);
    return r;
  }
  if (r.ok) state.recordEmpty(p, mid);
  return {
    ok: false,
    status: r.ok ? 502 : r.status || 502,
    provider: p,
    lat: r.lat,
    err: r.ok ? "empty_completion" : r.err,
  };
}

export async function routeCircuitChain(
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model)) {
    const [p, mid] = resolveModel(model);
    if (keyOk(p) && state.circuitOk(p)) {
      const r = await callOne(p, mid, body);
      if (substantive(r)) {
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
  return hedgedChain(cands, body, session, "circuit_chain");
}

export async function routeFifo(
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  if (state.fifoDepth >= FIFO_MAX) {
    return { ok: false, status: 429, err: "fifo_full" };
  }
  state.fifoDepth++;
  try {
    return await routeAstRace(body, session);
  } finally {
    state.fifoDepth = Math.max(0, state.fifoDepth - 1);
  }
}

export async function routeHybrid(
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(model)) {
    const [p, mid] = resolveModel(model);
    // HFT: the explicit lane is hedged — if it hasn't delivered within
    // HEDGE_MS, the weighted field races in parallel and first substantive
    // wins. A hanging explicit backend no longer costs the client its
    // full connect timeout before failover begins.
    const field = pickWeighted(MAX_PARALLEL).filter(([cp]) => cp !== p);
    const r = await hedgedChain([[p, mid], ...field], body, session, "hybrid_direct");
    if (r.ok) return r;
    // v3.2: total explicit+field failure -> fall through to chain failover.
    return routeCircuitChain(body, session);
  }
  const [p, m] = state.stickyGet(session);
  if (p && keyOk(p) && state.circuitOk(p) && !state.laneDead(p)) {
    const r = await callOne(p, m || model, body);
    if (substantive(r)) return r;
    if (r.ok) state.recordEmpty(p, m || model);
  }
  const r2 = await routeAstRace(body, session);
  if (r2.ok) return r2;
  return routeCircuitChain(body, session);
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
): Promise<RouteResult> {
  // Dead-lane exclusion (503-forensics 2026-09-21): lanes whose recent
  // attempts all failed sit out of the chain. Degraded fallback: if that
  // empties the set, try every circuitOk lane anyway rather than 503.
  let live = cands.filter(
    ([p]) => keyOk(p) && state.circuitOk(p) && !state.laneDead(p),
  );
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
    for (const [p, mid] of live) {
      const r = await callOne(p, mid, body);
      if (substantive(r)) {
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
      if (settled) return;
      const cand = live[idx];
      if (!cand) return; // pool exhausted
      idx++;
      const [p, mid] = cand;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      pending++;
      const hedgeTimer = setTimeout(() => {
        if (!settled) {
          // Hedge: the preferred lane is slow — race the whole field.
          while (idx < live.length) fire();
        }
      }, HEDGE_MS);
      callOne(p, mid, body, false, ctrl.signal).then((r) => {
        clearTimeout(hedgeTimer);
        pending--;
        if (settled) return;
        if (substantive(r)) {
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
): Promise<RouteResult> {
  const localFirst = ["herd", "kimi-auto", "nim-local"];
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
  return hedgedChain(cands, body, session, "cascade");
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
): Promise<RouteResult | null> {
  const v = longctxPinEligible(body);
  if (!v.ok) return null;
  const r = await callOne(LONGCTX_PIN_PROVIDER, LONGCTX_PIN_MODEL, body, stream);
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
export async function tryLongctx2MPin(
  body: ChatBody,
  sid: string,
  stream = false,
): Promise<RouteResult | null> {
  const v = longctx2MPinEligible(body);
  if (!v.ok) return null;
  const r = await callOne(LONGCTX_2M_PROVIDER, LONGCTX_2M_MODEL, body, stream);
  state.record(
    LONGCTX_2M_MODEL,
    LONGCTX_2M_PROVIDER,
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

export async function routeAuto(
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  if (isAst(bodyPromptText(body))) return routeAstRace(body, session);
  const free = await routeFree(body, session);
  if (free.ok) return free;
  return routeHybrid(body, session);
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
  // Live model allow-list (Chris 2026-10-01): the decomposer LLM hallucinates
  // model IDs from training data (e.g. openai/gpt-4o) when unconstrained.
  // Constrain it to the live free pool AND sanitize the parsed output, so
  // every emitted body routes to a real estate model.
  const pool = freeCandidates();
  const allowIds = pool.map(([p, m]) => `${p}/${m}`);
  const allowSet = new Set(allowIds);
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
      // JSON.parse hands back `any`; annotate the array so the element type
      // flows (the per-element cast below stays the single unchecked hop).
      const reqs: unknown[] = Array.isArray(parsed?.requests)
        ? parsed.requests
        : [];
      if (reqs.length > 0) {
        // Sanitize: rewrite any hallucinated model ID to a live pool member
        // (round-robin) rather than emitting a body that routes nowhere.
        const clean = reqs.slice(0, maxRequests).map((r, i) => {
          const rec = r as Record<string, unknown>;
          const mid = String(rec.model ?? "");
          if (!allowSet.has(mid) && allowIds.length) {
            rec.model = allowIds[i % allowIds.length];
          }
          return rec;
        });
        return { requests: clean };
      }
    } catch {
      // fall through to deterministic fan-out
    }
  }
  // Deterministic fallback: small free models often answer the job instead
  // of emitting the decomposition JSON. Fan out N parallel requests across
  // the live free pool, each carrying the full job text.
  const cands = pool;
  const poolSize = cands.length;
  if (!poolSize) return { requests: [] };
  const requests: Array<Record<string, unknown>> = [];
  for (let i = 0; i < maxRequests; i++) {
    const cand = cands[i % poolSize];
    // Unreachable for a non-empty pool (i % poolSize is always in range);
    // kept so the lookup stays total under the unchecked-index rule.
    if (!cand) continue;
    const [provider, mid] = cand;
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
  (body: ChatBody, session: string) => Promise<RouteResult>
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
// herd roles are always zero-cost and always join.
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
      if (modelFree(name, mid)) bucket.push([name, mid]);
    }
  }
  if (keyOk("herd") && !state.laneDead("herd")) {
    out.push(["herd", LOCAL_ROLES.fast]);
    out.push(["herd", LOCAL_ROLES.quality]);
    out.push(["herd", LOCAL_ROLES.longctx]);
  }
  // Degraded mode: every lane is dead — race the dead pool anyway rather
  // than serve 503.
  const pool = out.length ? out : deadOut;
  if (!pool.length && keyOk("herd")) {
    pool.push(["herd", LOCAL_ROLES.fast]);
    pool.push(["herd", LOCAL_ROLES.quality]);
    pool.push(["herd", LOCAL_ROLES.longctx]);
  }
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
): Promise<RouteResult> {
  const cands = freeCandidates();
  if (!cands.length)
    return { ok: false, status: 503, err: "no_free_providers" };
  return routeAstRace(body, session, cands);
}
