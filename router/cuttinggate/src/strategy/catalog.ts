/**
 * flock/ts/strategy/catalog — provider catalog helpers for the strategy tier.
 *
 * Pure functions over the catalog: key resolution, model-spec normalization,
 * free-model eligibility, local role models. `loadLocalRoleModels` reads one
 * optional file at import; nothing else touches the filesystem or network.
 *
 * Pattern: `normalizeModelSpec` is a dispatch table of matchers, each
 * returning a NormalizedSpec or null; the first non-null wins. Adding a new
 * spec shape is a new entry in the table, not another branch in the function.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ProviderDef } from "../../../../../../packages/providers/src/index.ts";
import type { ProviderView } from "./types.ts";

// ── timing / strategy constants, frozen ────────────────────────────────────
export const TIMING = Object.freeze({
  MAX_PARALLEL: 4,
  FIFO_MAX: 64,
  CONNECT_MS: parseInt(process.env.ESTATE_CONNECT_MS || "8000", 10),
  TTFT_MS: parseInt(process.env.ESTATE_TTFT_MS || "45000", 10),
  ATTEMPT_MS: parseInt(process.env.ESTATE_ATTEMPT_MS || "120000", 10),
  ATTEMPT_STREAM_MS: parseInt(process.env.ESTATE_ATTEMPT_STREAM_MS || "300000", 10),
  HEDGE_MS: parseInt(process.env.ESTATE_HEDGE_MS || "1500", 10),
});

export const MAX_PARALLEL = TIMING.MAX_PARALLEL;
export const FIFO_MAX = TIMING.FIFO_MAX;
export const CONNECT_MS = TIMING.CONNECT_MS;
export const TTFT_MS = TIMING.TTFT_MS;
export const ATTEMPT_MS = TIMING.ATTEMPT_MS;
export const ATTEMPT_STREAM_MS = TIMING.ATTEMPT_STREAM_MS;
export const HEDGE_MS = TIMING.HEDGE_MS;

export const DEFAULT_STRATEGY = process.env.ESTATE_STRATEGY || "hybrid";
export const UA = "Mozilla/5.0 (compatible; Estate-Flock/3.1)";

/** Code-shaped output detector (AST race preference). */
export const AST_RE =
  /(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|```)/i;

export function isAst(text: string): boolean {
  return Boolean(text && (AST_RE.test(text.slice(0, 5000)) || text.includes("```")));
}

// ── local role models (herd) ───────────────────────────────────────────────
export interface LocalRoles {
  fast: string;
  quality: string;
  longctx: string;
}

const DEFAULT_ROLES: LocalRoles = {
  fast: "beellama/exaone-4-0-1-2b-iq4xs",
  quality: "beellama/qwen-flash-64k",
  longctx: "beellama/qwen-flash-256k",
};

export function loadLocalRoleModels(): LocalRoles {
  try {
    const p = "/home/toxic/estate/.state/best-models.json";
    if (!existsSync(p)) return DEFAULT_ROLES;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return {
      fast: j?.roles?.fast?.id || j?.recommended?.preload || DEFAULT_ROLES.fast,
      quality: j?.roles?.quality?.id || j?.recommended?.default_chat || DEFAULT_ROLES.quality,
      longctx: j?.roles?.longctx?.id || j?.recommended?.long_context || DEFAULT_ROLES.longctx,
    };
  } catch {
    return DEFAULT_ROLES;
  }
}

export const LOCAL_ROLES = loadLocalRoleModels();

// ── ProviderView construction from Roost defs ──────────────────────────────
export function providerView(def: ProviderDef): ProviderView {
  return {
    name: def.name,
    baseUrl: def.baseUrl.replace(/\/$/, ""),
    keyEnv: def.keyEnv,
    ...(def.keyEnvAlt ? { keyEnvAlt: def.keyEnvAlt } : {}),
    ...(def.auth === "none" ? { noAuth: true } : {}),
    ...(def.extraHeaders ? { extraHeaders: def.extraHeaders } : {}),
  };
}

export function providerViews(defs: ProviderDef[]): ProviderView[] {
  return defs.filter((d) => d.enabled !== false).map(providerView);
}

// ── key resolution ─────────────────────────────────────────────────────────
/** First non-empty key wins (pool alt first, like the router). */
export function resolveKeyEnv(view: ProviderView): string | undefined {
  if (view.keyEnvAlt) {
    const pool = (process.env[view.keyEnvAlt] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (pool.length > 0) return pool[0];
  }
  return process.env[view.keyEnv];
}

export function keyOkFor(view: ProviderView): boolean {
  if (view.noAuth) return true;
  return Boolean(resolveKeyEnv(view));
}

/** NVIDIA multi-key pool (all keys, for the token-bucket rotator). */
export function nvidiaKeys(): string[] {
  return (process.env.NVIDIA_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Model aliases (CODING) — local routing aliases overlaying Roost's map ──
export function buildCoding(
  roles: LocalRoles,
  pkgAliases: Record<string, [string, string]>,
): Record<string, [string, string] | null> {
  return {
    auto: null,
    fcm: null,
    free: null,
    fast: ["herd", roles.fast],
    "local-fast": ["herd", roles.fast],
    quality: ["herd", roles.quality],
    "local-quality": ["herd", roles.quality],
    longctx: ["herd", roles.longctx],
    "local-longctx": ["herd", roles.longctx],
    "local-auto": ["herd", roles.quality],
    ...pkgAliases,
  };
}

// ── Catalog query helpers (parameterized — callers supply the catalog) ─────
export interface CatalogQuery {
  providerNames(): string[];
  servingModels(provider: string): string[];
  isQuarantined(provider: string, model: string): boolean;
  deadIds(): Set<string>;
  keyOk(provider: string): boolean;
}

export function firstModelFor(p: string, q: CatalogQuery, roles: LocalRoles = LOCAL_ROLES): string {
  if (p === "herd") return roles.quality;
  return q.servingModels(p)[0] || "";
}

const LOCAL_PREFIX_RE = /^(beellama|mradermacher|jackrong|turboquant|ik_llama|ik_turboquant|holo|qwen\/|gemma-4|exaone)/i;

export function isLocalSwapModelId(
  model: string,
  coding: Record<string, [string, string] | null>,
  roles: LocalRoles = LOCAL_ROLES,
): boolean {
  if (!model || model === "auto" || model === "fcm") return false;
  if (model in coding && coding[model]?.[0] === "herd") return true;
  if (model === roles.fast || model === roles.quality || model === roles.longctx) return true;
  return LOCAL_PREFIX_RE.test(model);
}

export function isExplicit(
  model: string,
  coding: Record<string, [string, string] | null>,
  roles: LocalRoles = LOCAL_ROLES,
): boolean {
  return (model in coding && coding[model] != null) || isLocalSwapModelId(model, coding, roles);
}

// ── model-spec normalization — dispatch table ──────────────────────────────
export interface NormalizedSpec {
  provider: string | null;
  model: string;
}

type MatcherContext = {
  readonly q: CatalogQuery;
  readonly coding: Record<string, [string, string] | null>;
};

type Matcher = (spec: string, ctx: MatcherContext) => NormalizedSpec | null;

function stripTag(m: string): string {
  const i = m.indexOf(":");
  return i === -1 ? m : m.slice(0, i);
}

function lastSeg(s: string): string {
  return s.slice(s.lastIndexOf("/") + 1);
}

/** Best catalog model id on provider p matching a loose name `rest`. */
export function matchModelOnProvider(p: string, rest: string, q: CatalogQuery): string | null {
  const r = (rest || "").trim();
  if (!r) return null;
  const cat = q.servingModels(p);
  if (cat.includes(r)) return r;
  const rBase = lastSeg(stripTag(r)).toLowerCase();
  for (const m of cat) {
    if (lastSeg(stripTag(m)).toLowerCase() === rBase) return m;
  }
  return null;
}

const MATCHERS: readonly Matcher[] = [
  // CODING aliases pass through untouched.
  (s, { coding }) => (s in coding ? { provider: null, model: s } : null),
  // Bare model id already in some catalog: provider-agnostic.
  (s, { q }) => {
    for (const p of q.providerNames()) {
      if (q.servingModels(p).includes(s)) return { provider: null, model: s };
    }
    return null;
  },
  // "provider:model" colon form.
  (s, { q }) => {
    const ci = s.indexOf(":");
    if (ci <= 0) return null;
    const pre = s.slice(0, ci).toLowerCase();
    if (!q.providerNames().includes(pre)) return null;
    const mid = matchModelOnProvider(pre, s.slice(ci + 1), q);
    return mid ? { provider: pre, model: mid } : null;
  },
  // "provider/rest/of/id" slash form, e.g. "openrouter/openai/gpt-oss-20b:free".
  (s, { q }) => {
    const si = s.indexOf("/");
    if (si <= 0) return null;
    const pre = s.slice(0, si).toLowerCase();
    if (!q.providerNames().includes(pre)) return null;
    const rest = s.slice(si + 1);
    if (q.servingModels(pre).includes(rest)) return { provider: pre, model: rest };
    const mid = matchModelOnProvider(pre, rest, q);
    return mid ? { provider: pre, model: mid } : null;
  },
];

export function normalizeModelSpec(
  spec: string,
  q: CatalogQuery,
  coding: Record<string, [string, string] | null>,
): NormalizedSpec {
  const s = (spec || "").trim();
  if (!s) return { provider: null, model: "auto" };
  const ctx: MatcherContext = { q, coding };
  for (const match of MATCHERS) {
    const r = match(s, ctx);
    if (r) return r;
  }
  return { provider: null, model: s };
}

export function resolveModel(
  model: string,
  q: CatalogQuery,
  coding: Record<string, [string, string] | null>,
  roles: LocalRoles = LOCAL_ROLES,
): [string, string] {
  const norm = normalizeModelSpec(model, q, coding);
  if (norm.provider) return [norm.provider, norm.model];
  if (model in coding && coding[model] != null) {
    const [p, m] = coding[model]!;
    if (!q.deadIds().has(m) && !q.isQuarantined(p, m)) return [p, m];
  }
  if (isLocalSwapModelId(model, coding, roles)) return ["herd", model];
  if (model === "auto" || model === "fcm") return ["herd", roles.quality];
  for (const p of q.providerNames()) {
    if (q.servingModels(p).includes(model)) return [p, model];
  }
  if (q.keyOk("openrouter")) return ["openrouter", model];
  if (q.keyOk("nvidia")) return ["nvidia", model];
  return ["herd", roles.quality];
}

// ── Live-metadata free eligibility (cached per meta object) ────────────────
//
// Live metadata wins: OpenRouter-style /models carries pricing; prompt +
// completion priced "0" means zero-cost on our key. A provider-set boolean
// "free" flag is honored too. Deterministic fallback: providers whose
// /models carry no pricing metadata keep the ":free" suffix convention, so
// a failed discovery refresh never empties the pool.
const FREE_CACHE = new WeakMap<object, boolean>();

export function modelFree(mid: string, meta: Record<string, unknown> | undefined): boolean {
  if (meta && typeof meta === "object") {
    const cached = FREE_CACHE.get(meta);
    if (cached !== undefined) return cached;
    const pricing = meta["pricing"] as Record<string, unknown> | undefined;
    let result: boolean;
    if (pricing && typeof pricing === "object") {
      const zero = (v: unknown) => v === "0" || v === 0;
      result = zero(pricing["prompt"]) && zero(pricing["completion"]);
    } else if (typeof meta["free"] === "boolean") {
      result = meta["free"] as boolean;
    } else {
      result = mid.includes(":free");
    }
    FREE_CACHE.set(meta, result);
    return result;
  }
  return mid.includes(":free");
}

export function log(...args: unknown[]): void {
  console.error("[flock-strategy]", ...args);
}
