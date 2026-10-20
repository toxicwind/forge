/**
 * Per-provider circuit breaking and rate limiting.
 *
 * Two failure modes, two mechanisms, one rule: neither may be bypassed.
 *
 * The breaker (`opossum`) stops us hammering a provider that is down. It opens
 * only after `breakerThreshold` calls inside the rolling window have ALL
 * failed (volumeThreshold + 100% error rate), so one blip cannot trip it.
 * Its own timeout is a backstop, NOT the per-attempt deadline: the Router's
 * AbortSignals fire first. (The previous build reused breakerResetMs (15s) as
 * the call timeout, which killed every completion slower than 15s.)
 *
 * The limiter (`bottleneck`) is a fixed-window RPM ceiling: the reservoir
 * refills to `rpm` every 60s. (The previous build set a reservoir with no
 * refresh, so a provider with *_RPM configured stalled forever after `rpm`
 * calls.)
 *
 * Both are keyed by provider so one provider's outage never degrades
 * another's path.
 */

import CircuitBreaker from "opossum";
import Bottleneck from "bottleneck";
import type { Config } from "./config.ts";

export type BreakerState = "closed" | "open" | "half-open";

/** Backstop only; must exceed the Router's hard ceiling. */
const REQUEST_TIMEOUT_MS = Number(process.env.CUTTINGGATE_REQUEST_TIMEOUT_MS) || 125_000;

type Breaker = CircuitBreaker<[unknown], unknown>;

function stateOf(b: Breaker): BreakerState {
  if (b.opened) return "open";
  if (b.halfOpen) return "half-open";
  return "closed";
}

export class ProviderGate {
  private breakers = new Map<string, Breaker>();
  private limiters = new Map<string, Bottleneck>();
  private empties = new Map<string, number>();

  constructor(private cfg: Config) {}

  private breaker(provider: string): Breaker {
    const existing = this.breakers.get(provider);
    if (existing) return existing;
    const made: Breaker = new CircuitBreaker(
      async (fn: unknown) => (fn as () => Promise<unknown>)(),
      {
        timeout: REQUEST_TIMEOUT_MS,
        errorThresholdPercentage: 100,
        volumeThreshold: this.cfg.breakerThreshold,
        resetTimeout: this.cfg.breakerResetMs,
        rollingCountTimeout: this.cfg.breakerResetMs * 4,
        name: provider,
      },
    );
    this.breakers.set(provider, made);
    return made;
  }

  private limiter(provider: string): Bottleneck {
    const existing = this.limiters.get(provider);
    if (existing) return existing;
    const rpm = this.cfg.rpm[provider] ?? 0;
    const made = new Bottleneck({
      maxConcurrent: this.cfg.maxConcurrent,
      ...(rpm > 0
        ? { reservoir: rpm, reservoirRefreshAmount: rpm, reservoirRefreshInterval: 60_000 }
        : {}),
    });
    this.limiters.set(provider, made);
    return made;
  }

  /**
   * Runs `fn` under the provider's breaker and limiter.
   *
   * An open breaker rejects immediately rather than waiting out the timeout, so
   * the caller can try another provider within the request's own budget.
   * `fn` must THROW for failures that should count against the provider and
   * RETURN for outcomes that must not (429s, model-level 404s, empties).
   */
  async run<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const limit = this.limiter(provider);
    // opossum's `fire` is typed against the `[unknown]` tuple the breaker was
    // constructed with, so the result arrives as unknown; the cast is confined
    // here where the caller's contract is known.
    const out = await limit.schedule(() => this.breaker(provider).fire(fn));
    return out as T;
  }

  /**
   * Counts a 200-shaped but empty response. Metric family matches flock's
   * `flock_model_empty_strikes` and estate-scripts-router's
   * `estate_router_model_empty_strikes` so the three stacks correlate.
   */
  noteEmpty(model: string): number {
    const n = (this.empties.get(model) ?? 0) + 1;
    this.empties.set(model, n);
    return n;
  }

  emptyStrikes(model: string): number {
    return this.empties.get(model) ?? 0;
  }

  state(provider: string): BreakerState {
    const b = this.breakers.get(provider);
    return b ? stateOf(b) : "closed";
  }

  snapshot(): { provider: string; state: BreakerState; failures: number; successes: number }[] {
    return [...this.breakers.entries()].map(([provider, b]) => ({
      provider,
      state: stateOf(b),
      failures: b.stats.failures,
      successes: b.stats.successes,
    }));
  }
}
