// Model Disabler and Belief Field: Two-Level Hierarchical Bayesian State
// Level 1: Credential Bucket (Refill Rate Gamma Posterior over shared key limits)
// Level 2: Arm Posterior (Quality Beta, Latency Gamma, Throughput EWMA)

export interface CredentialBucketNode {
  shape_r: number; // Gamma shape for refill rate r (units/sec)
  rate_r: number;  // Gamma rate for refill rate r
  capacity: number;
  current_fill: number;
  last_fill: number;
  t: number;
}

export interface BeliefNode {
  successes: number;
  failures: number;
  e_lat: number;
  e_tps: number;
  shape_rec: number; // Arm-specific recovery Gamma shape
  rate_rec: number;  // Arm-specific recovery Gamma rate
  t: number;
  n: number;
}

/** Standard Marsaglia and Tsang method for Gamma random variates */
export function sampleGamma(alpha: number, rate = 1.0): number {
  const safeAlpha = Math.max(0.01, alpha);
  let sample = 0;
  if (safeAlpha < 1) {
    const u = Math.random();
    sample = sampleGamma(1 + safeAlpha, 1.0) * Math.pow(u, 1 / safeAlpha);
  } else {
    const d = safeAlpha - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u1 || 1e-10)) * Math.cos(2.0 * Math.PI * u2);
      const v = 1 + c * z;
      if (v <= 0) continue;
      const v3 = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * z * z * z * z) {
        sample = d * v3;
        break;
      }
      if (Math.log(u || 1e-10) < 0.5 * z * z + d * (1 - v + Math.log(v))) {
        sample = d * v3;
        break;
      }
    }
  }
  return sample / Math.max(1e-5, rate);
}

/** Beta distribution random variate via ratio of Gamma variates */
export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(Math.max(0.01, alpha), 1.0);
  const y = sampleGamma(Math.max(0.01, beta), 1.0);
  const sum = x + y;
  return sum === 0 ? 0.5 : x / sum;
}

export class Belief {
  field = new Map<string, BeliefNode>();
  credentialBuckets = new Map<string, CredentialBucketNode>();

  observe(key: string, ok: boolean, lat: number, tps: number = 0): void {
    const prev = this.field.get(key);
    const alpha_lat = 0.3;
    const s = (prev ? prev.successes : 0) + (ok ? 1 : 0);
    const f = (prev ? prev.failures : 0) + (ok ? 0 : 1);
    const l = prev ? alpha_lat * lat + (1 - alpha_lat) * prev.e_lat : lat;
    const tp = prev && prev.e_tps > 0 ? (tps > 0 ? 0.1 * tps + 0.9 * prev.e_tps : prev.e_tps) : (tps > 0 ? tps : 0);
    const n = prev ? prev.n + 1 : 1;
    const shape_rec = prev?.shape_rec ?? 1;
    const rate_rec = prev?.rate_rec ?? 1;

    this.field.set(key, { successes: s, failures: f, e_lat: l, e_tps: tp, shape_rec, rate_rec, t: Date.now(), n });
    const p_est = (s + 1) / (s + f + 2);
    console.log(`[belief] obs ${key} ok=${ok} lat=${lat.toFixed(0)} tps=${tp.toFixed(1)} p_ok=${p_est.toFixed(3)} n=${n}`);
  }

  /** Level 1: Credential Bucket Refill Rate Gamma Update */
  observeBucket(provider: string, keyHash: string, headers: Record<string, string | null | undefined>, success: boolean): void {
    const bucketKey = `${provider}:${keyHash}`;
    const now = Date.now();
    const prev = this.credentialBuckets.get(bucketKey) ?? {
      shape_r: 10,
      rate_r: 15, // Default ~0.67 units/sec (40 RPM)
      capacity: 40,
      current_fill: 40,
      last_fill: now,
      t: now,
    };

    let shape = prev.shape_r;
    let rate = prev.rate_r;
    let fill = prev.current_fill;

    const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
    const resetTime = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
    const remaining = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];

    if (retryAfter) {
      const sec = parseFloat(retryAfter);
      if (sec > 0) {
        // r >= 1 / sec
        shape += 1.0;
        rate += sec;
        fill = 0;
      }
    } else if (resetTime) {
      const resetUnix = parseFloat(resetTime);
      const deltaSec = resetUnix > 1e9 ? resetUnix - now / 1000 : resetUnix;
      if (deltaSec > 0) {
        // r ≈ capacity / deltaSec
        shape += 1.0;
        rate += deltaSec / Math.max(1, prev.capacity);
      }
    } else if (!success) {
      // 429 without header: bucket empty, lower bound on refill
      shape += 0.5;
      rate += 60.0;
      fill = 0;
    } else {
      // Success: empirical refill observed
      shape += 0.5;
      rate = Math.max(0.1, rate * 0.95);
      fill = Math.min(prev.capacity, fill + 1);
    }

    if (remaining) {
      const rem = parseInt(remaining, 10);
      if (!isNaN(rem)) fill = rem;
    }

    this.credentialBuckets.set(bucketKey, {
      shape_r: shape,
      rate_r: rate,
      capacity: prev.capacity,
      current_fill: fill,
      last_fill: now,
      t: now,
    });
    console.log(`[bucket] obs ${bucketKey} shape_r=${shape.toFixed(1)} rate_r=${rate.toFixed(1)} fill=${fill}`);
  }

  /** Expected wait time in milliseconds for 1 unit from a shared credential bucket */
  expectedWaitMs(provider: string, keyHash = "default"): number {
    const bucketKey = `${provider}:${keyHash}`;
    const b = this.credentialBuckets.get(bucketKey);
    if (!b) return 0;
    const now = Date.now();
    const elapsedSec = (now - b.last_fill) / 1000;
    const rSample = sampleGamma(b.shape_r, b.rate_r); // Sampled refill rate in units/sec
    const replenished = elapsedSec * rSample;
    const current = Math.min(b.capacity, b.current_fill + replenished);
    if (current >= 1.0) return 0;
    // Time needed to refill up to 1 unit
    const needed = 1.0 - current;
    return Math.max(0, (needed / Math.max(0.01, rSample)) * 1000);
  }
  /** Level 2: Arm Recovery Gamma Update */
  observeRecovery(key: string, seconds: number, censored: boolean, family = "rpm"): void {
    const prev = this.field.get(key);
    const shape = (prev?.shape_rec ?? 1) + (censored ? 0.5 : 1.0);
    const rate = (prev?.rate_rec ?? 1) + (censored ? Math.max(1, seconds) / 2 : Math.max(1, seconds));
    const now = Date.now();
    this.field.set(key, {
      successes: prev?.successes ?? 0,
      failures: (prev?.failures ?? 0) + 1,
      e_lat: prev?.e_lat ?? 500,
      e_tps: prev?.e_tps ?? 30,
      shape_rec: shape,
      rate_rec: rate,
      t: now,
      n: (prev?.n ?? 0) + 1,
    });
    console.log(`[rate_limit] family=${family} key=${key} horizon=${seconds}s shape=${shape.toFixed(1)} rate=${rate.toFixed(1)}`);
  }

  costOf(key: string): number {
    const b = this.field.get(key);
    if (!b) {
      const p = sampleBeta(1, 1);
      return p / 500;
    }
    const age = (Date.now() - b.t) / 1000;
    const decay = Math.exp(-age / 300); // 5-minute half-life decay on evidence
    const effS = b.successes * decay;
    const effF = b.failures * decay;
    const p = sampleBeta(effS + 1, effF + 1);
    const lat = b.e_lat * decay + 500 * (1 - decay);
    const tps = b.e_tps > 0 ? b.e_tps * decay + 30 * (1 - decay) : 30;

    // Rate-limit recovery penalty: sample recovery horizon Gamma
    const recSeconds = sampleGamma(b.shape_rec * decay + 1, b.rate_rec * decay + 1);
    const armPenalty = recSeconds > age ? (recSeconds - age) * 1000 : 0;

    // Level 1 Shared Credential Bucket Wait Penalty
    const provider = key.split("/")[0];
    const bucketPenalty = this.expectedWaitMs(provider);

    const effectiveWait = Math.max(armPenalty, bucketPenalty);
    return (p * (1 + tps / 100)) / Math.max(1, lat + effectiveWait);
  }

  entries() { return this.field.entries(); }
  snapshot(): Record<string, BeliefNode> { return Object.fromEntries(this.field); }
  restore(s: Record<string, BeliefNode>): void {
    for (const [k, v] of Object.entries(s)) this.field.set(k, v);
  }
  size(): number { return this.field.size; }
}

export const globalBelief = new Belief();
export const BELIEF = globalBelief;

export class ModelDisabler {
  record(_key: string, _ok: boolean, _err = "") { return "active"; }
  isDisabled(_key: string) { return false; }
  isAnomalous(_key: string) { return false; }
  dueForRecheck() { return []; }
  stats() { return { active: BELIEF.size(), disabled: 0, anomalous: 0, total: BELIEF.size() }; }
  snapshot() { return {}; }
}
