/**
 * flock/ts/strategy/types — shared types for the Flock strategy tier.
 *
 * Ported from estate-scripts-router's router_types.ts. The strategy tier sits
 * above the policy tier (../policy: Elo, circuits, health analytics) and
 * below the serving layer: it decides WHICH provider/model serves a
 * request and executes the call with fail-fast hedging. The Rust proxy
 * owns the hot path; this package is the portable TS strategy library
 * the proxy, the dashboard, and bench tooling all consume.
 */

/** OpenAI-compatible chat request body (extra vendor fields pass through). */
export type ChatBody = Record<string, unknown> & {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
};

/** Per-hop timings (HFT: measure every hop) — populated by callOne. */
export interface RouteTimings {
  connect_ms: number;
  ttft_ms: number | null;
  total_ms: number;
}

/** Result of one routed attempt. */
export type RouteResult = {
  ok: boolean;
  status: number;
  provider?: string;
  model?: string;
  lat?: number;
  data?: Uint8Array | string;
  stream?: ReadableStream<Uint8Array> | null;
  err?: string;
  winner?: number;
  timings?: RouteTimings;
};

/**
 * ProviderView — the routing-relevant projection of a Roost ProviderDef.
 * Built by catalog.ts from the master provider catalog; the strategy tier
 * never reads provider config from anywhere else.
 */
export interface ProviderView {
  /** Canonical provider key, e.g. "groq". */
  name: string;
  /** Base URL for /chat/completions (no trailing slash). */
  baseUrl: string;
  /** Env var holding the API key. Never the key itself. */
  keyEnv: string;
  /** Alternate env var for multi-key pools (e.g. NVIDIA_API_KEYS). */
  keyEnvAlt?: string;
  /** True when the provider needs no auth (local lanes). */
  noAuth?: boolean;
  /** Static extra headers (User-Agent etc). */
  extraHeaders?: Record<string, string>;
}

/**
 * StrategyDeps — everything the routing strategies need from the world.
 *
 * This replaces estate-scripts-router's global `state` singleton (router_matrix
 * Matrix). The policy-backed implementation lives in deps.ts, built on
 * ../policy (EloEngine, CircuitPolicy, PolicyHealthDB) plus the Roost
 * catalog. Strategies take deps as their first argument so they stay
 * pure, testable, and portable across serving layers.
 */
export interface StrategyDeps {
  // -- catalog -----------------------------------------------------------
  /** All enabled provider views, in catalog order. */
  providers(): ProviderView[];
  /** Serving model ids for a provider (live discovery ∪ seeds, minus quarantine/dead). */
  servingModels(provider: string): string[];
  /** Live per-model metadata (pricing, context_length...) for /v1/models + modelFree. */
  liveMeta(provider: string): Record<string, Record<string, unknown>>;
  /** True when the provider has a usable key (or needs none). */
  keyOk(provider: string): boolean;
  /** Resolve the bearer key for a provider (pool-aware for nvidia). */
  resolveKey(provider: string): string;

  // -- policy (delegates to ../policy) -----------------------------------
  /** Circuit closed or half-open (half-open admits the probe). */
  circuitOk(provider: string): boolean;
  /** Dead-lane exclusion: recent attempts all failed. */
  laneDead(provider: string): boolean;
  /** Consecutive failure count (hedged-chain ordering). */
  consecutiveFailures(provider: string): number;
  /** Elo − latencyEMA/50 candidate score. */
  candidateScore(provider: string): number;
  /** 404-entitlement bench: model is dead for this key, process lifetime. */
  isEntitlementDead(provider: string, model: string): boolean;
  /** Flap bench: model returned empty completions too often recently. */
  flapBanned(provider: string, model: string): boolean;
  /** Record an empty (non-substantive) completion — feeds the flap tracker. */
  recordEmpty(provider: string, model: string): void;
  /**
   * Record one attempt outcome: health row + Elo update + circuit
   * transition, mirroring Matrix.record's semantics.
   */
  record(
    model: string,
    provider: string,
    status: number,
    latSec: number,
    winner?: number,
    strategy?: string,
    session?: string,
    estTokens?: number,
  ): void;
  /** Record a provider-level error signature (for /status forensics). */
  noteError(provider: string, status: number, err: string): void;
  /** Worker-exhaustion signature observed on provider/model. */
  noteWorkerExhausted(provider: string, model: string): void;

  // -- session affinity ---------------------------------------------------
  stickyGet(session: string): [string | null, string | null];
  stickySet(session: string, provider: string, model: string): void;

  // -- misc ----------------------------------------------------------------
  /** Pinned-strategy attempts served today (daily budget guard). */
  countStrategyToday(strategy: string): number;
  /** Model-pressure governor permit; null = refuse fast with 429. */
  governorAdmit(key: string): { release(): void } | null;
  /** FIFO admission depth (backpressure). */
  fifoDepth: number;
  /** Active strategy name (default "hybrid"). */
  strategyName: string;
  /** Log helper (stderr, [flock-strategy] prefix). */
  log(...args: unknown[]): void;

  // -- spec resolution ------------------------------------------------------
  /** (provider, model) resolution for a raw model spec (alias, provider:model, bare id). */
  resolveSpec(spec: string): [string, string];
  /**
   * True when the model id is directly addressable: CODING alias, local id,
   * "provider:model" / "provider/model" spec, or any catalog id on a keyed
   * provider. Unknown ids keep the race-everything behavior.
   */
  isRoutableModelId(model: string): boolean;
}

/** A bound routing strategy: (body, session) -> result. */
export type StrategyFn = (
  body: ChatBody,
  session: string,
) => Promise<RouteResult>;
