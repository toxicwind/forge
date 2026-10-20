/**
 * First-class model pausing.
 *
 * When a provider gives direct errors (5xx, timeouts, connection failures),
 * the model gets PAUSED — temporarily removed from routing — instead of being
 * hammered. Pauses auto-expire with exponential backoff. This is distinct from
 * quarantine (dead slugs, 404s) and circuit breakers (provider-level).
 *
 * Red herrings that NEVER pause:
 * - 404 → quarantine (the slug is dead, not sick)
 * - 429 → rate limit (keypool backs off, the model is fine)
 * - 400 → client error (our request was bad, not the provider)
 * - 401/402/403 → key issues (credential plane handles)
 * - empty content → model quality (ledger tracks, not a pause trigger)
 *
 * Pause triggers (real failures):
 * - Timeouts (AbortSignal, network timeouts)
 * - 5xx (provider server errors)
 * - Connection failures (ECONNREFUSED, DNS, TLS, status 0)
 *
 * Provider-level: if 3+ models on a provider pause within 5 minutes,
 * the whole provider pauses for 5 minutes.
 */

export type PauseReason =
  | "timeout"
  | "server-error"
  | "connection-failed"
  | "manual"
  | "provider-cascade";

export type PauseEntry = {
  /** "model|provider" for model pauses, "provider:*" for provider pauses. */
  key: string;
  model: string | null;
  provider: string;
  reason: PauseReason;
  /** Consecutive pause-worthy failures. */
  strikes: number;
  /** When the pause lifts (epoch ms). */
  resumeAt: number;
  firstSeen: number;
  lastSeen: number;
  detail: string;
};

/** Backoff schedule: 30s, 60s, 2m, 5m, 10m (max). */
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

/**
 * Provider cascade: pause the provider only when the FAILURE RATE across its
 * models is high — not on an absolute count. Modern providers serve hundreds
 * of models; 3 failures out of 500 is noise, 3 out of 3 is a provider outage.
 * Cascade when >50% of distinct models attempted in the window are paused,
 * with a minimum of 3 distinct models to avoid single-model noise.
 */
const CASCADE_MIN_MODELS = 3;
const CASCADE_FAILURE_RATE = 0.5;
const CASCADE_WINDOW_MS = 5 * 60_000;
const CASCADE_PAUSE_MS = 5 * 60_000;

/** Statuses that are RED HERRINGS — never pause on these. */
const RED_HERRINGS = new Set([400, 401, 402, 403, 404, 429]);

/** Statuses that trigger a pause (real provider failures). */
const PAUSE_STATUSES = new Set([500, 502, 503, 504]);

/** Error substrings that indicate timeouts or connection failures. */
const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "aborted",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "network",
  "fetch failed",
];

export function isRedHerring(status: number | null): boolean {
  if (status === null) return false; // null status = network failure, not a herring
  return RED_HERRINGS.has(status);
}

export function shouldPause(status: number | null, error: string): boolean {
  // Explicit pause triggers: 5xx or timeout/connection patterns.
  if (status !== null && PAUSE_STATUSES.has(status)) return true;
  if (status === 0 || status === null) {
    const lower = error.toLowerCase();
    return TIMEOUT_PATTERNS.some((p) => lower.includes(p));
  }
  return false;
}

export class Pauser {
  private entries = new Map<string, PauseEntry>();
  /** Recent model pauses per provider: model -> timestamp, for cascade detection. */
  private recentPauses = new Map<string, Map<string, number>>();
  /** Distinct models attempted per provider in the window (for failure rate). */
  private attemptedModels = new Map<string, Map<string, number>>();

  private key(model: string | null, provider: string): string {
    return model ? `${model}|${provider}` : `${provider}:*`;
  }

  isPaused(model: string, provider: string): boolean {
    const now = Date.now();
    // Check model-level pause. Expired entries are kept (for strike count)
    // but report as not paused; list() prunes them.
    const mk = this.key(model, provider);
    const me = this.entries.get(mk);
    if (me && me.resumeAt > now) return true;
    // Check provider-level pause.
    const pk = this.key(null, provider);
    const pe = this.entries.get(pk);
    if (pe && pe.resumeAt > now) return true;
    return false;
  }

  get(model: string, provider: string): PauseEntry | undefined {
    return this.entries.get(this.key(model, provider));
  }

  list(): PauseEntry[] {
    const now = Date.now();
    // Prune expired.
    for (const [k, e] of this.entries) {
      if (e.resumeAt <= now) this.entries.delete(k);
    }
    return [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get count(): number {
    return this.list().length;
  }

  /**
   * Record a failure. Returns true if this triggered (or extended) a pause.
   * Red herrings return false immediately.
   */
  noteFailure(
    model: string,
    provider: string,
    status: number | null,
    error: string,
    detail: string = "",
  ): boolean {
    if (isRedHerring(status)) return false;
    if (!shouldPause(status, error)) return false;

    const now = Date.now();
    const k = this.key(model, provider);
    const existing = this.entries.get(k);

    let reason: PauseReason = "server-error";
    if (status === 0 || status === null) {
      const lower = error.toLowerCase();
      reason = TIMEOUT_PATTERNS.some((p) => lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted"))
        ? "timeout"
        : "connection-failed";
    }

    const strikes = (existing?.strikes ?? 0) + 1;
    const backoffIdx = Math.min(strikes - 1, BACKOFF_MS.length - 1);
    const resumeAt = now + BACKOFF_MS[backoffIdx]!;

    this.entries.set(k, {
      key: k,
      model,
      provider,
      reason,
      strikes,
      resumeAt,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      detail: detail || `${status ?? "network"}: ${error.slice(0, 200)}`,
    });

    // Cascade check: rate-based, not count-based.
    this.recordRecentPause(provider, model, now);
    this.checkCascade(provider, now);

    return true;
  }

  /** Manually pause a model or provider. */
  pause(model: string | null, provider: string, durationMs: number, reason: PauseReason = "manual", detail: string = ""): void {
    const now = Date.now();
    const k = this.key(model, provider);
    this.entries.set(k, {
      key: k,
      model,
      provider,
      reason,
      strikes: 1,
      resumeAt: now + durationMs,
      firstSeen: now,
      lastSeen: now,
      detail,
    });
  }

  /** Manually resume (unpause) a model or provider. */
  resume(model: string | null, provider: string): boolean {
    return this.entries.delete(this.key(model, provider));
  }

  /** Record that a model was attempted (for failure-rate denominator). */
  noteAttempt(model: string, provider: string): void {
    const now = Date.now();
    let m = this.attemptedModels.get(provider);
    if (!m) {
      m = new Map();
      this.attemptedModels.set(provider, m);
    }
    m.set(model, now);
    // Prune outside the window.
    const cutoff = now - CASCADE_WINDOW_MS;
    for (const [k, t] of m) {
      if (t <= cutoff) m.delete(k);
    }
  }

  private recordRecentPause(provider: string, model: string, now: number): void {
    let m = this.recentPauses.get(provider);
    if (!m) {
      m = new Map();
      this.recentPauses.set(provider, m);
    }
    m.set(model, now);
    // Prune outside the window.
    const cutoff = now - CASCADE_WINDOW_MS;
    for (const [k, t] of m) {
      if (t <= cutoff) m.delete(k);
    }
  }

  private checkCascade(provider: string, now: number): void {
    const paused = this.recentPauses.get(provider);
    const attempted = this.attemptedModels.get(provider);
    if (!paused || !attempted) return;

    const pausedCount = paused.size;
    const attemptedCount = attempted.size;

    // Need minimum distinct models AND >50% failure rate.
    if (pausedCount >= CASCADE_MIN_MODELS && attemptedCount > 0) {
      const rate = pausedCount / attemptedCount;
      if (rate >= CASCADE_FAILURE_RATE) {
        const pk = this.key(null, provider);
        // Don't re-cascade if already paused.
        if (!this.entries.has(pk)) {
          this.entries.set(pk, {
            key: pk,
            model: null,
            provider,
            reason: "provider-cascade",
            strikes: 1,
            resumeAt: now + CASCADE_PAUSE_MS,
            firstSeen: now,
            lastSeen: now,
            detail: `${pausedCount}/${attemptedCount} models paused (${Math.round(rate * 100)}% failure rate)`,
          });
        }
        // Reset after cascading.
        this.recentPauses.set(provider, new Map());
      }
    }
  }
}
