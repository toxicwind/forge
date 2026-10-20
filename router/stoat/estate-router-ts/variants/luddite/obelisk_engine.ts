import { createBayesRoute } from "@takk/bayesroute";
import { createFileStore } from "@takk/bayesroute/node";
import { PROVIDERS, catalogModelsFor, classifyTask } from "./router_config.ts";
import { LIVE_STATUS } from "./router_live_models.ts";

const BAYES_STORE_PATH = `${process.env.HOME || "/tmp"}/.estate-scripts-router/bayesroute.json`;

/** Pillar VI: NemoClaw true null-content evaluation */
export function substanceScore(msg: unknown): number {
  if (!msg || typeof msg !== "object") return 0;
  const m = msg as Record<string, unknown>;
  const c = m.content;
  const r = m.reasoning_content;
  const t = m.tool_calls;
  if (typeof c === "string" && c.trim().length > 0) return 1.0;
  if (typeof r === "string" && r.trim().length > 0) return 0.8;
  if (Array.isArray(t) && t.length > 0) return 0.9;
  return 0.0;
}

/** Pillar V: CANON Engine multi-dimension contract validator */
export interface ContractValidation {
  schema: boolean;
  identity: boolean;
  semantic: boolean;
  format: boolean;
}

export function validateContract(response: unknown, expectedProvider: string): ContractValidation {
  const schema = response !== null && typeof response === "object";
  const identity = !expectedProvider || typeof expectedProvider === "string";
  const semantic = substanceScore(response) > 0;
  const format = true;
  return { schema, identity, semantic, format };
}

/** Pillar III: Hierarchical Latent Task Tree Path */
export function getTaskPath(text: string): string {
  const base = classifyTask(text);
  if (base === "code") {
    if (/async|await|Promise/i.test(text)) return "code/async";
    if (/test|expect|assert/i.test(text)) return "code/test";
    return "code/general";
  }
  if (base === "reasoning") {
    if (/math|calculate|derive|prove/i.test(text)) return "reasoning/math";
    return "reasoning/general";
  }
  return "chat/general";
}

/** Collect all currently discoverable candidate models */
export function allCandidateModels(): string[] {
  const models = new Set<string>();
  for (const p of Object.keys(PROVIDERS)) {
    const live = LIVE_STATUS[p]?.models ?? [];
    const list = live.length ? live : catalogModelsFor(p);
    for (const m of list) {
      models.add(`${p}/${m}`);
    }
  }
  // Base default arms ensuring non-empty configuration
  models.add("herd/beellama/exaone-4-0-1-2b-iq4xs");
  models.add("nvidia/nemotron-3-super-120b-a12b");
  models.add("openrouter/inclusionai/ling-3.0-flash-fin:free");
  return Array.from(models);
}

/** Pillar I & II: The Obelisk Thompson Bayes Engine with Ruflo prior decay */
export const obeliskEngine = createBayesRoute({
  models: allCandidateModels(),
  weights: { quality: 1.0, latency: 0.3, cost: 0.1 },
  decay: { halfLifeMs: 300_000 }, // 5-minute half-life relaxation
  store: createFileStore(BAYES_STORE_PATH),
});

/** Return ranked candidate arms for a given task path */
export function getRankedArms(taskDomain: string, explicitModel: string | null = null): [string, string][] {
  if (explicitModel && explicitModel !== "auto" && !explicitModel.startsWith("direct:")) {
    const sep = explicitModel.includes(":") ? ":" : "/";
    const idx = explicitModel.indexOf(sep);
    const p = explicitModel.slice(0, idx);
    const m = explicitModel.slice(idx + 1);
    return [[p, m]];
  }

  const summaries = obeliskEngine.rank(taskDomain);
  const out: [string, string][] = [];
  const seen = new Set<string>();

  for (const item of summaries) {
    const parts = item.model.split("/");
    const p = parts[0];
    const m = parts.slice(1).join("/");
    if (seen.has(p)) continue;
    seen.add(p);
    out.push([p, m]);
    if (out.length >= 6) break;
  }

  if (!out.length) {
    for (const p of ["herd", "openrouter", "nvidia"]) {
      const live = LIVE_STATUS[p]?.models?.[0] || catalogModelsFor(p)?.[0] || "<default>";
      out.push([p, live]);
    }
  }
  return out;
}

/**
 * Pillar VII: Speculative Hedged Dispatch with Loser Observation
 */
export function observeAttemptOutcome(
  arm: string,
  domain: string,
  ok: boolean,
  latencyMs: number,
  costTokens: number,
  isPartialLoser = false,
): void {
  try {
    const qualityWeight = isPartialLoser ? (ok ? 0.6 : 0.0) : (ok ? 1.0 : 0.0);
    obeliskEngine.observe(arm, domain, {
      quality: qualityWeight > 0.5,
      latencyMs: Math.max(1, latencyMs),
      cost: costTokens,
    });
  } catch {
    // Non-fatal posterior observation error
  }
}
