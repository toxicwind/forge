/**
 * flock/ts/strategy/strategy — routing strategies for Flock.
 *
 * Ported from estate-scripts-router's router_strategy.ts (v3.2). The behavioral
 * details are preserved exactly:
 *
 * - callOne: the single provider-call primitive. Entitlement-404 fail-fast
 *   guard → circuit guard → headers (Estate-Flock UA, openrouter referer
 *   + title, nvidia pool rotation with honest 429 when buckets are dry) →
 *   governor admission → AbortSignal fail-fast stack (CONNECT_MS headers
 *   budget, TTFT_MS first-chunk budget for streams, ATTEMPT_MS total cap)
 *   → hedged_loser→499 with NO circuit strike → worker-exhaustion checked
 *   BEFORE generic failure handling (model-scoped, never cools the lane)
 *   → stream first-chunk re-emit → ledger recordUsage (best-effort) →
 *   half→closed on success.
 * - Race doctrine: first-substantive-wins; hedged losers abort cleanly.
 * - Empty (non-substantive) completions are never winners — they feed the
 *   flap tracker instead.
 *
 * Adaptation: the original closed over the global `state` singleton. Every
 * function here takes StrategyDeps first; bindStrategies(deps) returns the
 * classic ROUTERS record of (body, session) => Promise<RouteResult>.
 */
import { recordUsage } from "./ledger.ts";
import {
  ATTEMPT_MS,
  ATTEMPT_STREAM_MS,
  CONNECT_MS,
  FIFO_MAX,
  HEDGE_MS,
  LOCAL_ROLES,
  MAX_PARALLEL,
  TTFT_MS,
  UA,
  isAst,
  modelFree,
} from "./catalog.ts";
import { isWorkerExhausted } from "./governor.ts";
import type { ProviderView, RouteResult, StrategyDeps, StrategyFn, ChatBody } from "./types.ts";

// ---------------------------------------------------------------------------
// Result inspection
// ---------------------------------------------------------------------------
function messageOf(r: RouteResult):
  | { content?: unknown; tool_calls?: unknown[] }
  | undefined {
  try {
    if (!r.data) return undefined;
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

/**
 * Structural stand-in for the DOM lib's ReadableStreamReadResult
 * (tsconfig lib is ESNext-only; the name isn't in bun-types).
 */
type StreamReadResult = { done: boolean; value: Uint8Array | undefined };

/**
 * Thin wrapper over deps.isRoutableModelId — kept as a free function so
 * tests and external callers use one name: explicit alias, local id,
 * provider:model / provider/model spec, or any catalog id on a keyed
 * provider. Unknown ids keep the race-everything behavior.
 */
export function isRoutableModelId(
  deps: StrategyDeps,
  model: string,
): boolean {
  return deps.isRoutableModelId(model);
}

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------
export async function callOne(
  deps: StrategyDeps,
  provider: string,
  model: string,
  body: ChatBody,
  stream = false,
  externalSignal?: AbortSignal,
): Promise<RouteResult> {
  const STRATEGY = deps.strategyName;
  // 404-entitlement bench (503-forensics 2026-09-21): fail fast with ZERO
  // attempt burn — this model id 404'd before (delisted or not entitled
  // for our key) and never heals by retrying. Every path funnels through
  // callOne, so this one guard covers races, chains, sticky, and streams.
  if (deps.isEntitlementDead(provider, model)) {
    return {
      ok: false,
      status: 404,
      provider,
      lat: 0,
      err: "entitlement_benched",
    };
  }
  if (!deps.circuitOk(provider)) {
    return {
      ok: false,
      status: 503,
      provider,
      lat: 0,
      err: "circuit_open",
    };
  }
  const conf: ProviderView | undefined = deps
    .providers()
    .find((v) => v.name === provider);
  if (!conf) {
    return {
      ok: false,
      status: 500,
      provider,
      lat: 0,
      err: "unknown_provider",
    };
  }
  const url = conf.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": UA,
    "Accept-Encoding": "identity",
  };
  if (!conf.noAuth) {
    // NVIDIA rotates across the multi-key pool (40 rpm token bucket per
    // key). All buckets dry is an honest 429 — falling back to the default
    // key would just burn a rate-limited key.
    const rk = provider === "nvidia" ? deps.resolveKey(provider) : null;
    if (provider === "nvidia" && !rk) {
      return {
        ok: false,
        status: 429,
        provider,
        lat: 0,
        err: "nvidia_buckets_exhausted",
      };
    }
    headers.Authorization = `Bearer ${rk || deps.resolveKey(provider)}`;
  } else {
    headers.Authorization = "Bearer <redacted>";
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://zed.dev";
    headers["X-Title"] = "Estate-Router";
  }
  // Model-pressure governor (AIMD, per provider/model): refused fast with
  // 429 when the model is at its worker cap or draining.
  const govKey = `${provider}/${model}`;
  const permit = deps.governorAdmit(govKey);
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
    deps.noteError(provider, 504, err);
    deps.record(model, provider, 504, lat, 0, STRATEGY);
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
      if (isWorkerExhausted(errText)) deps.noteWorkerExhausted(provider, model);
      deps.noteError(provider, resp.status, errText.slice(0, 200));
      deps.record(model, provider, resp.status, lat, 0, STRATEGY);
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
        let first: StreamReadResult | "ttft_timeout";
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
          deps.noteError(provider, 504, "ttft_timeout");
          deps.record(model, provider, 504, tlat, 0, STRATEGY);
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
        deps.record(model, provider, 200, lat, 0, STRATEGY);
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
      deps.record(model, provider, 200, lat, 0, STRATEGY);
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
    // 📒 ledger: record Gemini token usage for cost accounting.
    // Best-effort — never throws, never touches the response path.
    if (provider === "google" && /gemini/i.test(model)) {
      try {
        const usage = JSON.parse(new TextDecoder().decode(data))?.usage;
        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
          recordUsage({
            provider: String(provider),
            model: String(model),
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
          });
        }
      } catch { /* accounting must never break serving */ }
    }
    deps.record(model, provider, resp.status, lat, 0, STRATEGY);
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
    const elat = (performance.now() - start) / 1000;
    deps.record(model, provider, 500, elat, 0, STRATEGY);
    return {
      ok: false,
      status: 500,
      provider,
      lat: elat,
      err: String(e),
    };
  } finally {
    permit.release();
  }
}

/**
 * firstUsableModelFor — first catalog model that isn't flap-benched or
 * entitlement-benched. Race sets use this instead of the raw first model
 * so dead IDs never occupy a lane. Exported for regression tests.
 */
export function firstUsableModelFor(
  deps: StrategyDeps,
  p: string,
): string | undefined {
  for (const m of deps.servingModels(p)) {
    if (!deps.flapBanned(p, m) && !deps.isEntitlementDead(p, m)) return m;
  }
  return undefined;
}

// DECISION 12187 (B) — ADDITIVE-OPTIONAL, model-level quality term.
// Probe-verified (provider, model) pairs get a small documented bonus in
// the race score: +5 is tie-break scale against elo (hundreds-thousands),
// the latency penalty (elo − latencyEMA/50), and the existing rand*10
// jitter — it nudges ties, never overrides the breaker or elo.
// Reversible: ESTATE_MODEL_BONUS=0.
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

/** LING_DEFAULT: ling-first free-pool default (Chris 2026-09-17). */
export const LING_DEFAULT: [string, string] = [
  "openrouter",
  "inclusionai/ling-3.0-flash-fin:free",
];

export function pickWeighted(
  deps: StrategyDeps,
  n = MAX_PARALLEL,
): [string, string][] {
  // Dead-lane exclusion (503-forensics 2026-09-21): providers whose recent
  // attempts all failed sit out of the race — they never win, they only
  // burn the connect budget and steal slots from serving lanes. Degraded
  // fallback below keeps the "try something rather than 503" guarantee.
  const live: string[] = [];
  const dead: string[] = [];
  for (const v of deps.providers()) {
    const p = v.name;
    if (p === "herd") continue; // bonus lane below — always races healthy
    if (!deps.keyOk(p) || !deps.circuitOk(p)) continue;
    (deps.laneDead(p) ? dead : live).push(p);
  }
  // Degraded mode: every lane is dead — race the dead ones anyway (a lane
  // that recovered mid-window can still win) rather than serve 503.
  const pool = live.length ? live : dead;
  const scored: [number, string, string][] = [];
  for (const p of pool) {
    const mid = firstUsableModelFor(deps, p);
    if (!mid) continue;
    const sc =
      deps.candidateScore(p) + Math.random() * 10 + modelProbeBonus(p, mid);
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
    deps.keyOk("herd") &&
    deps.circuitOk("herd") &&
    !deps.laneDead("herd")
  ) {
    const mid = firstUsableModelFor(deps, "herd");
    if (mid && !seen.has("herd")) out.push(["herd", mid]);
  }
  if (!out.length && deps.keyOk("openrouter")) {
    // 2026-09-21: tencent/hy3:free delisted (404s) — ling is the live default.
    out.push(LING_DEFAULT);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------
export async function routeAstRace(
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
  candsOverride?: [string, string][],
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(deps, model) && !candsOverride) {
    // Direct-addressable id (alias, local id, or any curated/live catalog
    // id): go straight to its provider instead of racing.
    const [p, mid] = deps.resolveSpec(model);
    const r = await callOne(deps, p, mid, body);
    if (substantive(r)) {
      deps.stickySet(session, p, mid);
      deps.record(mid, p, 200, r.lat || 0, 1, "ast_race");
      return r;
    }
    if (r.ok) deps.recordEmpty(p, mid);
    // v3.2: explicit model failed -> fail over to the full candidate race
    // (resilience over strictness; the direct attempt stays the fast path).
  }
  const cands = candsOverride || pickWeighted(deps, MAX_PARALLEL);
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
      deps.stickySet(session, r.provider!, r.model!);
      deps.record(r.model!, r.provider!, 200, r.lat || 0, 1, "ast_race");
      finish(r);
    };
    cands.forEach(([p, mid], i) => {
      callOne(deps, p, mid, body, false, ctrls[i]!.signal).then((r) => {
        pending--;
        if (settled) return;
        if (!r.ok) {
          if (r.err && r.err !== "hedged_loser") lastErr = r.err;
        } else if (!substantive(r)) {
          // Non-substantive (empty/whitespace-only) completion: never a
          // winner — strike the model via the flap tracker.
          deps.recordEmpty(p, mid);
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
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(deps, model)) return routeAstRace(deps, body, session);
  const [p, m] = deps.stickyGet(session);
  if (p && deps.keyOk(p) && deps.circuitOk(p) && !deps.laneDead(p)) {
    const r = await callOne(deps, p, m || model, body);
    if (substantive(r)) return r;
    if (r.ok) deps.recordEmpty(p, m || model);
  }
  return routeAstRace(deps, body, session);
}

export async function routeWeighted(
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const cands = pickWeighted(deps, 1);
  if (!cands.length) return { ok: false, status: 503, err: "no_providers" };
  const [p, mid] = cands[0]!;
  const r = await callOne(deps, p, mid, body);
  if (substantive(r)) {
    deps.stickySet(session, p, mid);
    return r;
  }
  if (r.ok) deps.recordEmpty(p, mid);
  return {
    ok: false,
    status: r.ok ? 502 : r.status || 502,
    provider: p,
    lat: r.lat,
    err: r.ok ? "empty_completion" : r.err,
  };
}

export async function routeCircuitChain(
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(deps, model)) {
    const [p, mid] = deps.resolveSpec(model);
    if (deps.keyOk(p) && deps.circuitOk(p)) {
      const r = await callOne(deps, p, mid, body);
      if (substantive(r)) {
        deps.stickySet(session, p, mid);
        return r;
      }
      if (r.ok) deps.recordEmpty(p, mid);
      // v3.2: fall through to the chain (explicit_provider_unavailable is
      // no longer terminal while any backend is alive).
    }
  }
  const order = deps
    .providers()
    .map((v) => v.name)
    .sort((a, b) => deps.candidateScore(b) - deps.candidateScore(a));
  const cands: [string, string][] = [];
  for (const p of order) {
    const mid = firstUsableModelFor(deps, p);
    if (mid) cands.push([p, mid]);
  }
  return hedgedChain(deps, cands, body, session, "circuit_chain");
}

export async function routeFifo(
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  if (deps.fifoDepth >= FIFO_MAX) {
    return { ok: false, status: 429, err: "fifo_full" };
  }
  deps.fifoDepth++;
  try {
    return await routeAstRace(deps, body, session);
  } finally {
    deps.fifoDepth = Math.max(0, deps.fifoDepth - 1);
  }
}

export async function routeHybrid(
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const model = String(body.model || "auto");
  if (isRoutableModelId(deps, model)) {
    const [p, mid] = deps.resolveSpec(model);
    // HFT: the explicit lane is hedged — if it hasn't delivered within
    // HEDGE_MS, the weighted field races in parallel and first substantive
    // wins. A hanging explicit backend no longer costs the client its
    // full connect timeout before failover begins.
    const field = pickWeighted(deps, MAX_PARALLEL).filter(([cp]) => cp !== p);
    const r = await hedgedChain(deps, [[p, mid], ...field], body, session, "hybrid_direct");
    if (r.ok) return r;
    // v3.2: total explicit+field failure -> fall through to chain failover.
    return routeCircuitChain(deps, body, session);
  }
  const [p, m] = deps.stickyGet(session);
  if (p && deps.keyOk(p) && deps.circuitOk(p) && !deps.laneDead(p)) {
    const r = await callOne(deps, p, m || model, body);
    if (substantive(r)) return r;
    if (r.ok) deps.recordEmpty(p, m || model);
  }
  const r2 = await routeAstRace(deps, body, session);
  if (r2.ok) return r2;
  return routeCircuitChain(deps, body, session);
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
  deps: StrategyDeps,
  cands: [string, string][],
  body: ChatBody,
  session: string,
  stratName: string,
): Promise<RouteResult> {
  // Dead-lane exclusion (503-forensics 2026-09-21): lanes whose recent
  // attempts all failed sit out of the chain. Degraded fallback: if that
  // empties the set, try every circuitOk lane anyway rather than 503.
  let live = cands.filter(
    ([p]) => deps.keyOk(p) && deps.circuitOk(p) && !deps.laneDead(p),
  );
  if (!live.length) {
    live = cands.filter(([p]) => deps.keyOk(p) && deps.circuitOk(p));
  }
  if (!live.length) return { ok: false, status: 503, err: stratName + "_exhausted" };
  // A provider that just burned a full timeout must not lead the next chain
  // and burn another: sort healthy lanes first (stable — explicit preference
  // kept among equal strike counts). Demoted lanes still race at the hedge.
  live.sort(
    (a, b) => deps.consecutiveFailures(a[0]) - deps.consecutiveFailures(b[0]),
  );
  if (HEDGE_MS <= 0) {
    let lastErr = stratName + "_exhausted";
    for (const [p, mid] of live) {
      const r = await callOne(deps, p, mid, body);
      if (substantive(r)) {
        deps.stickySet(session, p, mid);
        deps.record(mid, p, 200, r.lat || 0, 1, stratName);
        return r;
      }
      if (r.ok) deps.recordEmpty(p, mid);
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
      const [p, mid] = live[idx++]!;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      pending++;
      const hedgeTimer = setTimeout(() => {
        if (!settled) {
          // Hedge: the preferred lane is slow — race the whole field.
          while (idx < live.length) fire();
        }
      }, HEDGE_MS);
      callOne(deps, p, mid, body, false, ctrl.signal).then((r) => {
        clearTimeout(hedgeTimer);
        pending--;
        if (settled) return;
        if (substantive(r)) {
          deps.stickySet(session, p, mid);
          deps.record(mid, p, 200, r.lat || 0, 1, stratName);
          settle(r);
        } else {
          if (r.ok) deps.recordEmpty(p, mid);
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
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const localFirst = ["herd", "kimi-auto", "nim-local"];
  const order = deps
    .providers()
    .map((v) => v.name)
    .sort((a, b) => {
      const la = localFirst.includes(a) ? 0 : 1;
      const lb = localFirst.includes(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      const am = firstUsableModelFor(deps, a);
      const bm = firstUsableModelFor(deps, b);
      const fa = am && modelFree(am, deps.liveMeta(a)[am]) ? 0 : 1;
      const fb = bm && modelFree(bm, deps.liveMeta(b)[bm]) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      // Port note: StrategyDeps exposes candidateScore (elo − latencyEMA/50)
      // rather than raw elo; the ordering signal is the same, with latency
      // awareness added.
      return deps.candidateScore(b) - deps.candidateScore(a);
    });
  const cands: [string, string][] = [];
  for (const p of order) {
    const mid = firstUsableModelFor(deps, p);
    if (mid) cands.push([p, mid]);
  }
  return hedgedChain(deps, cands, body, session, "cascade");
}

// ---------------------------------------------------------------------------
// 1M-context pin — oracle DECISION 12187, verdict A (CONDITIONAL).
// Evidence: probe session 1m-probe-20260921-1745 verified EXACT 1M-token
// needle retrieval on the KEYED lane below; OpenRouter :free caps at
// 262144 tokens (HTTP 400 at 500k) — no free lane can serve >262k, so the
// pin displaces no free lane (routing doctrine: ranking > free-on-provider
// > pay orders preference, not a pay ban).
// Mechanism: est-token gate -> DIRECT lane call, executing OUTSIDE the
// parallel race. BINDING GUARDS: (1) daily pinned-request cap (every pinned
// attempt burns key credits, logged under strategy='longctx-pinned' with
// est tokens + latency); (2) circuit check FIRST — open -> fall through to
// the normal race; never fight the breaker. On pinned failure the caller
// falls back to the race exactly once. The pin never sets session
// stickiness — it is size-deterministic, not session-affine.
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
export function longctxPinEligible(
  deps: StrategyDeps,
  body: ChatBody,
): LongctxPinVerdict {
  const estTokens = estPromptTokens(body);
  if (!longctxPinEnabled()) return { ok: false, reason: "disabled", estTokens };
  if (estTokens <= LONGCTX_PIN_GATE_TOKENS)
    return { ok: false, reason: "under_gate", estTokens };
  // Explicit model requests keep their direct lane — the pin only serves
  // the default/auto path.
  if (isRoutableModelId(deps, String(body.model || "auto")))
    return { ok: false, reason: "explicit_model", estTokens };
  if (!deps.circuitOk(LONGCTX_PIN_PROVIDER))
    return { ok: false, reason: "circuit_open", estTokens };
  if (!deps.keyOk(LONGCTX_PIN_PROVIDER))
    return { ok: false, reason: "no_key", estTokens };
  if (
    deps.countStrategyToday(LONGCTX_PIN_STRATEGY) >= LONGCTX_PIN_DAILY_CAP
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
  deps: StrategyDeps,
  body: ChatBody,
  sid: string,
  stream = false,
): Promise<RouteResult | null> {
  const v = longctxPinEligible(deps, body);
  if (!v.ok) return null;
  const r = await callOne(deps, LONGCTX_PIN_PROVIDER, LONGCTX_PIN_MODEL, body, stream);
  deps.record(
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
export function freeCandidates(deps: StrategyDeps): [string, string][] {
  const out: [string, string][] = [];
  const deadOut: [string, string][] = [];
  for (const v of deps.providers()) {
    const name = v.name;
    if (!deps.keyOk(name) || !deps.circuitOk(name)) continue;
    // Dead-lane exclusion (503-forensics 2026-09-21): same rule as
    // pickWeighted — dead lanes sit out unless nothing else is alive.
    const bucket = deps.laneDead(name) ? deadOut : out;
    for (const mid of deps.servingModels(name)) {
      // Flap-benched models sit out until their empty-strikes decay;
      // entitlement-benched (404) models sit out for the process lifetime.
      if (deps.flapBanned(name, mid) || deps.isEntitlementDead(name, mid))
        continue;
      if (modelFree(mid, deps.liveMeta(name)[mid])) bucket.push([name, mid]);
    }
  }
  if (deps.keyOk("herd") && !deps.laneDead("herd")) {
    out.push(["herd", LOCAL_ROLES.fast]);
    out.push(["herd", LOCAL_ROLES.quality]);
    out.push(["herd", LOCAL_ROLES.longctx]);
  }
  // Degraded mode: every lane is dead — race the dead pool anyway rather
  // than serve 503.
  const pool = out.length ? out : deadOut;
  if (!pool.length && deps.keyOk("herd")) {
    pool.push(["herd", LOCAL_ROLES.fast]);
    pool.push(["herd", LOCAL_ROLES.quality]);
    pool.push(["herd", LOCAL_ROLES.longctx]);
  }
  // Ling-first default (Chris 2026-09-17): Ling leads the free pool so the
  // `free` race prefers it. A flap-banned Ling still sits out above; the
  // substance guard still skips empty completions, falling through to the
  // next healthy candidate.
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
  deps: StrategyDeps,
  body: ChatBody,
  session: string,
): Promise<RouteResult> {
  const cands = freeCandidates(deps);
  if (!cands.length)
    return { ok: false, status: 503, err: "no_free_providers" };
  return routeAstRace(deps, body, session, cands);
}

// ---------------------------------------------------------------------------
// Strategy binding — the ROUTERS record over a concrete deps instance.
// ---------------------------------------------------------------------------
/**
 * bindStrategies — produce the classic ROUTERS record from a deps instance.
 * Strategies are the same names the serving layers know (fifo_matrix,
 * fifo_flock, ast_race, flock_race, sticky_affinity, weighted_elo,
 * circuit_chain, hybrid, free, cascade); each entry is (body, session).
 */
export function bindStrategies(deps: StrategyDeps): Record<string, StrategyFn> {
  return {
    fifo_matrix: (body, session) => routeFifo(deps, body, session),
    fifo_flock: (body, session) => routeFifo(deps, body, session),
    ast_race: (body, session) => routeAstRace(deps, body, session),
    flock_race: (body, session) => routeAstRace(deps, body, session),
    sticky_affinity: (body, session) => routeSticky(deps, body, session),
    weighted_elo: (body, session) => routeWeighted(deps, body, session),
    circuit_chain: (body, session) => routeCircuitChain(deps, body, session),
    hybrid: (body, session) => routeHybrid(deps, body, session),
    free: (body, session) => routeFree(deps, body, session),
    cascade: (body, session) => routeCascade(deps, body, session),
  };
}
