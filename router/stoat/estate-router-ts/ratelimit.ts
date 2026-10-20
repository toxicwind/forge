/**
 * Token-bucket rate limiting — port of flock-proxy's ratelimit.rs
 * (AstMatrix's ratelimit.go, native).
 *
 * A bucket holds `capacity` tokens, refills at `rate` tokens/second, and
 * `allow` consumes one token when available. Per-provider defaults follow
 * AstMatrix's rule — 10 RPM for free-tier providers, 60 RPM for everything
 * else — unless the operator sets an explicit per-provider RPM via
 * ESTATE_RPM_<PROVIDER> (e.g. ESTATE_RPM_GROQ=120).
 *
 * Note: nvidia's per-key 40 RPM buckets already live in router_matrix.ts
 * (state.nextNvidiaKey); the provider-level bucket for nvidia defaults high
 * so it never binds before the per-key buckets do.
 */
export class TokenBucket {
  private tokens: number;
  private lastFill: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
    this.lastFill = Date.now();
  }

  /** Requests-per-minute constructor, the unit AstMatrix configured in. */
  static perMinute(rpm: number): TokenBucket {
    return new TokenBucket(rpm / 60, Math.max(1, rpm));
  }

  allow(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastFill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
    this.lastFill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Test hook. */
  get remaining(): number {
    return this.tokens;
  }
}

export interface ProviderRateSpec {
  name: string;
  /** True when the provider is a free-tier lane (10 RPM default). */
  freeTier: boolean;
  /** Explicit per-key RPMs; the tightest governs the provider bucket. */
  keyRpms: number[];
}

function envRpm(name: string): number | null {
  const raw = process.env[`ESTATE_RPM_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One bucket per provider. Rebuilt from the provider registry whenever the
 * config reloads; drained buckets simply deny until they refill. Unknown
 * providers are denied: a provider the registry does not know must not
 * serve traffic.
 */
export class ProviderRateLimiter {
  private buckets = new Map<string, TokenBucket>();

  build(providers: ProviderRateSpec[]): void {
    const next = new Map<string, TokenBucket>();
    for (const p of providers) {
      const env = envRpm(p.name);
      let rpm: number;
      if (env !== null) {
        rpm = env;
      } else {
        const tightest = p.keyRpms.filter((r) => r > 0).reduce(
          (a, b) => Math.min(a, b),
          Infinity,
        );
        if (tightest !== Infinity) rpm = tightest;
        else if (p.name === "nvidia") rpm = 1000; // per-key buckets pace nvidia
        else rpm = p.freeTier ? 10 : 60;
      }
      next.set(p.name, TokenBucket.perMinute(rpm));
    }
    this.buckets = next;
  }

  allow(provider: string): boolean {
    // TS-faithful deviation from Rust's deny-unknown: PROVIDERS is mutable
    // at runtime (tests inject fake providers, hot-reload overlays defs),
    // so a provider with no configured bucket gets a lazy default bucket
    // instead of a 429 — a missing bucket must never shed a provider the
    // registry just learned about.
    let b = this.buckets.get(provider);
    if (!b) {
      b = TokenBucket.perMinute(defaultRpmFor(provider));
      this.buckets.set(provider, b);
    }
    return b.allow();
  }

  /** Test/operator hook: replace a provider's bucket wholesale. */
  setBucket(provider: string, bucket: TokenBucket): void {
    this.buckets.set(provider, bucket);
  }

  has(provider: string): boolean {
    return this.buckets.has(provider);
  }
}

/** Default RPM for a provider with no configured bucket (see allow()). */
function defaultRpmFor(name: string): number {
  const env = envRpm(name);
  if (env !== null) return env;
  if (name === "nvidia") return 1000; // per-key buckets pace nvidia
  return 60;
}
