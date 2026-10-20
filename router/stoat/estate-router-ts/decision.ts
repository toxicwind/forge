/**
 * Routing decision ledger — port of flock-proxy's decision.rs.
 *
 * Every routing selection produces a RoutingDecision explaining WHY a
 * provider was chosen and which providers were skipped (and why), plus a
 * per-attempt ledger (provider, status, latency) as the retry loop runs.
 * The count alone can't explain a failover chain; the per-attempt record can.
 */

/** Maximum number of skipped providers kept on one decision record. */
export const MAX_ROUTING_SKIPS = 64;
/** Maximum per-attempt entries — a retry storm must not grow one record
 *  unbounded. Overflow attempts are dropped (first attempts win). */
export const MAX_ROUTING_ATTEMPTS = 64;

/** Why a provider was selected for an attempt. */
export type SelectionReason =
  | "priority"
  | "session_binding"
  | "response_affinity"
  | "websocket_connection"
  | "failover"
  | "context_demoted";

/** Why routing excluded a provider before any attempt. */
export type SkipReason =
  | "disabled"
  | "not_connected"
  | "risk_paused"
  | "model_not_listed"
  | "protocol_unsupported"
  | "streaming_unsupported"
  | "conversion_unavailable"
  | "circuit_open"
  | "rate_limited"
  | "websocket_disabled"
  | "websocket_unsupported"
  | "context_too_small";

export interface RoutingSkip {
  provider: string;
  reason: SkipReason;
}

export interface RoutingAttempt {
  provider: string;
  /** HTTP status, or 0 for a connection-level failure (no response). */
  status: number;
  latency_ms: number;
}

export class RoutingDecision {
  selected?: SelectionReason;
  skipped: RoutingSkip[] = [];
  attempts: RoutingAttempt[] = [];

  push_skip(provider: string, reason: SkipReason): void {
    if (this.skipped.length < MAX_ROUTING_SKIPS) {
      this.skipped.push({ provider, reason });
    }
  }

  push_attempt(provider: string, status: number, latencyMs: number): void {
    if (this.attempts.length < MAX_ROUTING_ATTEMPTS) {
      this.attempts.push({
        provider,
        status,
        latency_ms: Math.max(0, Math.round(latencyMs)),
      });
    }
  }

  select(reason: SelectionReason): void {
    this.selected = reason;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { skipped: this.skipped };
    if (this.selected) out.selected = this.selected;
    if (this.attempts.length) out.attempts = this.attempts;
    return out;
  }

  /**
   * Bounded single-line form for the X-Routing-Decision response header:
   * selection reason, skip count (+first few), attempt count.
   */
  compact(): string {
    const skips = this.skipped
      .slice(0, 8)
      .map((s) => `${s.provider}=${s.reason}`)
      .join(",");
    const attempts = this.attempts
      .slice(0, 16)
      .map((a) => `${a.provider}:${a.status}`)
      .join(",");
    return (
      `selected=${this.selected || "none"};` +
      `skips=${this.skipped.length}${skips ? `[${skips}]` : ""};` +
      `attempts=${this.attempts.length}${attempts ? `[${attempts}]` : ""}`
    );
  }
}
