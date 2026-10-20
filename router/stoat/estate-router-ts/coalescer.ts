/**
 * Request coalescer — port of flock-proxy's coalescer.rs (AstMatrix's
 * RequestCoalescer, actually wired in).
 *
 * Identical in-flight buffered POSTs share one upstream call: the first
 * request becomes the leader and performs the upstream call; concurrent
 * duplicates become followers and receive the leader's response. Streaming
 * requests must never be coalesced — callers enforce that.
 *
 * Key semantic from Rust: never publish an empty body to followers — a
 * leader whose upstream answer lacks substance drops the lead instead of
 * completing, releasing followers to proceed alone.
 */
import { createHash } from "node:crypto";

/** A response shared between the leader and all coalesced followers. */
export interface SharedResponse {
  status: number;
  contentType: string;
  body: Uint8Array;
  /** Upstream headers relayed to every coalesced client, e.g. keypool's
   *  `x-interaction-id` (the Gemini Interactions turn handle). */
  extra: Array<[string, string]>;
}

type Waiter = (resp: SharedResponse | null) => void;

interface Entry {
  waiters: Set<Waiter>;
  createdAt: number;
}

/** The leader's handle. `complete` publishes to followers; `drop` releases
 *  them to proceed alone (also runs on GC/abandon via explicit call). */
export class Lead {
  private settled = false;
  constructor(
    private readonly coalescer: Coalescer,
    private readonly key: string,
  ) {}

  /** Publish the upstream result to all followers. */
  complete(resp: SharedResponse): void {
    if (this.settled) return;
    this.settled = true;
    this.coalescer.publish(this.key, resp);
  }

  /** Release followers to proceed alone (empty/substance-less answer, or
   *  the leader errored before producing a shareable response). */
  drop(): void {
    if (this.settled) return;
    this.settled = true;
    this.coalescer.publish(this.key, null);
  }
}

export type Registration = { lead: Lead } | { follower: Promise<SharedResponse | null> };

export function isLead(r: Registration): r is { lead: Lead } {
  return (r as { lead: Lead }).lead !== undefined;
}

export class Coalescer {
  private entries = new Map<string, Entry>();

  /**
   * `ttlMs` bounds how long a follower waits and how long a dead leader's
   * entry can linger. AstMatrix's configured TTL was 5 seconds.
   */
  constructor(private readonly ttlMs: number = 5000) {}

  /** Register `key`. Leaders get a {@link Lead}; followers get a promise. */
  register(key: string): Registration {
    // Opportunistically reap expired entries first (bounded map).
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (now - e.createdAt > this.ttlMs * 2) this.entries.delete(k);
    }
    const existing = this.entries.get(key);
    if (existing && now - existing.createdAt < this.ttlMs) {
      const entry = existing;
      const follower = new Promise<SharedResponse | null>((resolve) => {
        const waiter: Waiter = (resp) => {
          entry.waiters.delete(waiter);
          clearTimeout(timer);
          resolve(resp);
        };
        // Follower wait is TTL-bounded: a leader that never completes
        // releases the follower to proceed alone.
        const timer = setTimeout(() => {
          entry.waiters.delete(waiter);
          resolve(null);
        }, this.ttlMs);
        entry.waiters.add(waiter);
      });
      return { follower };
    }
    const entry: Entry = { waiters: new Set(), createdAt: now };
    this.entries.set(key, entry);
    return { lead: new Lead(this, key) };
  }

  /** @internal — called by Lead. */
  publish(key: string, resp: SharedResponse | null): void {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry) return;
    for (const w of entry.waiters) {
      try {
        w(resp);
      } catch {
        /* a follower's continuation must not break the leader */
      }
    }
    entry.waiters.clear();
  }

  /** Test/observability hook. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Canonical key for a buffered request: method + path + body hash.
 * Streaming requests must never be coalesced — callers enforce that.
 */
export function coalesceKey(method: string, path: string, body: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(method);
  h.update("\n");
  h.update(path);
  h.update("\n");
  h.update(typeof body === "string" ? body : Buffer.from(body));
  return h.digest("hex");
}

/** Build a Response from a shared (coalesced) upstream answer. */
export function sharedToResponse(shared: SharedResponse): Response {
  const headers: Record<string, string> = {
    "Content-Type": shared.contentType || "application/json",
    "X-Coalesced": "follower",
  };
  for (const [k, v] of shared.extra) headers[k] = v;
  return new Response(shared.body as BodyInit, { status: shared.status, headers });
}
