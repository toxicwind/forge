/**
 * flock/ts/strategy/nvidia-keys — NVIDIA multi-key rotation (token bucket).
 *
 * Ported from estate-scripts-router's router_matrix.ts Matrix.nextNvidiaKey
 * (absorbed from the retired :8000 proxy). Round-robin across the nvapi
 * key pool, each key behind its own token bucket (40 rpm). Returns null
 * when every bucket is dry — the caller serves an honest 429 rather than
 * burning a rate-limited key.
 */
import { nvidiaKeys } from "./catalog.ts";

export const NVIDIA_RPM = 40;

interface Bucket {
  tokens: number;
  last: number;
}

export class NvidiaKeyPool {
  private idx = 0;
  private buckets = new Map<string, Bucket>();

  /**
   * Next usable key, or null when every bucket is dry.
   * keysOverride is for tests; production reads NVIDIA_API_KEYS from env.
   */
  next(keysOverride?: string[]): string | null {
    const keys = keysOverride ?? nvidiaKeys();
    if (!keys.length) return null;
    const now = Date.now() / 1000;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[(this.idx + i) % keys.length]!;
      let b = this.buckets.get(k);
      if (!b) {
        b = { tokens: NVIDIA_RPM, last: now };
        this.buckets.set(k, b);
      }
      const elapsed = now - b.last;
      if (elapsed > 0) {
        b.tokens = Math.min(
          NVIDIA_RPM,
          b.tokens + (elapsed * NVIDIA_RPM) / 60,
        );
        b.last = now;
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        this.idx = (this.idx + i + 1) % keys.length;
        return k;
      }
    }
    return null;
  }

  /** For tests: how many keys currently have a full bucket. */
  debugBuckets(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, b] of this.buckets) out[k.slice(0, 8) + "…"] = b.tokens;
    return out;
  }
}
