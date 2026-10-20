import type { RoutingDecision } from "./decision.ts";
export type ChatBody = Record<string, unknown> & {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
};

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
  // Per-hop timings (HFT: measure every hop) — populated by callOne.
  timings?: { connect_ms: number; ttft_ms: number | null; total_ms: number };
  // Auto-switching receipts (router-max): per-request graceful degradation.
  switches?: number;
  switch_log?: string[];
  // Cost-tier awareness + task-type classification (router-max).
  cost_tier?: "free" | "cheap" | "standard";
  task_type?: "code" | "reasoning" | "chat";
  /** G8: upstream x-interaction-id (Gemini Interactions turn handle). */
  interactionId?: string;
  /** G12: routing decision ledger for this request. */
  decision?: RoutingDecision;
};

// ---------------------------------------------------------------------------
// Flock-port request context (G4/G8/G9/G12). Threaded through routing as an
// optional last parameter; every field is optional so existing callers keep
// working unchanged.
// ---------------------------------------------------------------------------
export interface RequestCtx {
  /** G4: client deadline + client-hangup abort (AbortSignal.any of both). */
  signal?: AbortSignal;
  /** G4/G6: absolute deadline epoch-ms for deadline math / dispatch waits. */
  deadlineMs?: number;
  /** G8: client request headers — x-previous-interaction-id passthrough. */
  reqHeaders?: Headers;
  /** G9/G11: the /v1/* request path (labels, coalescing, non-chat proxy). */
  path?: string;
  /** G12: per-request routing decision ledger (populated during routing). */
  decision?: RoutingDecision;
  /** G2: raw client model id (stream_options no-inject keying). */
  model?: string;
}
