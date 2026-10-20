/**
 * Request gates — ports of three flock-proxy handle() behaviors:
 *
 * G4. `x-flock-deadline-ms`: client-supplied absolute request deadline.
 *     Malformed values are a 400; the deadline is enforced on every attempt
 *     via the request's AbortSignal. (proxy.rs::parse_request_deadline)
 * G5. Global in-flight cap: past `max_inflight` the request is shed with
 *     429 "overloaded". A scope-guarded decrement runs on every exit path;
 *     live streams keep their slot until the stream actually ends.
 *     (proxy.rs::handle inflight guard)
 * G18. Client-key hardening: keys are compared as SHA-256 digests with a
 *     constant-time compare, plus a 250ms sleep on failure. The store never
 *     holds a usable token. (proxy.rs::handle client auth + auth.rs ct_eq)
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const DEADLINE_HEADER = "x-flock-deadline-ms";

// ---------------------------------------------------------------------------
// G4 — request deadline
// ---------------------------------------------------------------------------

export type DeadlineParse = { ok: true; atMs: number } | { ok: false };

/**
 * Parse `x-flock-deadline-ms`: a non-empty all-digit millisecond count,
 * interpreted as an absolute deadline `acceptedMs + ms`. Malformed (empty,
 * non-digit, overflow) → `{ ok: false }` → the caller answers 400.
 * Absent header → null (no client deadline).
 */
export function parseFlockDeadline(
  raw: string | null,
  acceptedMs: number,
): DeadlineParse | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  if (!v || !/^[0-9]+$/.test(v)) return { ok: false };
  const ms = Number(v);
  if (!Number.isSafeInteger(ms)) return { ok: false };
  const at = acceptedMs + ms;
  if (!Number.isSafeInteger(at)) return { ok: false };
  return { ok: true, atMs: at };
}

// ---------------------------------------------------------------------------
// G5 — global in-flight cap + load shedding
// ---------------------------------------------------------------------------

export function maxInflight(): number {
  const raw = parseInt(process.env.ESTATE_MAX_INFLIGHT || "512", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 512;
}

/**
 * Scope-guarded in-flight counter. `enter()` returns a release function, or
 * null when the cap is already reached (caller sheds with 429). The release
 * is idempotent so stream paths can hook it to stream close AND a finally.
 */
export class InflightGate {
  private n = 0;
  constructor(private readonly cap: number = maxInflight()) {}

  get count(): number {
    return this.n;
  }

  get limit(): number {
    return this.cap;
  }

  enter(): (() => void) | null {
    if (this.n >= this.cap) return null;
    this.n++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.n = Math.max(0, this.n - 1);
    };
  }
}

// ---------------------------------------------------------------------------
// G18 — client-key digest auth
// ---------------------------------------------------------------------------

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time hex-digest equality (length mismatch leaks length only,
 *  acceptable per Rust's ct_eq docs). */
export function ctEqHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pre-hash configured client keys at load: the runtime never holds a
 *  usable token for comparison. */
export function digestClientKeys(keys: string[]): string[] {
  return keys.map(sha256Hex);
}

/** Extract the presented client key (Bearer preferred, x-api-key fallback). */
export function presentedClientKey(req: Request): string {
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  return bearer || req.headers.get("x-api-key") || "";
}

/**
 * Keyed-mode check: hash the presented bearer and compare against stored
 * digests in constant time. Open mode (no digests) admits everyone.
 */
export function clientKeyAuthorized(digests: string[], presented: string): boolean {
  if (!digests.length) return true;
  if (!presented) return false;
  const d = sha256Hex(presented);
  let ok = false;
  for (const sd of digests) {
    if (ctEqHex(d, sd)) ok = true;
  }
  return ok;
}

export const AUTH_FAILURE_DELAY_MS = 250;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
