/**
 * router_error_queue.ts — the dynamic error router (2026-10-27, architect).
 *
 * A 429 is not a dead end. It is a SIGNAL with a family (the 7-family
 * classifier), a horizon, and a concurrency truth. This module turns that
 * signal into exactly one of two actions, WITHOUT burning a transport byte
 * while deciding:
 *
 *   dispatch — wait (≤ global 2s budget) for THIS lane's concurrency slot
 *              to open, then retry the same lane inline;
 *   reroute  — long-horizon families (spend cap / 7-day / 5-hour) and
 *              budget-exhausted short-horizon waits hand back immediately
 *              so the strategy layer picks the next candidate from the
 *              emergent capability matrix.
 *
 * Concurrency knowledge comes from the mimetite SSOT (maxConcurrency per
 * provider def, e.g. freeinference = 2). Lanes with unknown concurrency are
 * never queue-gated (the governor already protects them). While a request
 * waits here, NOTHING is sent upstream — zero transport, zero token burn.
 *
 * Fork provenance: chaos-ws-router (estate/bridge) pattern — stable front,
 * transparent lanes, zero-cost probing, per-decision logging — fused with
 * the chaos variant's rate_limit_deconvolution classifier.
 */
import {
  classifyRateLimit,
  type RateLimitSignal,
} from "./rate_limit_deconvolution.ts";

/** Global wait budget (architect: 2s). Zero-transport while queued. */
export const DEFAULT_WAIT_MS = Number(
  process.env.ESTATE_ERROR_QUEUE_WAIT_MS || "2000",
);

/** Families whose horizon is too long to ever wait on. */
const LONG_HORIZON: string[] = ["spend_cap", "seven_day", "five_hour"];

export interface ErrorQueueOpts {
  /** Wait budget override (tests use 0). Default DEFAULT_WAIT_MS. */
  budgetMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests pass an immediate resolver — no real timers). */
  sleep?: (ms: number) => Promise<void>;
}

export interface QueueDecision {
  action: "dispatch" | "reroute";
  waitedMs: number;
  signal?: RateLimitSignal;
}

export class GlobalErrorQueue {
  private inflight = new Map<string, number>();
  private caps = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((r) => setTimeout(r, ms));

  /** Register a lane's concurrency cap from the SSOT def. */
  setConcurrency(provider: string, cap: number): void {
    if (Number.isFinite(cap) && cap > 0) this.caps.set(provider, cap);
  }

  /** Track one in-flight upstream attempt (pre-fetch). */
  begin(provider: string): void {
    this.inflight.set(provider, (this.inflight.get(provider) || 0) + 1);
  }

  /** Release an in-flight attempt; wake the FIFO head if a slot opened. */
  end(provider: string): void {
    const n = Math.max(0, (this.inflight.get(provider) || 1) - 1);
    this.inflight.set(provider, n);
    const cap = this.caps.get(provider);
    const w = this.waiters.get(provider);
    if (w && w.length && (cap === undefined || n < cap)) (w.shift()!)();
  }

  saturates(provider: string): boolean {
    const cap = this.caps.get(provider);
    // Unknown concurrency → never gate here (governor owns that lane).
    if (cap === undefined) return false;
    return (this.inflight.get(provider) || 0) >= cap;
  }

  /**
   * Decide what a status + body + headers mean for THIS lane.
   * 429/529-class statuses classify; everything else dispatches untouched.
   */
  async decide(
    provider: string,
    status: number,
    bodyText: string,
    headers: Record<string, string | null | undefined>,
    opts?: ErrorQueueOpts,
  ): Promise<QueueDecision> {
    if (status !== 429 && status !== 529) {
      return { action: "dispatch", waitedMs: 0 };
    }
    const signal = classifyRateLimit(bodyText, headers);
    // Long horizons (or a retry-after > 30s) never wait — reroute now.
    if (
      LONG_HORIZON.includes(signal.family) ||
      signal.horizonSec > 30 ||
      signal.scope === "account"
    ) {
      return { action: "reroute", waitedMs: 0, signal };
    }
    // Short horizon: hold zero-transport for a slot on THIS lane.
    const budget = opts?.budgetMs ?? DEFAULT_WAIT_MS;
    if (!this.saturates(provider)) {
      return { action: "dispatch", waitedMs: 0, signal };
    }
    const t0 = (opts?.now ?? this.now)();
    const opened = await this.waitForSlot(provider, budget, opts);
    const waitedMs = (opts?.now ?? this.now)() - t0;
    return { action: opened ? "dispatch" : "reroute", waitedMs, signal };
  }

  /** Exposed: the FIFO slot-wait primitive (tests assert wake semantics). */
  waitForSlot(
    provider: string,
    budgetMs: number,
    opts?: ErrorQueueOpts,
  ): Promise<boolean> {
    const sleep = opts?.sleep ?? ((ms: number) => this.sleep(ms));
    if (budgetMs <= 0) return Promise.resolve(!this.saturates(provider));
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (opened: boolean) => {
        if (done) return;
        done = true;
        const arr = this.waiters.get(provider) || [];
        const i = arr.indexOf(wake);
        if (i >= 0) arr.splice(i, 1);
        resolve(opened);
      };
      const wake = () => finish(true);
      const arr = this.waiters.get(provider) || [];
      arr.push(wake);
      this.waiters.set(provider, arr);
      void sleep(budgetMs).then(() => finish(false));
    });
  }
}

/** Singleton — one global queue for the whole router process. */
export const errorQueue = new GlobalErrorQueue();

/** Reset for test isolation. */
export function _resetErrorQueueForTests(): void {
  errorQueue.inflight.clear();
  errorQueue.caps.clear();
  errorQueue.waiters.clear();
}
