import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// Master providers package — the single source of truth for provider
// definitions, live model discovery, aliases, seeds, and quarantine.
// The router keeps only: env overlays (base-URL/key overrides), the
// runtime-dynamic local-role aliases, and router-side metadata.
import {
  ModelCatalog,
  PROVIDER_DEFS as PKG_PROVIDER_DEFS,
  MODEL_ALIASES as PKG_MODEL_ALIASES,
  DEAD_MODEL_IDS as PKG_DEAD_MODEL_IDS,
  type ProviderDef,
} from "../../../../../../packages/providers/src/index.ts";

// ---------------------------------------------------------------------------
// Secrets + local stack env (mise loads these; standalone bun needs them too)
// ---------------------------------------------------------------------------
export function loadEnvFile(path: string, overwrite = false): void {
  if (!existsSync(path)) return;
  try {
    for (let line of readFileSync(path, "utf8").split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7);
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      if (k && v && (overwrite || !process.env[k])) process.env[k] = v;
    }
  } catch (e) {
    console.error(`[matrix] loadEnvFile ${path}:`, e);
  }
}

loadEnvFile(`${homedir()}/.secrets`);

loadEnvFile("/home/toxic/.secrets");

loadEnvFile("/home/toxic/estate/config/ports.env");

loadEnvFile("/home/toxic/estate/.env.local");

// Port SSOT: service-specific ESTATE_ROUTER_PORT wins; ESTATE_PORT is legacy fallback.
export const _portRaw =
  process.env.ESTATE_ROUTER_PORT || process.env.ESTATE_PORT || "";

if (!_portRaw) {
  throw new Error(
    "ESTATE_ROUTER_PORT or ESTATE_PORT required (config/ports.env)",
  );
}

export const PORT = parseInt(_portRaw, 10);

export const DB_PATH =
  process.env.estate-scripts_DB || "/home/toxic/estate/var/data/estate-scripts_router.db";

export const MAX_PARALLEL = 4;

// --- Resilience tunables (v3.2; all env-overridable, failfast-first) ---
// CONNECT_MS: headers must arrive (dead backend detected fast).
// TTFT_MS: first body byte must arrive for streaming (time-to-first-token).
// ATTEMPT_MS / ATTEMPT_STREAM_MS: total per-attempt caps.
export const CONNECT_MS = parseInt(process.env.ESTATE_CONNECT_MS || "8000", 10);
export const TTFT_MS = parseInt(process.env.ESTATE_TTFT_MS || "45000", 10);
export const ATTEMPT_MS = parseInt(process.env.ESTATE_ATTEMPT_MS || "120000", 10);
export const ATTEMPT_STREAM_MS = parseInt(
  process.env.ESTATE_ATTEMPT_STREAM_MS || "180000",
  10,
);
// QUARANTINE: dead providers are quarantined with exponential backoff
// re-probing: BASE * 2^(level-1) capped at MAX.
export const QUARANTINE_BASE_S = parseInt(
  process.env.ESTATE_QUARANTINE_BASE_S || "60",
  10,
);
export const QUARANTINE_MAX_S = parseInt(
  process.env.ESTATE_QUARANTINE_MAX_S || "1800",
  10,
);
// HEDGE_MS: speculative hedging (HFT redundant-feeds pattern). When a chain
// lane hasn't produced a winner within HEDGE_MS, the next lane fires in
// parallel; first substantive wins, losers are aborted. 0 disables.
export const HEDGE_MS = parseInt(process.env.ESTATE_HEDGE_MS || "1500", 10);

// Active quarantine re-probe cadence.
export const QUARANTINE_PROBE_MS = parseInt(
  process.env.ESTATE_QUARANTINE_PROBE_MS || "15000",
  10,
);

export const STICKY_TTL = 1800;

export const FIFO_MAX = 64;

export const STRATEGY = process.env.ESTATE_STRATEGY || "auto";

export const UA = "Mozilla/5.0 (compatible; Estate-Flock/3.1)";

// ---------------------------------------------------------------------------
// HERD_V1 (must come before PROVIDERS that uses it)
// ---------------------------------------------------------------------------
export const HERD_V1 =
  process.env.LLM_BASE_URL ||
  process.env.HERD_V1 ||
  "http://127.0.0.1:25100/v1";

export function loadLocalRoleModels(): {
  fast: string;
  quality: string;
  longctx: string;
} {
  const defaults = {
    fast: "beellama/exaone-4-0-1-2b-iq4xs",
    quality: "beellama/qwen-flash-64k",
    longctx: "beellama/qwen-flash-256k",
  };
  try {
    const p = "/home/toxic/estate/.state/best-models.json";
    if (!existsSync(p)) return defaults;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return {
      fast: j?.roles?.fast?.id || j?.recommended?.preload || defaults.fast,
      quality:
        j?.roles?.quality?.id ||
        j?.recommended?.default_chat ||
        defaults.quality,
      longctx:
        j?.roles?.longctx?.id ||
        j?.recommended?.long_context ||
        defaults.longctx,
    };
  } catch {
    return defaults;
  }
}

export const LOCAL_ROLES = loadLocalRoleModels();

// ---------------------------------------------------------------------------
// Providers — derived from the master package, with router-local env
// overlays for base URLs. The package owns names, default bases, key envs,
// adapters, seeds, and aliases; this file only applies this box's overrides.
// ---------------------------------------------------------------------------
function effectiveDefs(): ProviderDef[] {
  return PKG_PROVIDER_DEFS.map((d) => {
    // Local SSOT — always first-class for estate GPU path
    if (d.name === "herd") return { ...d, baseUrl: HERD_V1 };
    // Local NIM proxy (:8000, nim-consolidation track). Shows dead in
    // /status until the proxy key lands — the router then picks it up via
    // hot reload (/admin/reload, SIGHUP).
    if (d.name === "nim-local")
      return { ...d, baseUrl: process.env.NIM_PROXY_BASE || d.baseUrl };
    // kimi-auto sidecar shim (pitchfork daemon kimi-auto-shim): rewrites
    // model "kimi-auto" -> resolver's current best Kimi, forwards to herd.
    // Kimi-only by design (shim 503s when no Kimi candidate is healthy).
    if (d.name === "kimi-auto")
      return {
        ...d,
        baseUrl:
          process.env.KIMI_AUTO_SHIM_BASE ||
          "http://127.0.0.1:" +
            (process.env.KIMI_AUTO_SHIM_PORT || "25153") +
            "/v1",
      };
    return d;
  });
}

const EFFECTIVE_DEFS = effectiveDefs();

export const PROVIDERS: Record<
  string,
  { base: string; key_env: string; key_env_alt?: string; no_auth?: boolean }
> = Object.fromEntries(
  EFFECTIVE_DEFS.filter((d) => d.enabled !== false).map((d) => [
    d.name,
    {
      base: d.baseUrl,
      key_env: d.keyEnv,
      ...(d.keyEnvAlt ? { key_env_alt: d.keyEnvAlt } : {}),
      ...(d.auth === "none" ? { no_auth: true } : {}),
    },
  ]),
);

// ---------------------------------------------------------------------------
// Catalog — the unified live model catalog (master providers package).
//
// Serving semantics (enforced by the package, not this file):
// - Live discovery owns membership. Seeds serve ONLY before a provider's
//   first successful discovery; afterwards they go inert.
// - Failed refresh changes nothing (stale-serve); a 404 on serve or two
//   consecutive successful refreshes missing an id quarantines it.
// - The dead list is permanent. Quarantine re-admits on re-listing.
// ---------------------------------------------------------------------------
export const CATALOG_STATE_PATH =
  process.env.ESTATE_CATALOG_STATE ||
  "/home/toxic/estate/.state/provider-catalog.json";

export const catalog = new ModelCatalog(EFFECTIVE_DEFS, {
  aliases: PKG_MODEL_ALIASES,
  deadIds: PKG_DEAD_MODEL_IDS,
});

// Restore persisted discovery state (quarantine, miss streaks,
// everDiscovered). Synchronous — runs once at import; the async discovery
// scheduler in router_live_models.ts owns everything after.
catalog.loadFromFileSync(CATALOG_STATE_PATH);

// Router-local overlay: the dynamic local-role model ids from
// .state/best-models.json. These are runtime-derived (not package data),
// so they live in the catalog's overlay tier — served always, never
// pruned by discovery, never persisted — instead of a hardcoded
// provider->models list.
catalog.setOverlay("herd", [
  LOCAL_ROLES.fast,
  LOCAL_ROLES.quality,
  LOCAL_ROLES.longctx,
]);

/** Persist catalog state (quarantine/misses/discovery watermarks). */
export function persistCatalog(): void {
  catalog.saveToFile(CATALOG_STATE_PATH).catch((e) => log("catalog persist failed:", e));
}

// ---------------------------------------------------------------------------
// Live per-model metadata (populated at runtime by router_live_models.ts):
// provider -> model id -> raw provider /models object (pricing, context
// length, architecture...). Model IDs live in the package catalog; metadata
// enriches /v1/models so clients see live data, not just id strings.
export const LIVE_MODEL_META: Record<string, Record<string, unknown>> = {};

// NVIDIA multi-key pool (absorbed from the retired :8000 key-proxy):
// comma-separated nvapi-* keys, each with its own 40rpm token bucket
// (see Matrix.nextNvidiaKey in router_matrix.ts).
export function nvidiaKeys(): string[] {
  const pool = (process.env.NVIDIA_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pool.length) return pool;
  const single = process.env.NVIDIA_API_KEY || "";
  return single ? [single] : [];
}

// ---------------------------------------------------------------------------
// Live model catalog — owned by the package's ModelCatalog above.
// catalogModelsFor() is the single choke point for "what can this provider
// serve right now"; it delegates to the catalog's derived serving set.
// ---------------------------------------------------------------------------
export function catalogModelsFor(p: string): string[] {
  return catalog.servingModels(p);
}

/**
 * DEAD_MODEL_IDS — permanently retired model IDs (master providers package).
 *
 * The package owns this list; this Set is the router's local view of it.
 * Filtered at the catalog's serving choke point, so dead IDs can enter
 * neither the race sets nor explicit routing (an explicit request for one
 * falls through to the healthy hybrid field instead of burning a 404).
 *
 * The runtime serve-404 path (Matrix.noteEntitlement404 → catalog
 * noteServe404) is the dynamic layer for IDs that die mid-process; this
 * list is the static layer for IDs already known dead.
 */
export const DEAD_MODEL_IDS: Set<string> = new Set(PKG_DEAD_MODEL_IDS);

// ---------------------------------------------------------------------------
// Live-metadata free eligibility (Chris 2026-09-17: routing must consume the
// live /models metadata, not a divergent static list).
//
// modelFree(p, mid) is the single source of truth for "this model costs us
// nothing on this key":
//   1. Live metadata wins: OpenRouter-style /models carries pricing; prompt +
//      completion priced "0" means zero-cost on our key. A provider-set
//      boolean "free" flag in the live object is honored too.
//   2. Deterministic fallback: providers whose /models carry no pricing
//      metadata (nvidia/groq/google/mistral) keep the ":free" suffix
//      convention, exactly as before. Curated ":free" ids with no live
//      metadata entry at all (delisted, fetch failure) also keep the suffix
//      rule, so the pool never silently empties on a bad refresh.
export function modelFree(p: string, mid: string): boolean {
  const meta = (LIVE_MODEL_META[p] || {})[mid] as
    | Record<string, unknown>
    | undefined;
  const pricing = meta?.["pricing"] as Record<string, unknown> | undefined;
  if (pricing && typeof pricing === "object") {
    const zero = (v: unknown) => v === "0" || v === 0;
    return zero(pricing["prompt"]) && zero(pricing["completion"]);
  }
  if (typeof meta?.["free"] === "boolean") return meta["free"] as boolean;
  return mid.includes(":free");
}

export const CODING: Record<string, [string, string] | null> = {
  auto: null,
  fcm: null,
  // free: route through the `free` strategy (local + all :free cloud models)
  free: null,
  // Local-first ranked roles (herd exclusive matrix) — runtime-dynamic
  // from best-models.json. These overlay the package's static alias map;
  // everything below comes from the master providers package.
  fast: ["herd", LOCAL_ROLES.fast],
  "local-fast": ["herd", LOCAL_ROLES.fast],
  quality: ["herd", LOCAL_ROLES.quality],
  "local-quality": ["herd", LOCAL_ROLES.quality],
  longctx: ["herd", LOCAL_ROLES.longctx],
  "local-longctx": ["herd", LOCAL_ROLES.longctx],
  "local-auto": ["herd", LOCAL_ROLES.quality],
  ...PKG_MODEL_ALIASES,
};

export const AST_RE =
  /(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|```)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function getKey(p: string): string {
  // NVIDIA serves from the multi-key pool; first key is the default.
  if (p === "nvidia") return nvidiaKeys()[0] || "";
  const conf = PROVIDERS[p];
  if (!conf) return "";
  if (conf.no_auth) return "not-required-for-local";
  return (
    process.env[conf.key_env] ||
    (conf.key_env_alt ? process.env[conf.key_env_alt] : "") ||
    ""
  );
}

export function keyOk(p: string): boolean {
  if (p === "herd" || PROVIDERS[p]?.no_auth) return true;
  if (p === "nvidia") return nvidiaKeys().length > 0;
  const conf = PROVIDERS[p];
  if (!conf) return false;
  return Boolean(
    process.env[conf.key_env] ||
    (conf.key_env_alt ? process.env[conf.key_env_alt] : ""),
  );
}

export function firstModelFor(p: string): string {
  if (p === "herd") return LOCAL_ROLES.quality;
  return catalog.servingModels(p)[0] || "";
}

export function isLocalSwapModelId(model: string): boolean {
  if (!model || model === "auto" || model === "fcm") return false;
  if (model in CODING && CODING[model]?.[0] === "herd") return true;
  if (
    model === LOCAL_ROLES.fast ||
    model === LOCAL_ROLES.quality ||
    model === LOCAL_ROLES.longctx
  ) {
    return true;
  }
  // estate naming prefixes / known local ids
  return /^(beellama|mradermacher|jackrong|turboquant|ik_llama|ik_turboquant|holo|qwen\/|gemma-4|exaone)/i.test(
    model,
  );
}

/**
 * normalizeModelSpec — the openfang `agent set` parsing shim (router-side).
 *
 * Accepts every spec shape the (buggy) fork can produce and returns a
 * canonical { provider, model }:
 *   "nvidia:gpt-oss-20b"      -> { provider: "nvidia", model: <best catalog match> }
 *   "openrouter/openai/gpt-oss-20b:free" -> { provider: "openrouter", model: <same> }
 *   "fast" / "auto"           -> { provider: null, model: <alias untouched> }
 *   "openrouter/inclusionai/ling-3.0-flash-fin:free" -> { provider: "openrouter", model: <same> }
 * provider is null when the spec is provider-agnostic (alias or bare model
 * id); callers then fall back to resolveModel()'s normal catalog search.
 */
export function normalizeModelSpec(spec: string): {
  provider: string | null;
  model: string;
} {
  const s = (spec || "").trim();
  if (!s) return { provider: null, model: "auto" };
  // CODING aliases pass through untouched.
  if (s in CODING) return { provider: null, model: s };
  const provNames = Object.keys(PROVIDERS);
  const inCatalog = (p: string, m: string) => catalogModelsFor(p).includes(m);
  const anyCatalogHas = (m: string) => provNames.some((p) => inCatalog(p, m));
  // Bare model id already in some catalog: provider-agnostic.
  if (anyCatalogHas(s)) return { provider: null, model: s };
  // "provider:model" colon form (the exact shape the fork mangles).
  const ci = s.indexOf(":");
  if (ci > 0) {
    const pre = s.slice(0, ci).toLowerCase();
    if (provNames.includes(pre)) {
      const rest = s.slice(ci + 1);
      const mid = matchModelOnProvider(pre, rest);
      if (mid) return { provider: pre, model: mid };
    }
  }
  // "provider/rest/of/id" slash form, e.g. "openrouter/openai/gpt-oss-20b:free".
  const si = s.indexOf("/");
  if (si > 0) {
    const pre = s.slice(0, si).toLowerCase();
    if (provNames.includes(pre)) {
      const rest = s.slice(si + 1);
      if (inCatalog(pre, rest)) return { provider: pre, model: rest };
      const mid = matchModelOnProvider(pre, rest);
      if (mid) return { provider: pre, model: mid };
    }
  }
  return { provider: null, model: s };
}

/** Best catalog model id on provider p matching a loose name `rest`. */
export function matchModelOnProvider(p: string, rest: string): string | null {
  const r = (rest || "").trim();
  if (!r) return null;
  const cat = catalogModelsFor(p);
  if (cat.includes(r)) return r;
  // `split` always yields >= 1 element, so [0] is never actually undefined;
  // pin the return type so noUncheckedIndexedAccess does not leak
  // `string | undefined` into every caller.
  const stripTag = (m: string): string => m.split(":")[0]!;
  const rBase = stripTag(r).split("/").pop()!.toLowerCase();
  for (const m of cat) {
    if (stripTag(m).split("/").pop()!.toLowerCase() === rBase) return m;
  }
  return null;
}

export function resolveModel(model: string): [string, string] {
  const norm = normalizeModelSpec(model);
  if (norm.provider) return [norm.provider, norm.model];
  if (model in CODING && CODING[model] != null) {
    const [p, m] = CODING[model]!;
    // A dead or quarantined alias target is not routable — fall through to
    // the healthy field instead of burning a 404 on a known-bad id.
    if (!DEAD_MODEL_IDS.has(m) && !catalog.isQuarantined(p, m)) return [p, m];
  }
  // Prefer herd for any local GGUF id so hybrid never sends GPU models to Gemini
  if (isLocalSwapModelId(model)) return ["herd", model];
  if (model === "auto" || model === "fcm") {
    // local-first auto: quality role on swap
    return ["herd", LOCAL_ROLES.quality];
  }
  for (const p of Object.keys(PROVIDERS)) {
    if (catalogModelsFor(p).includes(model)) return [p, model];
  }
  if (keyOk("openrouter")) return ["openrouter", model];
  if (keyOk("nvidia")) return ["nvidia", model];
  return ["herd", LOCAL_ROLES.quality];
}

export function isAst(text: string): boolean {
  return Boolean(
    text && (AST_RE.test(text.slice(0, 5000)) || text.includes("```")),
  );
}

export function isExplicit(model: string): boolean {
  return (
    (model in CODING && CODING[model] != null) || isLocalSwapModelId(model)
  );
}

export function log(...args: unknown[]) {
  console.error("[router]", ...args);
}

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
