/**
 * Auto-quarantine for slugs that cannot serve.
 *
 * The failure this exists to stop is concrete: a routed model returns HTTP 404
 * because upstream retired the `:free` tier. The router retries it, the agent
 * dies mid-task, and nothing anywhere says "this slug is gone" — the error
 * surfaces as a provider fault instead of a model name.
 *
 * A slug is quarantined when, across two consecutive *successful* provider
 * refreshes, it either 404s at serve time or vanishes from the live listing.
 * "Consecutive successful" matters: a burst of 404s while the listing itself is
 * broken is an outage, not 117 dead models, and quarantining during an outage
 * empties the estate.
 *
 * Quarantine is never silent. Every entry is observable via `/quarantine` and
 * counted in metrics, and `/v1/models` marks hidden models rather than hiding
 * them, so a caller can always see why a slug is not being served.
 */

export type QuarantineReason = "serve-404" | "vanished" | "manual";

export type QuarantineEntry = {
  model: string;
  provider: string;
  reason: QuarantineReason;
  /** Consecutive successful refreshes that agreed on this verdict. */
  strikes: number;
  firstSeen: number;
  lastSeen: number;
  detail: string;
};

/** Two agreeing refreshes. One refresh cannot tell a dead slug from a blip. */
const STRIKE_THRESHOLD = 2;

export class Quarantine {
  private entries = new Map<string, QuarantineEntry>();
  /** Successful listings seen so far; strikes only accrue past the first. */
  private successfulListings = 0;

  isQuarantined(model: string): boolean {
    return this.entries.has(model);
  }

  get(model: string): QuarantineEntry | undefined {
    return this.entries.get(model);
  }

  list(): QuarantineEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get count(): number {
    return this.entries.size;
  }

  /**
   * Records the outcome of one provider refresh. Call this once per successful
   * listing; `missing` is every slug the listing did not contain.
   */
  observeListing(live: readonly string[], provider: string): void {
    this.successfulListings += 1;
    const present = new Set(live);
    for (const [model, entry] of this.entries) {
      if (entry.provider !== provider) continue;
      if (!present.has(model)) {
        entry.strikes += 1;
        entry.lastSeen = Date.now();
        if (entry.strikes >= STRIKE_THRESHOLD) {
          entry.reason = "vanished";
          entry.detail = `absent from ${provider} live listing on ${entry.strikes} consecutive successful refreshes`;
        }
      } else {
        entry.strikes = 0;
      }
    }
  }

  /** Records a serve-time 404. Cheap enough to call on every route. */
  noteServe404(model: string, provider: string, detail = "upstream 404"): void {
    if (this.successfulListings < STRIKE_THRESHOLD) return;
    const existing = this.entries.get(model);
    if (existing) {
      existing.strikes += 1;
      existing.lastSeen = Date.now();
      existing.detail = detail;
      return;
    }
    this.entries.set(model, {
      model,
      provider,
      reason: "serve-404",
      strikes: 1,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      detail,
    });
  }

  /** Operator escape hatch: a quarantined slug may still be pinned by hand. */
  release(model: string): boolean {
    return this.entries.delete(model);
  }
}