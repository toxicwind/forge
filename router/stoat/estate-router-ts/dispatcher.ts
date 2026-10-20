/**
 * FIFO slot dispatcher — port of flock-proxy's dispatch.rs.
 *
 * Every attempt funnels through one FIFO queue per provider, so under
 * contention slots are granted strictly in arrival order instead of letting
 * freshly-arrived requests win wakeup races against long waiters.
 *
 * Grants are paced with a minimum gap between consecutive grants (Rust's
 * GRANT_GAP = 25ms): this caps burst *concurrency* — a cold pool granting
 * its full aggregate RPM instantly looks like a stampede upstream — without
 * capping throughput (25ms = 2,400 grants/min, far beyond any realistic
 * key pool's aggregate RPM).
 *
 * Single-threaded port: one async pump loop per dispatcher instead of a
 * spawned task; a per-waiter heartbeat interval keeps SSE clients informed
 * while queued (Rust heartbeats during permit/slot waits).
 */
export interface Slot {
  provider: string;
  /** Milliseconds this waiter spent queued before the grant. */
  waitedMs: number;
  release(): void;
}

interface Waiter {
  resolve: (slot: Slot | null) => void;
  deadlineMs: number;
  enqueuedAt: number;
  heartbeat?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
}

const GRANT_GAP_MS = 25;

function heartbeatMs(): number {
  const raw = parseInt(process.env.ESTATE_SSE_HEARTBEAT_MS || "10000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

export class ProviderDispatcher {
  private queue: Waiter[] = [];
  private pumping = false;
  private lastGrant = 0;

  constructor(readonly provider: string) {}

  /**
   * Join the queue. Resolves to a {@link Slot}, or null when no slot can
   * open before `deadlineMs` (fail fast — the caller should fail over).
   * `onWait` fires periodically while queued (SSE `: heartbeat`).
   */
  acquire(deadlineMs: number, onWait?: () => void): Promise<Slot | null> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (slot) => {
          if (waiter.heartbeat) clearInterval(waiter.heartbeat);
          if (waiter.timeout) clearTimeout(waiter.timeout);
          resolve(slot);
        },
        deadlineMs,
        enqueuedAt: Date.now(),
      };
      if (onWait) {
        waiter.heartbeat = setInterval(() => {
          try {
            onWait();
          } catch {
            /* heartbeat must never break the queue */
          }
        }, heartbeatMs());
      }
      // Hard deadline: fail fast even if the pump is stalled behind a
      // long grant gap.
      const ms = deadlineMs - Date.now();
      waiter.timeout = setTimeout(
        () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          waiter.resolve(null);
        },
        Math.max(0, ms),
      );
      this.queue.push(waiter);
      void this.pump();
    });
  }

  /** Test/observability hook. */
  get depth(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const w = this.queue[0]!;
        const now = Date.now();
        if (now >= w.deadlineMs) {
          this.queue.shift();
          w.resolve(null);
          continue;
        }
        const gapWait = GRANT_GAP_MS - (now - this.lastGrant);
        if (gapWait > 0) {
          await new Promise((r) => setTimeout(r, Math.min(gapWait, w.deadlineMs - now)));
          if (Date.now() >= w.deadlineMs) {
            this.queue.shift();
            w.resolve(null);
            continue;
          }
        }
        // The waiter may have timed out (and been spliced out) while we
        // slept on the grant gap.
        if (this.queue[0] !== w) continue;
        this.queue.shift();
        this.lastGrant = Date.now();
        let released = false;
        w.resolve({
          provider: this.provider,
          waitedMs: this.lastGrant - w.enqueuedAt,
          release: () => {
            released = true;
          },
        });
        void released;
      }
    } finally {
      this.pumping = false;
    }
  }
}

const dispatchers = new Map<string, ProviderDispatcher>();

/** One FIFO dispatcher per provider name (lazily created). */
export function dispatcherFor(provider: string): ProviderDispatcher {
  let d = dispatchers.get(provider);
  if (!d) {
    d = new ProviderDispatcher(provider);
    dispatchers.set(provider, d);
  }
  return d;
}

/** Test hook: drop all dispatchers. */
export function resetDispatchers(): void {
  dispatchers.clear();
}
