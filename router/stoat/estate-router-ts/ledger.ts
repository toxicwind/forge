#!/usr/bin/env bun
/**
 * 📒 ledger — the ranch account book.
 *
 * Multi-provider request/token/cost accounting for the whole estate.
 * Every provider key that serves traffic gets its tokens counted and,
 * where a verified per-token price exists, its dollars accounted.
 *
 * Pricing honesty rules (do not weaken):
 *  - Every static price cites its source + fetch date in the PRICING table.
 *  - OpenRouter pricing comes from https://openrouter.ai/api/v1/models,
 *    cached on disk (refresh: `bun ledger.ts pricing refresh`).
 *  - Unknown models are NEVER silently priced as something else: they are
 *    recorded with NULL cost_usd and surfaced as "unpriced" in reports.
 *  - Known-free traffic (local herd, :free tiers, free inference) is
 *    recorded at $0.00 — free is a price, not a gap.
 *
 * Cost semantics per row:
 *  - cost_usd > 0  → priced at a verified per-token rate
 *  - cost_usd = 0  → known-free
 *  - cost_usd NULL → unpriced (tokens counted, dollars unknown)
 *
 * Library usage:
 *   import { recordUsage, getDailyCost } from "./ledger.ts";
 *   recordUsage({ provider: "google", model: "models/gemini-3-flash-preview",
 *                 inputTokens: 1000, outputTokens: 500 });
 *   // returns USD cost, or null when unpriced
 *
 * CLI usage:
 *   bun ledger.ts daily 2026-09-30
 *   bun ledger.ts range 2026-09-28 2026-09-30
 *   bun ledger.ts pricing
 *   bun ledger.ts pricing refresh
 *   bun ledger.ts status
 *   bun ledger.ts record <model> <in-tokens> <out-tokens> [--provider P] [--request ID]
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Verified per-token pricing (USD).
// source = where the rate was published; fetched = YYYY-MM-DD it was read.
// nanos_per_token / 1e9 = USD per token (Google Catalog convention).
// $/1M / 1e6 = USD per token (everyone else).
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerToken: number;   // USD per input token
  outputPerToken: number;  // USD per output token
  source: string;          // pricing source citation
  fetched: string;         // YYYY-MM-DD
}

const GCAT = "Google Cloud Billing Catalog API service AEFD-7695-64FA (nanos are per-token)";
const GAI = "https://ai.google.dev/gemini-api/docs/pricing (Google AI paid tier, standard)";
const MISTRAL_P = "https://mistral.ai/pricing";
const GROQ_P = "https://groq.com/pricing (via verified community rate cards)";
const CEREBRAS_P = "https://www.cerebras.ai/pricing (via CostBench verified rates)";
const DEEPSEEK_P = "https://api-docs.deepseek.com/quick_start/pricing";
const MOONSHOT_P = "https://platform.moonshot.ai/docs/pricing";
const ANTHROPIC_P = "https://www.anthropic.com/pricing (via verified rate cards)";

const PRICING: Record<string, ModelPricing> = {
  // ---- google (Gemini) ----
  // 2.x: 1250/10000 nanos etc. verified vs public $1.25/$10.00 — fetched 2026-09-30
  "google/gemini-2.5-pro":        { inputPerToken: 1250 / 1e9,  outputPerToken: 10000 / 1e9, source: GCAT, fetched: "2026-09-30" },
  "google/gemini-2.5-flash":      { inputPerToken: 0.30 / 1e6,  outputPerToken: 2.50 / 1e6,  source: GCAT, fetched: "2026-09-30" },
  "google/gemini-2.5-flash-lite": { inputPerToken: 0.10 / 1e6,  outputPerToken: 0.40 / 1e6,  source: GCAT, fetched: "2026-09-30" },
  "google/gemini-2.0-flash":      { inputPerToken: 0.10 / 1e6,  outputPerToken: 0.40 / 1e6,  source: GCAT, fetched: "2026-09-30" },
  // 3.x: public Google AI pricing — fetched 2026-09-30
  "google/gemini-3-flash-preview": { inputPerToken: 0.50 / 1e6, outputPerToken: 3.00 / 1e6, source: GAI, fetched: "2026-09-30" },
  // Pro preview: <=200k prompt tier. Above 200k input tokens the rate doubles ($4/$18) — ledger uses the standard tier.
  "google/gemini-3-pro-preview":   { inputPerToken: 2.00 / 1e6, outputPerToken: 12.00 / 1e6, source: GAI, fetched: "2026-09-30" },
  "google/gemini-3.1-pro-preview": { inputPerToken: 2.00 / 1e6, outputPerToken: 12.00 / 1e6, source: GAI, fetched: "2026-09-30" },
  "google/gemini-3.5-flash":       { inputPerToken: 1.50 / 1e6, outputPerToken: 9.00 / 1e6,  source: "stackcone.com LLM pricing survey (secondary)", fetched: "2026-09-30" },

  // ---- mistral (La Plateforme) — fetched 2026-09-30 ----
  "mistral/mistral-large-3":   { inputPerToken: 0.50 / 1e6, outputPerToken: 1.50 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/mistral-medium-3.5": { inputPerToken: 1.50 / 1e6, outputPerToken: 7.50 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/mistral-small-4":   { inputPerToken: 0.15 / 1e6, outputPerToken: 0.60 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/ministral-3b":      { inputPerToken: 0.10 / 1e6, outputPerToken: 0.10 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/ministral-8b":      { inputPerToken: 0.15 / 1e6, outputPerToken: 0.15 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/ministral-14b":     { inputPerToken: 0.20 / 1e6, outputPerToken: 0.20 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/codestral":         { inputPerToken: 0.30 / 1e6, outputPerToken: 0.90 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/magistral-medium":  { inputPerToken: 2.00 / 1e6, outputPerToken: 5.00 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/magistral-small":   { inputPerToken: 0.50 / 1e6, outputPerToken: 1.50 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/devstral-2":        { inputPerToken: 0.40 / 1e6, outputPerToken: 2.00 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/devstral-small-2":  { inputPerToken: 0.10 / 1e6, outputPerToken: 0.30 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },
  "mistral/mistral-nemo":      { inputPerToken: 0.15 / 1e6, outputPerToken: 0.15 / 1e6, source: MISTRAL_P, fetched: "2026-09-30" },

  // ---- groq — fetched 2026-09-30 ----
  "groq/llama-3.1-8b-instant":            { inputPerToken: 0.05 / 1e6,  outputPerToken: 0.08 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/llama-3.3-70b-versatile":         { inputPerToken: 0.59 / 1e6,  outputPerToken: 0.79 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/llama-3.3-70b-specdec":           { inputPerToken: 0.59 / 1e6,  outputPerToken: 0.99 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/llama-4-scout-17b-16e-instruct":  { inputPerToken: 0.11 / 1e6,  outputPerToken: 0.34 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/llama-4-maverick-17b-128e-instruct": { inputPerToken: 0.20 / 1e6, outputPerToken: 0.60 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/gpt-oss-120b":                    { inputPerToken: 0.15 / 1e6,  outputPerToken: 0.60 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/gpt-oss-20b":                     { inputPerToken: 0.075 / 1e6, outputPerToken: 0.30 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/gpt-oss-safeguard-20b":           { inputPerToken: 0.075 / 1e6, outputPerToken: 0.30 / 1e6, source: GROQ_P + " (20b family rate)", fetched: "2026-09-30" },
  "groq/qwen3-32b":                       { inputPerToken: 0.29 / 1e6,  outputPerToken: 0.59 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/kimi-k2-instruct":                { inputPerToken: 1.00 / 1e6,  outputPerToken: 3.00 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  "groq/llama-guard-4-12b":               { inputPerToken: 0.20 / 1e6,  outputPerToken: 0.20 / 1e6, source: GROQ_P, fetched: "2026-09-30" },
  // compound: base model rate; tool-call surcharges (search/code-exec) are billed separately by Groq and not visible in token usage
  "groq/compound":                        { inputPerToken: 0.15 / 1e6,  outputPerToken: 0.60 / 1e6, source: GROQ_P + " (base rate, excl. tool surcharges)", fetched: "2026-09-30" },

  // ---- cerebras (paid tier, pay-as-you-go) — fetched 2026-09-30 ----
  "cerebras/llama-3.3-70b": { inputPerToken: 0.85 / 1e6, outputPerToken: 1.20 / 1e6, source: CEREBRAS_P, fetched: "2026-09-30" },
  "cerebras/qwen-3-32b":    { inputPerToken: 0.40 / 1e6, outputPerToken: 0.80 / 1e6, source: CEREBRAS_P, fetched: "2026-09-30" },
  "cerebras/gpt-oss-120b":  { inputPerToken: 0.35 / 1e6, outputPerToken: 0.75 / 1e6, source: CEREBRAS_P, fetched: "2026-09-30" },
  "cerebras/glm-4.7":       { inputPerToken: 2.25 / 1e6, outputPerToken: 2.75 / 1e6, source: CEREBRAS_P, fetched: "2026-09-30" },

  // ---- deepseek — fetched 2026-09-30 ----
  // deepseek-chat / deepseek-reasoner = DeepSeek-V3.2 on the official pricing page
  "deepseek/deepseek-chat":     { inputPerToken: 0.28 / 1e6,  outputPerToken: 0.42 / 1e6, source: DEEPSEEK_P, fetched: "2026-09-30" },
  "deepseek/deepseek-reasoner": { inputPerToken: 0.28 / 1e6,  outputPerToken: 0.42 / 1e6, source: DEEPSEEK_P, fetched: "2026-09-30" },
  "deepseek/deepseek-v4-flash": { inputPerToken: 0.14 / 1e6,  outputPerToken: 0.28 / 1e6, source: DEEPSEEK_P, fetched: "2026-09-30" },
  "deepseek/deepseek-v4-pro":   { inputPerToken: 0.435 / 1e6, outputPerToken: 0.87 / 1e6, source: DEEPSEEK_P, fetched: "2026-09-30" },

  // ---- moonshot (Kimi) — fetched 2026-09-30 ----
  "moonshot/kimi-k2.5":        { inputPerToken: 0.60 / 1e6, outputPerToken: 3.00 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },
  "moonshot/kimi-k2-instruct": { inputPerToken: 0.60 / 1e6, outputPerToken: 2.50 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },
  "moonshot/kimi-k2.6":        { inputPerToken: 0.95 / 1e6, outputPerToken: 4.00 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },
  "moonshot/kimi-k2.7-code":   { inputPerToken: 0.95 / 1e6, outputPerToken: 4.00 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },
  "moonshot/moonshot-v1-8k":   { inputPerToken: 0.20 / 1e6, outputPerToken: 2.00 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },
  "moonshot/moonshot-v1-32k":  { inputPerToken: 1.00 / 1e6, outputPerToken: 3.00 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },
  "moonshot/moonshot-v1-128k": { inputPerToken: 2.00 / 1e6, outputPerToken: 5.00 / 1e6, source: MOONSHOT_P, fetched: "2026-09-30" },

  // ---- anthropic (routed via flock/NIM proxy — no direct key) — fetched 2026-09-30 ----
  "anthropic/claude-opus-4.1":  { inputPerToken: 15.00 / 1e6, outputPerToken: 75.00 / 1e6, source: ANTHROPIC_P, fetched: "2026-09-30" },
  "anthropic/claude-sonnet-4":  { inputPerToken: 3.00 / 1e6,  outputPerToken: 15.00 / 1e6, source: ANTHROPIC_P, fetched: "2026-09-30" },
  "anthropic/claude-haiku-3.5": { inputPerToken: 0.80 / 1e6,  outputPerToken: 4.00 / 1e6,  source: ANTHROPIC_P, fetched: "2026-09-30" },
};

const ZERO: ModelPricing = {
  inputPerToken: 0, outputPerToken: 0,
  source: "known-free: self-hosted or free tier", fetched: "2026-09-30",
};

// ---------------------------------------------------------------------------
// OpenRouter dynamic pricing — https://openrouter.ai/api/v1/models
// Cached on disk (7-day TTL); refresh with `bun ledger.ts pricing refresh`.
// A missing/stale cache never blocks accounting: the model is recorded as
// unpriced and a background refresh is kicked off for next time.
// ---------------------------------------------------------------------------

const OR_CACHE_PATH = join(homedir(), ".cache", "ranch-ledger", "openrouter-pricing.json");
const OR_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

interface ORCache {
  fetchedAt: string; // ISO
  models: Record<string, { prompt: number; completion: number }>; // USD per token
}

let orCache: ORCache | null | undefined; // undefined = not loaded yet
let orRefreshInFlight = false;

function loadORCache(): ORCache | null {
  if (orCache !== undefined) return orCache;
  try {
    orCache = JSON.parse(readFileSync(OR_CACHE_PATH, "utf8")) as ORCache;
  } catch {
    orCache = null;
  }
  return orCache;
}

function orCacheStale(c: ORCache | null): boolean {
  if (!c) return true;
  return Date.now() - Date.parse(c.fetchedAt) > OR_CACHE_TTL_MS;
}

/** Fetch OpenRouter's model catalog and rewrite the disk cache. Returns model count. */
export async function refreshOpenRouterPricing(): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { "User-Agent": "ranch-ledger/1.0" },
  });
  if (!res.ok) throw new Error(`openrouter models API: HTTP ${res.status}`);
  const j = (await res.json()) as any;
  const models: ORCache["models"] = {};
  for (const m of j.data || []) {
    const prompt = parseFloat(m?.pricing?.prompt);
    const completion = parseFloat(m?.pricing?.completion);
    if (m?.id && isFinite(prompt) && isFinite(completion)) {
      models[m.id] = { prompt, completion };
    }
  }
  const cache: ORCache = { fetchedAt: new Date().toISOString(), models };
  mkdirSync(join(homedir(), ".cache", "ranch-ledger"), { recursive: true });
  writeFileSync(OR_CACHE_PATH, JSON.stringify(cache));
  orCache = cache;
  return Object.keys(models).length;
}

function triggerORRefresh(): void {
  if (orRefreshInFlight) return;
  orRefreshInFlight = true;
  refreshOpenRouterPricing()
    .catch(() => {})
    .finally(() => { orRefreshInFlight = false; });
}

function lookupOpenRouter(id: string): ModelPricing | null {
  const c = loadORCache();
  if (orCacheStale(c)) triggerORRefresh();
  if (!c) return null;
  const e = c.models[id];
  if (!e) return null;
  return {
    inputPerToken: e.prompt,
    outputPerToken: e.completion,
    source: "https://openrouter.ai/api/v1/models",
    fetched: c.fetchedAt.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Model → pricing-key resolution. No silent fallbacks: unknown → unpriced.
// ---------------------------------------------------------------------------

export interface ResolvedPricing {
  key: string;                 // canonical "provider/model" key stored in the DB
  pricing: ModelPricing | null; // null = unpriced
  free: boolean;               // true = known-free ($0.00)
}

export function resolvePricing(provider: string, rawModel: string): ResolvedPricing {
  const p = (provider || "unknown").toLowerCase().trim();
  let m = (rawModel || "").toLowerCase().trim();
  if (m.startsWith(p + "/")) m = m.slice(p.length + 1);
  if (m.startsWith("models/")) m = m.slice(7); // google "models/" prefix

  // ---- known-free traffic ----
  if (p === "llama-swap" || p === "nim-local") return { key: `${p}/${m}`, pricing: ZERO, free: true };
  if (p === "huggingface" || p === "github") return { key: `${p}/${m}`, pricing: ZERO, free: true };
  if (m.endsWith(":free")) return { key: `${p}/${m}`, pricing: ZERO, free: true };

  // ---- openrouter: dynamic per-model pricing ----
  if (p === "openrouter") {
    const hit = lookupOpenRouter(m);
    if (hit) return { key: `openrouter/${m}`, pricing: hit, free: false };
    return { key: `openrouter/${m}`, pricing: null, free: false };
  }

  // ---- static per-provider rules (ordered: specific before general) ----
  const key = matchStatic(p, m);
  if (key) return { key, pricing: PRICING[key], free: false };
  return { key: `${p}/${m}`, pricing: null, free: false };
}

function matchStatic(p: string, m: string): string | null {
  switch (p) {
    case "google": {
      if (m.includes("3-flash-preview")) return "google/gemini-3-flash-preview";
      if (m.includes("3.1-pro-preview") || m.includes("3-pro-preview")) return "google/gemini-3.1-pro-preview";
      if (m.includes("3.5-flash")) return "google/gemini-3.5-flash";
      if (m.includes("2.5-pro")) return "google/gemini-2.5-pro";
      if (m.includes("2.5-flash-lite") || m.includes("flash-lite")) return "google/gemini-2.5-flash-lite";
      if (m.includes("2.5-flash")) return "google/gemini-2.5-flash";
      if (m.includes("2.0-flash")) return "google/gemini-2.0-flash";
      return null; // gemma-*, *-latest aliases, tts, tool-retrieval: unpriced, never guessed
    }
    case "mistral": {
      if (m.includes("magistral-medium")) return "mistral/magistral-medium";
      if (m.includes("magistral-small")) return "mistral/magistral-small";
      if (m.includes("medium")) return "mistral/mistral-medium-3.5";
      if (m.includes("large")) return "mistral/mistral-large-3";
      if (m.includes("small-4") || m.includes("small-2603") || m.includes("mistral-small")) return "mistral/mistral-small-4";
      if (m.includes("ministral-14b") || m.includes("ministral-14")) return "mistral/ministral-14b";
      if (m.includes("ministral-8b") || m.includes("ministral-8")) return "mistral/ministral-8b";
      if (m.includes("ministral-3b") || m.includes("ministral-3")) return "mistral/ministral-3b";
      if (m.includes("codestral") || m.includes("mistral-code")) return "mistral/codestral";
      if (m.includes("devstral-small")) return "mistral/devstral-small-2";
      if (m.includes("devstral")) return "mistral/devstral-2";
      if (m.includes("nemo")) return "mistral/mistral-nemo";
      return null; // voxtral (audio/min-based billing), vibe, ocr: unpriced
    }
    case "groq": {
      if (m.includes("whisper")) return null; // per-hour billing, not per-token
      if (m.includes("llama-3.1-8b-instant")) return "groq/llama-3.1-8b-instant";
      if (m.includes("llama-3.3-70b-versatile")) return "groq/llama-3.3-70b-versatile";
      if (m.includes("llama-3.3-70b-specdec")) return "groq/llama-3.3-70b-specdec";
      if (m.includes("llama-4-scout")) return "groq/llama-4-scout-17b-16e-instruct";
      if (m.includes("llama-4-maverick")) return "groq/llama-4-maverick-17b-128e-instruct";
      if (m.includes("gpt-oss-safeguard-20b")) return "groq/gpt-oss-safeguard-20b";
      if (m.includes("gpt-oss-120b")) return "groq/gpt-oss-120b";
      if (m.includes("gpt-oss-20b")) return "groq/gpt-oss-20b";
      if (m.includes("qwen3-32b") || m.includes("qwen-3-32b")) return "groq/qwen3-32b";
      if (m.includes("kimi-k2")) return "groq/kimi-k2-instruct";
      if (m.includes("llama-guard")) return "groq/llama-guard-4-12b";
      if (m.includes("compound")) return "groq/compound";
      return null;
    }
    case "cerebras": {
      if (m.includes("gpt-oss-120b")) return "cerebras/gpt-oss-120b";
      if (m.includes("qwen-3-32b") || m.includes("qwen3-32b")) return "cerebras/qwen-3-32b";
      if (m.includes("llama-3.3-70b")) return "cerebras/llama-3.3-70b";
      if (m.includes("glm-4.7")) return "cerebras/glm-4.7";
      return null;
    }
    case "deepseek": {
      if (m.includes("v4-pro")) return "deepseek/deepseek-v4-pro";
      if (m.includes("v4-flash") || m === "deepseek-flash") return "deepseek/deepseek-v4-flash";
      if (m.includes("deepseek-reasoner")) return "deepseek/deepseek-reasoner";
      if (m.includes("deepseek-chat")) return "deepseek/deepseek-chat";
      return null;
    }
    case "moonshot": {
      if (m.includes("k2.6")) return "moonshot/kimi-k2.6";
      if (m.includes("k2.7")) return "moonshot/kimi-k2.7-code";
      if (m.includes("k2.5")) return "moonshot/kimi-k2.5";
      if (m.includes("k2-instruct") || m.includes("k2-0905") || m.includes("k2-turbo")) return "moonshot/kimi-k2-instruct";
      if (m.includes("v1-8k")) return "moonshot/moonshot-v1-8k";
      if (m.includes("v1-32k")) return "moonshot/moonshot-v1-32k";
      if (m.includes("v1-128k")) return "moonshot/moonshot-v1-128k";
      return null;
    }
    case "anthropic": {
      if (m.includes("opus-4")) return "anthropic/claude-opus-4.1";
      if (m.includes("sonnet-4")) return "anthropic/claude-sonnet-4";
      if (m.includes("haiku-3")) return "anthropic/claude-haiku-3.5";
      return null;
    }
    default:
      // nvidia (NIM credit billing — no verified per-token rate),
      // kimi-auto (resolves dynamically), and everything else: unpriced
      return null;
  }
}

/** USD cost for a token pair, or null when the model is unpriced. */
export function priceFor(provider: string, model: string, inputTokens: number, outputTokens: number): number | null {
  const r = resolvePricing(provider, model);
  if (!r.pricing) return null;
  return inputTokens * r.pricing.inputPerToken + outputTokens * r.pricing.outputPerToken;
}

// ---------------------------------------------------------------------------
// Durable SQLite store (with migration from the google-only v1 schema)
// ---------------------------------------------------------------------------

const DB_DIR = join(homedir(), ".cache", "ranch-ledger");
const DB_PATH = join(DB_DIR, "ledger.db");

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH, { create: true });
  migrate(db);
  return db;
}

function migrate(d: Database): void {
  // Detect the v1 schema (no provider column, cost_usd NOT NULL) and rebuild
  // BEFORE creating any indexes — indexing a missing column throws.
  const cols = d.query(`PRAGMA table_info(usage_log)`).all() as any[];
  const hasProvider = cols.some((c) => c.name === "provider");
  const ddl = (d.query(`SELECT sql FROM sqlite_master WHERE name='usage_log'`).get() as any)?.sql || "";
  const costNotNull = /cost_usd\s+REAL\s+NOT\s+NULL/i.test(ddl);
  if (cols.length > 0 && (!hasProvider || costNotNull)) {
    d.exec(`
      CREATE TABLE usage_log_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        date TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'unknown',
        model TEXT NOT NULL,
        raw_model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL,
        request_id TEXT
      );
      INSERT INTO usage_log_new (id, ts, date, provider, model, raw_model, input_tokens, output_tokens, cost_usd, request_id)
        SELECT id, ts, date,
               ${hasProvider ? "COALESCE(provider,'unknown')" : "'unknown'"},
               model, raw_model, input_tokens, output_tokens, cost_usd, request_id
        FROM usage_log;
      DROP TABLE usage_log;
      ALTER TABLE usage_log_new RENAME TO usage_log;
    `);
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'unknown',
      model TEXT NOT NULL,
      raw_model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL,
      request_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_log(date);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_log(model);
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log(provider);
  `);
}

export interface UsageRecord {
  provider: string;        // router provider name, e.g. "google", "openrouter", "mistral"
  model: string;           // raw model ID as the router saw it
  inputTokens: number;
  outputTokens: number;
  requestId?: string;
  timestamp?: number;      // unix millis, defaults to now
}

/**
 * Record token usage for a single request.
 * Returns the USD cost, 0 for known-free, or null when unpriced.
 * Never throws: accounting must never break serving.
 */
export function recordUsage(rec: UsageRecord): number | null {
  try {
    const d = getDb();
    const r = resolvePricing(rec.provider, rec.model);
    const costUsd = r.pricing
      ? rec.inputTokens * r.pricing.inputPerToken + rec.outputTokens * r.pricing.outputPerToken
      : null;
    const ts = rec.timestamp || Date.now();
    const date = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD UTC
    d.query(`
      INSERT INTO usage_log (ts, date, provider, model, raw_model, input_tokens, output_tokens, cost_usd, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ts, date, rec.provider, r.key, rec.model, rec.inputTokens, rec.outputTokens, costUsd, rec.requestId || null);
    return costUsd;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reports — grouped by provider + model, unpriced shown separately
// ---------------------------------------------------------------------------

export interface ModelSlice {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;        // priced dollars only
  unpricedRequests: number;
  unpricedTokens: number;
}

export interface DailyCost {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;         // priced dollars only
  unpricedRequests: number;
  unpricedTokens: number;
  byProvider: Record<string, ModelSlice>;
  byModel: Record<string, ModelSlice>;
  unpricedModels: string[]; // canonical keys seen with NULL cost
}

function emptySlice(): ModelSlice {
  return { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedRequests: 0, unpricedTokens: 0 };
}

export function getDailyCost(date: string): DailyCost {
  const d = getDb();
  const rows = d.query(`SELECT * FROM usage_log WHERE date = ?`).all(date) as any[];
  const result: DailyCost = {
    date, requests: rows.length, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    costUsd: 0, unpricedRequests: 0, unpricedTokens: 0,
    byProvider: {}, byModel: {}, unpricedModels: [],
  };
  const unpricedSet = new Set<string>();
  for (const r of rows) {
    const tokens = r.input_tokens + r.output_tokens;
    result.inputTokens += r.input_tokens;
    result.outputTokens += r.output_tokens;
    const priced = r.cost_usd !== null;
    if (priced) result.costUsd += r.cost_usd;
    else { result.unpricedRequests++; result.unpricedTokens += tokens; unpricedSet.add(r.model); }
    for (const bucket of [result.byProvider, result.byModel]) {
      const k = bucket === result.byProvider ? r.provider : r.model;
      if (!bucket[k]) bucket[k] = emptySlice();
      const s = bucket[k];
      s.requests++;
      s.inputTokens += r.input_tokens;
      s.outputTokens += r.output_tokens;
      if (priced) s.costUsd += r.cost_usd;
      else { s.unpricedRequests++; s.unpricedTokens += tokens; }
    }
  }
  result.totalTokens = result.inputTokens + result.outputTokens;
  result.unpricedModels = [...unpricedSet].sort();
  return result;
}

/** Cost summary for a date range (inclusive). */
export function getCostSummary(startDate: string, endDate: string): DailyCost[] {
  const d = getDb();
  const dates = d.query(`
    SELECT DISTINCT date FROM usage_log WHERE date >= ? AND date <= ? ORDER BY date
  `).all(startDate, endDate) as any[];
  return dates.map((r: any) => getDailyCost(r.date));
}

export interface LedgerStatus {
  dbPath: string;
  rows: number;
  providers: string[];
  unpricedRows: number;
  openrouterCache: { models: number; fetchedAt: string; stale: boolean } | null;
}

export function getStatus(): LedgerStatus {
  const d = getDb();
  const rows = (d.query(`SELECT COUNT(*) AS n FROM usage_log`).get() as any).n as number;
  const providers = (d.query(`SELECT DISTINCT provider AS p FROM usage_log`).all() as any[]).map((r) => r.p);
  const unpricedRows = (d.query(`SELECT COUNT(*) AS n FROM usage_log WHERE cost_usd IS NULL`).get() as any).n as number;
  const c = loadORCache();
  return {
    dbPath: DB_PATH,
    rows,
    providers,
    unpricedRows,
    openrouterCache: c
      ? { models: Object.keys(c.models).length, fetchedAt: c.fetchedAt, stale: orCacheStale(c) }
      : null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd, arg1, arg2] = args;
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (cmd === "daily" && arg1) {
    console.log(JSON.stringify(getDailyCost(arg1), null, 2));
  } else if (cmd === "range" && arg1 && arg2) {
    console.log(JSON.stringify(getCostSummary(arg1, arg2), null, 2));
  } else if (cmd === "pricing" && arg1 === "refresh") {
    refreshOpenRouterPricing()
      .then((n) => console.log(`openrouter pricing cache refreshed: ${n} models`))
      .catch((e) => { console.error(`refresh failed: ${e}`); process.exit(1); });
  } else if (cmd === "pricing") {
    for (const [k, v] of Object.entries(PRICING)) {
      console.log(`${k}: in=$${(v.inputPerToken * 1e6).toFixed(4)}/1M out=$${(v.outputPerToken * 1e6).toFixed(4)}/1M [${v.source} @ ${v.fetched}]`);
    }
    const c = loadORCache();
    console.log(`openrouter: dynamic via https://openrouter.ai/api/v1/models` +
      (c ? ` (cache: ${Object.keys(c.models).length} models, fetched ${c.fetchedAt})` : ` (no cache — run 'pricing refresh')`));
    console.log(`free: llama-swap, nim-local, huggingface, github, *:free tiers ($0.00)`);
    console.log(`unpriced: nvidia/NIM (credit billing, no verified per-token rate), kimi-auto, unknown models`);
  } else if (cmd === "status") {
    console.log(JSON.stringify(getStatus(), null, 2));
  } else if (cmd === "record" && arg1 && arg2) {
    const cost = recordUsage({
      provider: flag("--provider") || "unknown",
      model: arg1,
      inputTokens: parseInt(arg2, 10),
      outputTokens: parseInt(args[3] || "0", 10),
      requestId: flag("--request"),
    });
    console.log(`recorded: ${arg1} ${cost === null ? "unpriced" : "$" + cost.toFixed(6)}`);
  } else {
    console.log("Usage:");
    console.log("  bun ledger.ts daily YYYY-MM-DD");
    console.log("  bun ledger.ts range START END");
    console.log("  bun ledger.ts pricing");
    console.log("  bun ledger.ts pricing refresh");
    console.log("  bun ledger.ts status");
    console.log("  bun ledger.ts record <model> <in-tokens> <out-tokens> [--provider P] [--request ID]");
  }
}
