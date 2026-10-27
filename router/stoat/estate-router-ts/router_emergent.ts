#!/usr/bin/env bun
/**
 * router_emergent.ts — the emergent completion interceptor.
 *
 * Motive (2026-10-27): the static breaker suite (circuit/strikes/flap/
 * entitlement/elo) detects KNOWN error signatures — a 402, a 502, a
 * zero-token handshake, a 404 entitlement. It is blind to *structural*
 * protocol divergence and *narrative surrender*: modern multi-parameter
 * models (nemotron-3.5-bolt, kimi-k3, minimax-m3, glm-5.3-flash,
 * qwen3.6-35b) each hold orthogonal completion contracts, and an
 * OpenAI-compatible tunnel economizes on that divergence as *agent
 * flailing* instead of a protocol state drop. The breaker must be
 * EMERGENT — able to detect failures it has never explicitly been told
 * about, by reasoning about the pipeline's structure rather than matching
 * known error strings.
 *
 * Three orthogonal mechanisms (User decision 2026-10-27):
 *   1. CAPABILITY GATING — fuse the catalog seed (mimetite/pinax), the
 *      live /v1/models `supported_sampling_parameters` probe, and the
 *      first-chunk behavioral fingerprint of an unknown model into a
 *      capability matrix. Before any dispatch, intersect the outgoing
 *      payload keys with the matrix so qwen3.6-35b never receives
 *      `thinking`, glm-5.3-flash never receives `thinking:{type:"disabled"}`
 *      (throws 400), and the right tool_stream/reasoning flags are set.
 *   2. ANTI-FLAIL INTERCEPTION — score every SSE stream in flight against
 *      BOTH lexical surrender bigrams AND structural collapse signals
 *      (cycled tool calls, n-gram repetition, finish_reason=stop with no
 *      tool call at a work step). Fuse into a confidence score; sever the
 *      stream mid-flight above threshold and redispatch.
 *   3. MULTI-TIER FALLBACK — a ranked re-dispatch chain where every tier
 *      is a DIFFERENT custom strategy (capability-match sibling, then
 *      preserved-reasoning sibling, then local gateway), not one algorithm
 *      run twice.
 *
 * Design: self-contained and independently testable against mock SSE
 * fixtures. `capabilityFor` / `sanitizePayload` / `scoreFlail` are pure;
 * the router threads the fused matrix + scorer into its stream loop.
 */
import type { ChatBody } from "./router_types.ts";

// ---------------------------------------------------------------------------
// 1. CAPABILITY MATRIX
// ---------------------------------------------------------------------------

/** A resolved model capability record — the fused view routing consumes. */
export interface ModelCapability {
  /** Sorted list of sampling parameters the model actually accepts. */
  params: string[];
  /** Source of the parameter claim: seed | live | fingerprint | default. */
  source: "seed" | "live" | "fingerprint" | "default";
  /** True when the model emits reasoning_content (hence wants it preserved). */
  emitsReasoning: boolean;
  /** True when the model expects streamed tool_calls (tool_stream). */
  expectsToolStream: boolean;
  /** True when the completion contract was inferred from live chunks,
   *  not trusted from a name string. */
  inferred: boolean;
  /** Free-tier flag (routing preference, not a capability). */
  free: boolean;
  /** Context window in tokens (0 = unknown). */
  contextLength: number;
  /** When the capability was last observed, epoch ms. */
  observedAt: number;
}

const DEFAULT_CAP: ModelCapability = {
  params: [],
  source: "default",
  emitsReasoning: false,
  expectsToolStream: false,
  inferred: false,
  free: false,
  contextLength: 0,
  observedAt: 0,
};

/**
 * capabilityFor — resolve the capability record for (provider, model).
 *
 * Fusion order (highest wins):
 *   1. fingerprint — from live first-chunk inspection (set by the router),
 *   2. live — from the /v1/models probe (supported_sampling_parameters),
 *   3. seed — from the catalog (mimetite/pinax seed of params),
 *   4. default — empty (the gateway will intersect to an empty allowed set
 *      and strip everything non-OpenAI-core, which is the safe minimal
 *      contract).
 *
 * The seed catalog is not trusted as behavioral fact: a catalog entry may
 * advertise `thinking` while the live probe shows it is unsupported
 * (D-2026-10-23 anomaly #2). Live and fingerprint override seed; a
 * mismatch between the two is surfaced as drift (see reportDrift).
 */
const fingerprint: Record<string, ModelCapability> = {};
const live: Record<string, ModelCapability> = {};
const seed: Record<string, Partial<ModelCapability>> = {};

export function capabilityFor(provider: string, model: string): ModelCapability {
  const key = `${provider}/${model}`;
  const f = fingerprint[key];
  if (f) return f;
  const l = live[key];
  if (l) return l;
  const s = seed[key];
  if (s) return { ...DEFAULT_CAP, ...s, observedAt: Date.now() };
  return { ...DEFAULT_CAP };
}

/** Seed the matrix from the catalog (mimetite/pinax). */
export function seedCapability(
  provider: string,
  model: string,
  cap: Partial<ModelCapability>,
): void {
  seed[`${provider}/${model}`] = cap;
}

/** Overlay live /v1/models parameters for a (provider, model) pair. */
export function observeLiveCapability(
  provider: string,
  model: string,
  params: string[] | undefined,
  contextLength?: number,
): void {
  live[`${provider}/${model}`] = {
    ...DEFAULT_CAP,
    params: Array.isArray(params) ? [...params].sort() : [],
    emitsReasoning: Array.isArray(params) && params.includes("reasoning_content"),
    expectsToolStream: Array.isArray(params) && params.includes("tool_stream"),
    inferred: false,
    free: false,
    contextLength: contextLength || 0,
    observedAt: Date.now(),
    source: "live",
  };
}

/** Overlay a first-chunk behavioral fingerprint for an unknown model. */
export function observeFingerprint(
  provider: string,
  model: string,
  cap: Partial<ModelCapability>,
): void {
  fingerprint[`${provider}/${model}`] = {
    ...DEFAULT_CAP,
    ...cap,
    source: "fingerprint",
    inferred: true,
    observedAt: Date.now(),
  };
}

/** True for parameters that are NOT part of the OpenAI-compatible core.
 *  These are the ones the capability gate may strip when a model does not
 *  advertise them. */
const OPENAI_CORE = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "tools",
  "tool_choice",
  "stream_options",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
]);

/**
 * sanitizePayload — intersection gate. Given the raw body and the resolved
 * capability, return a body with every non-core sampling key STRIPPED that
 * the model does not advertise. This is the fix for the orthogonal-hack:
 * qwen3.6-35b (sglang, no thinking/reasoning_effort) must never receive
 * them; glm-5.3-flash must never receive thinking:{type:"disabled"};
 * kimi-k3 must not lose preserved reasoning history.
 *
 * Core OpenAI keys are ALWAYS kept (the gateway contract); only
 * model-specific sampling flags are gated. Returns the sanitized payload
 * (a new object — the caller's body is never mutated).
 */
export function sanitizePayload(
  provider: string,
  model: string,
  body: ChatBody,
): ChatBody {
  const cap = capabilityFor(provider, model);
  const allowed = new Set([...OPENAI_CORE, ...cap.params]);
  const out: ChatBody = { ...body };
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) delete (out as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * fingerprintFirstChunk — inspect the first SSE delta chunks and derive a
 * behavioral capability for an unknown upstream. This is the ONLY signal
 * that does not trust the model name string: if the stream emits
 * reasoning_content but no tool_stream, we classify it kimi-k3/minimax-m3
 * style (preserve reasoning); if a single-tool async _task_id appears in a
 * user turn, classify it nemotron-3.5-bolt style.
 *
 * Returns partial capability to overlay via observeFingerprint.
 */
export function fingerprintFirstChunk(
  delta:
    | {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown;
      }
    | undefined,
): Partial<ModelCapability> {
  if (!delta) return {};
  const cap: Partial<ModelCapability> = {};
  if (delta.reasoning_content !== undefined) {
    cap.emitsReasoning = true;
    cap.source = "fingerprint";
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    cap.expectsToolStream = true;
    cap.source = "fingerprint";
  }
  return cap;
}

// ---------------------------------------------------------------------------
// 2. ANTI-FLAIL CONFIDENCE SCORER
// ---------------------------------------------------------------------------

/** Lexical surrender bigrams — narrative escape hatches models trained on
 *  2025-26 SWE RL trace data reach for instead of emitting a tool call or a
 *  state mutation. These are NOT authoritative alone: they anchor the
 *  lexical half of the confidence score. */
const SURRENDER_PHRASES: Array<{ re: RegExp; w: number }> = [
  { re: /\bhonest stopping point\b/i, w: 0.6 },
  { re: /\boutside my reach\b/i, w: 0.5 },
  { re: /\bBLOCKED[- ]external\b/i, w: 0.5 },
  { re: /\bnatural stopping point/i, w: 0.4 },
  { re: /\bmanufacturing busywork/i, w: 0.4 },
  { re: /\bcannot (?:proceed|continue|complete) further\b/i, w: 0.35 },
  { re: /\bno (?:further|more) (?:action|steps|progress) possible\b/i, w: 0.35 },
  { re: /\bI'm (?:unable|not able) to (?:help|continue)\b/i, w: 0.3 },
  { re: /\b(?:I am|I'm) unable to (?:continue|proceed|help|do this)\b/i, w: 0.4 },
  { re: /\b(?:this|that|it) is beyond my (?:reach|capa(bility)?)\b/i, w: 0.4 },
  { re: /\bsurrendering\b/i, w: 0.4 },
];

/** Structural collapse signals — these do not depend on a word at all. */
export interface FlailScore {
  /** 0..1 fused confidence that this stream is flailing / surrendering. */
  confidence: number;
  /** Which half drove it (lexical vs structural). */
  lexical: number;
  structural: number;
  /** Human-readable evidence (why). */
  reasons: string[];
  /** True above the sever threshold. */
  shouldSever: boolean;
  /** Hysteresis: this stream already seceding (once is enough). */
  severed?: boolean;
}

const SEVER_THRESHOLD = 0.7;

export function confidenceThreshold(): number {
  const v = Number(process.env.ESTATE_FLAIL_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : SEVER_THRESHOLD;
}

interface StructuralState {
  lastContent: string;
  lastToolCall: string;
  toolCalls: string[];
  contentWindow: string[];
  /** Rolling plaintext across chunk boundaries for phrase matching. */
  textBuffer: string;
  /** Total content characters emitted so far (surrender needs a short total). */
  totalContentChars: number;
  toolCallsInWindow: number;
  finishNoTool: boolean;
  windows: number;
}

export function newStructuralState(): StructuralState {
  return {
    lastContent: "",
    lastToolCall: "",
    toolCalls: [],
    contentWindow: [],
    textBuffer: "",
    totalContentChars: 0,
    toolCallsInWindow: 0,
    finishNoTool: false,
    windows: 0,
  };
}

/** n-gram overlap — fraction of windows that repeat the prior window's tail. */
function ngramRepeat(win: string[], n: number): number {
  if (win.length < n * 2) return 0;
  const a = win.slice(-n).join(" ");
  const b = win.slice(-n * 2, -n).join(" ");
  if (!a || !b) return 0;
  return a === b ? 1 : 0;
}

/**
 * scoreDelta — incrementally score an SSE delta against the structural
 * state plus lexical signals. Called per chunk; returns the running fused
 * score. `finish` true when the stream emitted finish_reason:stop.
 */
export function scoreDelta(
  stateSt: StructuralState,
  delta:
    | {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown;
      }
    | undefined,
  keepalive?: unknown,
  finish = false,
): FlailScore {
  const lexicalReasons: string[] = [];
  const structuralReasons: string[] = [];
  const content = typeof delta?.content === "string" ? delta.content : "";
  const toolCalls = Array.isArray(delta?.tool_calls)
    ? (delta as { tool_calls: unknown[] }).tool_calls
    : [];

  // Accumulate plaintext across chunk boundaries so a phrase split over
  // several SSE deltas is still caught (test: chunked surrender prose).
  if (content) stateSt.textBuffer = (stateSt.textBuffer + content).slice(-512);
  if (content) stateSt.totalContentChars += content.length;
  const contentText = stateSt.textBuffer;

  // --- lexical half -------------------------------------------------------
  let lexicalPhraseSum = 0;
  let lexicalBest = 0;
  if (contentText.trim()) {
    for (const { re, w } of SURRENDER_PHRASES) {
      if (re.test(contentText)) {
        lexicalBest = Math.max(lexicalBest, w);
        lexicalPhraseSum = Math.min(0.9, lexicalPhraseSum + w);
        lexicalReasons.push(`phrase:${re.source.slice(0, 30)}`);
      }
    }
  }
  // Independent surrender signals compound, but never alone reach certainty
  // (a lone weak phrase like weight 0.3 must not sever a 0.7 threshold).
  // Combine: compound the sum, but require the strongest single signal to
  // anchor it (a cluster of weak independent phrases still moves the needle,
  // but a lone 0.3 phrase stays below any reasonable sever threshold).
  const lexical = Math.min(0.85, Math.max(lexicalBest, lexicalPhraseSum * 0.9));

  // --- structural half ------------------------------------------------------
  let structural = 0;
  // tool-call cycling: repeating tool calls into the window
  if (toolCalls.length > 0) {
    const id = JSON.stringify(toolCalls);
    if (id === stateSt.lastToolCall) {
      stateSt.toolCallsInWindow++;
      structuralReasons.push("tool_call_repeat");
    } else {
      stateSt.lastToolCall = id;
    }
    if (stateSt.toolCallsInWindow >= 3) {
      structural = Math.max(structural, 0.8);
      structuralReasons.push("tool_call_cycle_x3");
    } else if (stateSt.toolCallsInWindow >= 1) {
      structural = Math.max(structural, 0.4);
    }
  }
  // n-gram content repetition
  if (content.trim()) {
    stateSt.contentWindow.push(content);
    if (stateSt.contentWindow.length > 12) stateSt.contentWindow.shift();
    const rep = ngramRepeat(stateSt.contentWindow, 3);
    if (rep > 0) {
      structural = Math.max(structural, 0.35 + rep * 0.35);
      structuralReasons.push("n_gram_repeat");
    }
  }
  // finish_reason=stop with no tool call and the WHOLE stream carried only
  // minimal content = surrender (a normal stream end on real output is not).
  if (finish && toolCalls.length === 0 && stateSt.totalContentChars < 120) {
    structural = Math.max(structural, 0.75);
    structuralReasons.push("finish_stop_no_tool");
  }

  // reasoning-only stream (no content, only reasoning_content) for too long
  // signals a model lobotomized by a stripped parameter.
  if (
    delta?.reasoning_content !== undefined &&
    content === "" &&
    toolCalls.length === 0
  ) {
    structural = Math.max(structural, 0.25);
    structuralReasons.push("reasoning_only");
  }

  // --- fuse ----------------------------------------------------------------
  // Lexical and structural are orthogonal evidence: fuse with a soft OR that
  // never lets one half alone max out unless it is already decisive.
  const confidence = Math.min(1, lexical + structural - lexical * structural);
  const shouldSever = confidence >= confidenceThreshold();
  return {
    confidence,
    lexical,
    structural,
    reasons: [...lexicalReasons, ...structuralReasons],
    shouldSever,
  };
}

// ---------------------------------------------------------------------------
// 3. MULTI-TIER FALLBACK REDISPATCH
// ---------------------------------------------------------------------------

export type FallbackTier = "capability" | "reasoning" | "local";

/**
 * buildFallbackChain — every tier is a DIFFERENT custom strategy:
 *   tier 0 capability — a sibling model whose capability matrix matches the
 *     requested task (e.g. same reasoning family) on a different provider.
 *   tier 1 reasoning — a preserved-reasoning sibling (emitsReasoning) that
 *     can absorb the severed reasoning stream without re-prompting.
 *   tier 2 local — the local bornite lane (zero-cost guaranteed fallback).
 * Ranked: the caller tries tier 0, then tier 1, then tier 2.
 */
export function buildFallbackChain(
  provider: string,
  model: string,
  available: Array<[string, string]>,
): Array<{ tier: FallbackTier; provider: string; model: string }> {
  const mine = capabilityFor(provider, model);
  const chain: Array<{ tier: FallbackTier; provider: string; model: string }> = [];
  const seen = new Set(`${provider}/${model}`);

  // tier 0 — capability-match sibling (same emitsReasoning family)
  for (const [p, m] of available) {
    const k = `${p}/${m}`;
    if (seen.has(k)) continue;
    const c = capabilityFor(p, m);
    if (c.emitsReasoning === mine.emitsReasoning && c.inferred !== true) {
      chain.push({ tier: "capability", provider: p, model: m });
      seen.add(k);
      if (chain.length >= 1) break;
    }
  }
  // tier 1 — preserved-reasoning sibling
  for (const [p, m] of available) {
    const k = `${p}/${m}`;
    if (seen.has(k)) continue;
    const c = capabilityFor(p, m);
    if (c.emitsReasoning) {
      chain.push({ tier: "reasoning", provider: p, model: m });
      seen.add(k);
      if (chain.length >= 2) break;
    }
  }
  // tier 2 — local lane (bornite)
  for (const [p, m] of available) {
    const k = `${p}/${m}`;
    if (seen.has(k)) continue;
    if (p === "bornite") {
      chain.push({ tier: "local", provider: p, model: m });
      seen.add(k);
      break;
    }
  }
  return chain;
}

// ---------------------------------------------------------------------------
// 4. DRIFT ANOMALY REPORTING
// ---------------------------------------------------------------------------

export interface DriftRecord {
  provider: string;
  model: string;
  seedParams: string[];
  liveParams: string[];
  observedAt: string;
}

/** Capability drifts (catalog vs live) collected since startup. */
const drifts: DriftRecord[] = [];

export function reportDrift(
  provider: string,
  model: string,
  seedParams: string[] | undefined,
  liveParams: string[] | undefined,
): DriftRecord | null {
  if (!seedParams || !liveParams) return null;
  const s = new Set(seedParams);
  const l = new Set(liveParams);
  const missing = seedParams.filter((x) => !l.has(x));
  const extra = liveParams.filter((x) => !s.has(x));
  if (missing.length === 0 && extra.length === 0) return null;
  const rec: DriftRecord = {
    provider,
    model,
    seedParams: [...seedParams],
    liveParams: [...liveParams],
    observedAt: new Date().toISOString(),
  };
  drifts.push(rec);
  if (drifts.length > 500) drifts.shift();
  return rec;
}

export function driftLedger(): DriftRecord[] {
  return [...drifts];
}

 // ---------------------------------------------------------------------------
 // 5. STREAM INTERCEPTION WRAPPER
 // ---------------------------------------------------------------------------

 export interface InterceptOptions {
   provider: string;
   model: string;
   /** Called exactly once when the confidence passes the sever threshold.
    *  The caller is expected to cancel the underlying reader and redispatch. */
   onSever: (score: FlailScore) => void;
   /** Optional per-chunk capability inference for an unknown model. */
   onFingerprint?: (delta: unknown) => void;
   /** Max bytes buffered per SSE record before flushing (safety). */
   maxRecordBytes?: number;
 }

 /**
  * interceptStream — wrap an upstream SSE ReadableStream, score every decoded
  * `data:` record for flail/surrender, and fire onSever the moment the fused
  * confidence clears the threshold. Pass-through drops (the stream both
  * re-emits every original byte and keeps {record} telemetry hot). Returning
  * the same upstream chunks unchanged means the client sees identical bytes
  * unless a sever fires.
  */
 export function interceptStream(
   upstream: ReadableStream<Uint8Array>,
   opts: InterceptOptions,
 ): ReadableStream<Uint8Array> {
   const maxRecord = opts.maxRecordBytes ?? 1_000_000;
   return new ReadableStream<Uint8Array>({
     async start(controller) {
       const reader = upstream.getReader();
       const dec = new TextDecoder();
       const st = newStructuralState();
       let buf = "";
       let severed = false;
        let fingerprinted = false;
       try {
         for (;;) {
           const { done, value } = await reader.read();
           if (done) break;
           buf += dec.decode(value, { stream: true });
           if (buf.length > maxRecord) {
             // pathological balloon: flush what we have without scoring
             controller.enqueue(new TextEncoder().encode(buf));
             buf = "";
             continue;
           }
           // Score whole SSE records (split on blank-line frames).
           let idx: number;
           while ((idx = buf.indexOf("\n\n")) !== -1) {
             const frame = buf.slice(0, idx);
             buf = buf.slice(idx + 2);
             let delta: unknown;
             let finish = false;
             for (const line of frame.split("\n")) {
               if (!line.startsWith("data: ")) continue;
               const data = line.slice(6).trim();
               if (data === "[DONE]") {
                 continue;
               }
               try {
                 const parsed = JSON.parse(data);
                 const ch = parsed?.choices?.[0];
                 if (ch?.delta !== undefined) delta = ch.delta as unknown;
              // finish only counts when a real choices frame carries
                 // finish_reason — a bare [DONE] event is just stream end,
                 // not evidence of surrender. Everything else in a frame
                 // (including content deltas) is a normal flowing stream.
                 if (ch?.finish_reason) finish = true;
               } catch { /* keepalive */ }
             }
             const score = scoreDelta(
               st,
               (delta ?? undefined) as { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } | undefined,
               undefined,
               finish,
             );
             if (opts.onFingerprint && delta !== undefined && !fingerprinted) {
               fingerprinted = true;
               opts.onFingerprint(delta);
             }
             if (score.shouldSever && !severed) {
               severed = true;
               score.severed = true;
               opts.onSever(score);
               try {
                 reader.cancel();
               } catch { /* noop */ }
               controller.close();
               return;
             }
           }
           // Re-emit the original chunk bytes unchanged (pass-through).
           controller.enqueue(value);
         }
         if (buf) controller.enqueue(new TextEncoder().encode(buf));
         controller.close();
       } catch (e) {
         controller.error(e);
       } finally {
         try {
           reader.releaseLock();
         } catch { /* noop */ }
       }
     },
   });
 }

/** Reset seed matrix (hot reload / test isolation). */
export function _resetForTests(): void {
  for (const m of [fingerprint, live, seed]) {
    for (const k of Object.keys(m)) delete m[k];
  }
  drifts.length = 0;
}