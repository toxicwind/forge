/**
 * bench-priors.ts — router-consumable benchmark weights (router-max).
 *
 * The roundup lane produces benchmark data; this module is the router's
 * read side. It is version-tolerant by design: it accepts BOTH shapes
 *   (a) legacy bench-priors.json: { generated_ts, priors: { provider: { elo, ... } } }
 *   (b) schema v2 (roundup, fleet-coordinated 2026-10-02):
 *       { schema_version: 2, generated_ts,
 *         provider_priors: { provider: { elo, quality_mean, latency_p50_ms, healthy_frac, basis } },
 *         model_priors: [ { provider, model, quality_mean, latency_p50_ms, healthy_frac, n, basis } ] }
 * Provider priors feed provider Elo seeding (mirroring router_matrix.ts's
 * loader, which keeps working untouched). Model priors feed per-candidate
 * score bonuses in pickWeighted/freeCandidates — small, tie-break scale,
 * never overriding the circuit breaker or live Elo.
 *
 * Hot-reload: getBenchPriors() caches by file mtime; a new roundup sweep
 * lands without a restart. ESTATE_BENCH_PRIORS=0 disables model bonuses.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

export interface BenchModelPrior {
  provider: string;
  model: string;
  quality_mean?: number;
  latency_p50_ms?: number;
  healthy_frac?: number;
  basis?: string;
}

export interface BenchPriors {
  /** per-provider Elo seed: provider -> elo */
  providerElo: Record<string, number>;
  /** per-model score bonus: "provider/model" -> bonus points */
  modelBonus: Map<string, number>;
  source: string;
  mtime: number;
}

const DEFAULT_PATH = `${import.meta.dir}/bench-priors.json`;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * qualityBonus — translate a bench quality_mean (0-2 scale, same instrument
 * as gen-bench-priors.py) into race-score points: (q - 1) * 10, clamped to
 * [-10, +10]. Unhealthy models (healthy_frac < 0.5) take -5 on top so the
 * router prefers lanes that actually complete.
 */
export function qualityBonus(prior: BenchModelPrior): number {
  let b = 0;
  const q = num(prior.quality_mean);
  if (q !== undefined) b += Math.max(-10, Math.min(10, (q - 1) * 10));
  const hf = num(prior.healthy_frac);
  if (hf !== undefined && hf < 0.5) b -= 5;
  return Math.max(-15, Math.min(15, b));
}

export function loadBenchPriorsFile(path: string): BenchPriors {
  const empty: BenchPriors = {
    providerElo: {},
    modelBonus: new Map(),
    source: "missing",
    mtime: 0,
  };
  try {
    if (!existsSync(path)) return empty;
    const st = statSync(path);
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: BenchPriors = {
      providerElo: {},
      modelBonus: new Map(),
      source: String(doc.generated_ts || doc.schema_version || "unknown"),
      mtime: st.mtimeMs,
    };
    // Shape (b): schema v2 provider_priors
    const pp = doc.provider_priors as Record<string, Record<string, unknown>> | undefined;
    if (pp && typeof pp === "object") {
      for (const [p, pr] of Object.entries(pp)) {
        const elo = num(pr?.elo);
        if (elo !== undefined) out.providerElo[p] = elo;
      }
    }
    // Shape (a): legacy priors map (same Elo semantics)
    const legacy = doc.priors as Record<string, Record<string, unknown>> | undefined;
    if (legacy && typeof legacy === "object") {
      for (const [p, pr] of Object.entries(legacy)) {
        if (!(p in out.providerElo)) {
          const elo = num(pr?.elo);
          if (elo !== undefined) out.providerElo[p] = elo;
        }
      }
    }
    // Shape (b): model_priors list
    const mp = doc.model_priors;
    if (Array.isArray(mp)) {
      for (const row of mp) {
        const r = row as Record<string, unknown>;
        const p = String(r.provider || "");
        const m = String(r.model || "");
        if (!p || !m) continue;
        out.modelBonus.set(`${p}/${m}`, qualityBonus(r as BenchModelPrior));
      }
    }
    return out;
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Cached accessor (mtime-keyed hot reload)
// ---------------------------------------------------------------------------
let cached: BenchPriors | null = null;
let cachedPath = "";

export function getBenchPriors(path = DEFAULT_PATH): BenchPriors {
  if (cached && cachedPath === path) {
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime === cached.mtime) return cached;
    } catch {
      return cached; // file vanished mid-flight: keep serving last good
    }
  }
  cached = loadBenchPriorsFile(path);
  cachedPath = path;
  return cached;
}

/** Per-candidate score bonus from roundup benchmark data. 0 when disabled. */
export function benchModelBonus(provider: string, model: string): number {
  if (process.env.ESTATE_BENCH_PRIORS === "0") return 0;
  return getBenchPriors().modelBonus.get(`${provider}/${model}`) ?? 0;
}

/** Provider Elo seed from bench data (superset of the matrix loader's view). */
export function benchProviderElo(provider: string): number | undefined {
  return getBenchPriors().providerElo[provider];
}
