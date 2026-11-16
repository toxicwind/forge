/**
 * 7-Family Rate Limit Classifier & Multi-Hypothesis Dual-Control Engine
 * Deconstructs 429 signals across:
 * - RPM (requests per minute)
 * - TPM (tokens per minute)
 * - FIVE_HOUR (5-hour unified budget)
 * - SEVEN_DAY (7-day unified budget)
 * - MODEL_SCOPED (tier/model cap)
 * - CONCURRENCY (in-flight worker cap)
 * - SPEND_CAP (org/account quota exhausted)
 */

export type RateLimitFamily =
  | "rpm"
  | "tpm"
  | "five_hour"
  | "seven_day"
  | "model_scoped"
  | "concurrency"
  | "spend_cap";

export interface RateLimitSignal {
  family: RateLimitFamily;
  scope: "model" | "credential" | "account";
  horizonSec: number;
  confidence: number;
}

export function classifyRateLimit(
  bodyText: string,
  headers: Record<string, string | null | undefined>,
  estTokens = 0
): RateLimitSignal {
  const b = (bodyText || "").toLowerCase();
  const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  const resetHeader = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];

  let explicitWait = 0;
  if (retryAfter) {
    explicitWait = parseFloat(retryAfter) || 0;
  }

  // 1. Spend Cap / Quota Exhaustion (Monthly / Billing) -> Days/Weeks
  if (/quota|credit|billing|exceeded your daily|exceeded your monthly|insufficient balance/i.test(b)) {
    return { family: "spend_cap", scope: "account", horizonSec: explicitWait || 86400, confidence: 0.95 };
  }

  // 2. 7-Day / 5-Hour Unified Tier Budgets
  if (/7-day|weekly budget|rolling 7 day/i.test(b)) {
    return { family: "seven_day", scope: "credential", horizonSec: explicitWait || 604800, confidence: 0.9 };
  }
  if (/5-hour|hourly budget|rolling 5 hour/i.test(b)) {
    return { family: "five_hour", scope: "credential", horizonSec: explicitWait || 18000, confidence: 0.85 };
  }

  // 3. Concurrency / In-Flight Saturation -> Seconds
  if (/concurrent|simultaneous|too many in-flight|active requests/i.test(b)) {
    return { family: "concurrency", scope: "credential", horizonSec: explicitWait || 5, confidence: 0.8 };
  }

  // 4. Model-Scoped Throttles (e.g. Zhipu, Fable/Mythos, Llama separate tier)
  if (/model capacity|model-scoped|capacity for this model|not available for this model tier/i.test(b)) {
    return { family: "model_scoped", scope: "model", horizonSec: explicitWait || 120, confidence: 0.85 };
  }

  // 5. TPM vs RPM Disambiguation via Request Shape Conditioning
  if (/tokens per minute|tpm/i.test(b) || estTokens > 8000) {
    return { family: "tpm", scope: "model", horizonSec: explicitWait || 30, confidence: 0.8 };
  }

  // 6. Default to Transient RPM
  return { family: "rpm", scope: "credential", horizonSec: explicitWait || 60, confidence: 0.7 };
}
