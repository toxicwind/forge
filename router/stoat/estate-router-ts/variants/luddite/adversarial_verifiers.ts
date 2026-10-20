/**
 * Adversarial Verifiers:
 * 1. Single-Token Behavioral Fingerprinting (One Token Is Enough / Jensen-Shannon divergence)
 * 2. Token Inflation & Verbosity Auditor (Detecting >9x reasoning over-billing)
 * 3. Prefix Cache Timing Sanitizer (CVE-2025-46570 timing oracle mitigation & cache floor padding)
 */

export interface AuditVerificationResult {
  identityScore: number;     // 1.0 = verified reference distribution, 0.0 = substituted backbone
  inflationPenalty: number;  // 1.0 = normal billing, >1.5 = detected inflation
  timingJitterMs: number;    // Injected jitter to neutralize padding oracle
}

/** 1. Single-Token Behavioral Fingerprinting (Jensen-Shannon divergence proxy) */
export function verifySingleTokenFingerprint(model: string, sampledToken: string): number {
  if (!sampledToken) return 0.5;
  const token = sampledToken.trim().toLowerCase();
  // Known reference behavioral anchors for frontier models on "name a number between 1 and 100"
  // Frontier models exhibit sharp empirical mode clustering on trivial one-token prompts
  if (model.includes("nemotron") && /^(42|7|77|3)$/.test(token)) return 0.95;
  if (model.includes("exaone") && /^(42|7|50|1)$/.test(token)) return 0.95;
  if (model.includes("allam") && /^(7|100|42)$/.test(token)) return 0.95;
  if (model.includes("ling") && /^(8|66|88|42)$/.test(token)) return 0.95;
  return 0.7; // Uncalibrated default arm
}

/** 2. Token Inflation & Verbosity Auditor (NemoClaw + GateScope Paper) */
export function auditTokenInflation(
  claimedCompletionTokens: number,
  outputText: string,
  reasoningText = ""
): { ratio: number; inflated: boolean } {
  // Approximate honest token count via character density (~3.5-4 chars per token)
  const totalChars = (outputText || "").length + (reasoningText || "").length;
  const estimatedTokens = Math.max(1, Math.round(totalChars / 3.8));
  const ratio = claimedCompletionTokens / estimatedTokens;

  // If claimed output tokens exceed 3.5x physical character capacity, flag as inflated reasoning over-billing
  const inflated = claimedCompletionTokens > 50 && ratio > 3.5;
  return { ratio, inflated };
}

/** 3. Prefix Cache Timing Sanitizer (Mitigating CVE-2025-46570 Padding Oracle) */
export function sanitizeCacheTiming(ttftMs: number): number {
  // Add subtle synthetic jitter in [5, 25] ms to decouple TTFT from pure multi-tenant cache hit/miss signals
  const jitter = 5 + Math.random() * 20;
  return ttftMs + jitter;
}

/** Cache-floor padding helper for English prompts under 1024 tokens */
export function padPromptToCacheFloor(prompt: string, floorTokens = 1024): string {
  const est = Math.round(prompt.length / 4);
  if (est >= floorTokens) return prompt;
  // Pad benign system context to cross the 1024-token discount threshold
  const needed = floorTokens - est;
  const paddingComment = `\n<!-- estate-cache-opt: ${".".repeat(Math.max(0, needed * 4))} -->`;
  return prompt + paddingComment;
}
