import type { StrategyDeps } from "../strategy/types.ts";

export interface RouterGovernorOptions {
  /** Max concurrent requests allowed to herd backend */
  herdConcurrency: number;
  /** Max concurrent requests allowed to flock backend */
  flockConcurrency: number;
  /** Max requests per key per window for herd backend */
  herdKeyQuota: number;
  /** Max requests per key per window for flock backend */
  flockKeyQuota: number;
  /** Quota window in seconds */
  quotaWindowMs: number;
}

/**
 * Router Governor - manages concurrency caps and per-key quotas for herd and flock backends.
 *
 * Separate tracking for:
 * - Backend-level concurrency caps (herd vs flock)
 * - Per-key quotas for each backend
 */
export class RouterGovernor {
  private herdInflight = 0;
  private flockInflight = 0;
  private keyUsage = new Map<string, { count: number; resetTime: number }>();
  
  constructor(private options: RouterGovernorOptions) {}
  
  /**
   * Try to acquire admission for a request.
   * @param key - Identifier for quota tracking (typically API key or user ID)
   * @param isHerd - True for herd backend, false for flock backend
   * @returns Permit object with release() method, or null if admission refused
   */
  admit(key: string, isHerd: boolean): { release(): void } | null {
    const now = Date.now();
    
    // Check backend concurrency cap
    if (isHerd) {
      if (this.herdInflight >= this.options.herdConcurrency) {
        return null;
      }
      this.herdInflight += 1;
    } else {
      if (this.flockInflight >= this.options.flockConcurrency) {
        return null;
      }
      this.flockInflight += 1;
    }
    
    // Check per-key quota
    const usage = this.keyUsage.get(key) ?? { count: 0, resetTime: now + this.options.quotaWindowMs };
    
    // Reset quota if window has expired
    if (now >= usage.resetTime) {
      usage.count = 0;
      usage.resetTime = now + this.options.quotaWindowMs;
    }
    
    const quota = isHerd ? this.options.herdKeyQuota : this.options.flockKeyQuota;
    if (usage.count >= quota) {
      // Consumed quota, rollback concurrency increment
      if (isHerd) {
        this.herdInflight -= 1;
      } else {
        this.flockInflight -= 1;
      }
      return null;
    }
    
    // Increment usage and return permit
    usage.count += 1;
    this.keyUsage.set(key, usage);
    
    return {
      release: () => this.release(key, isHerd),
    };
  }
  
  /** Release admission backend concurrency tracking */
  private release(key: string, isHerd: boolean): void {
    if (isHerd) {
      this.herdInflight = Math.max(0, this.herdInflight - 1);
    } else {
      this.flockInflight = Math.max(0, this.flockInflight - 1);
    }
    
    // Note: We don't decrement key usage as it's quota-based (fixed window)
    // The quota will reset automatically after the window expires
  }
  
  /** Get current stats for monitoring/debugging */
  getStats() {
    return {
      herdInflight: this.herdInflight,
      flockInflight: this.flockInflight,
      herdConcurrencyLimit: this.options.herdConcurrency,
      flockConcurrencyLimit: this.options.flockConcurrency,
      activeKeys: this.keyUsage.size,
    };
  }
}

// Default options - conservative limits suitable for testing
export const defaultRouterGovernorOptions: RouterGovernorOptions = {
  herdConcurrency: 10,
  flockConcurrency: 20,
  herdKeyQuota: 100,
  flockKeyQuota: 1000,
  quotaWindowMs: 60_000, // 1 minute
};