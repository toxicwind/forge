/**
 * cuttinggate — live model catalog.
 *
 * The catalog is written by @toxicwind/pinax and read by every routing layer.
 * Two contracts are recognized on read:
 *
 *   estate-pinax/live-catalog/v1        canonical, pinax >= 2.4
 *   estate-providers/live-catalog/v1    predecessor, legacy < 2.4
 *
 * There is no `contractMatched` boolean. The descriptor carries provenance;
 * `stale` is first-class; every failure mode has a name. The compiler forces
 * callers to handle each status because `CatalogLoad` is a tagged union
 * (borrowed from oakoss/agent-skills discriminated-unions).
 *
 * Hot reload follows the pattern from anomalyco/opencode PR #9849: watch
 * the file, debounce writes, keep last-known-good on invalid reload.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  watchFile,
  unwatchFile,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

export const LIVE_CATALOG_CONTRACT = "estate-pinax/live-catalog/v1";
export const LEGACY_CATALOG_CONTRACT = "estate-providers/live-catalog/v1";

export const CONTRACTS = {
  "estate-pinax/live-catalog/v1": {
    generation: 2,
    canonical: true,
    introduced: "2026-06-01",
    emittedBy: "@toxicwind/pinax >= 2.4",
  },
  "estate-providers/live-catalog/v1": {
    generation: 1,
    canonical: false,
    introduced: "2026-01-01",
    emittedBy: "@toxicwind/pinax (legacy, < 2.4)",
  },
} as const;

export type ContractName = keyof typeof CONTRACTS;
export type ContractSpec = {
  readonly generation: number;
  readonly canonical: boolean;
  readonly introduced: string;
  readonly emittedBy: string;
};
export type ContractDescriptor = {
  readonly name: ContractName;
  readonly spec: ContractSpec;
  readonly canonical: boolean;
};
export type ContractUnknown = {
  readonly saw: string;
  readonly expected: readonly ContractName[];
};

export type ProviderEntry = {
  readonly serving: readonly string[];
  readonly quarantined: readonly string[];
  readonly discovered: boolean;
};
export type LiveCatalog = {
  readonly contract: ContractName;
  readonly generatedAt: string;
  readonly deadIds: readonly string[];
  readonly providers: Readonly<Record<string, ProviderEntry>>;
};

export type CatalogLoad =
  | {
      readonly status: "ok";
      readonly source: string;
      readonly contract: ContractDescriptor;
      readonly catalog: LiveCatalog;
      readonly generatedAt: string;
      readonly ageMs: number;
      readonly stale: boolean;
    }
  | {
      readonly status: "missing";
      readonly source: string;
      readonly reason: string;
    }
  | {
      readonly status: "unreadable";
      readonly source: string;
      readonly reason: string;
    }
  | {
      readonly status: "malformed";
      readonly source: string;
      readonly reason: string;
    }
  | {
      readonly status: "unknown-contract";
      readonly source: string;
      readonly contract: ContractUnknown;
    };

export const DEFAULT_CATALOG_PATH =
  "/home/toxic/estate/.state/provider-catalog.live.json";
export const DEFAULT_STALE_MS = 15 * 60_000;

export function loadLiveCatalog(
  source: string = DEFAULT_CATALOG_PATH,
  staleMs: number = DEFAULT_STALE_MS,
): CatalogLoad {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(source).mtimeMs;
    raw = readFileSync(source, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      status: code === "ENOENT" ? "missing" : "unreadable",
      source,
      reason: (e as Error).message,
    };
  }
  let parsed: { contract?: string } & Partial<Omit<LiveCatalog, "contract">>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: "malformed", source, reason: (e as Error).message };
  }
  const saw = parsed.contract ?? "";
  const spec = (CONTRACTS as Record<string, ContractSpec>)[saw];
  if (!spec)
    return {
      status: "unknown-contract",
      source,
      contract: { saw, expected: Object.keys(CONTRACTS) as ContractName[] },
    };
  const providers: Record<string, ProviderEntry> = {};
  for (const [name, value] of Object.entries(parsed.providers ?? {})) {
    providers[name] = {
      serving: [...(value?.serving ?? [])],
      quarantined: [...(value?.quarantined ?? [])],
      discovered: value?.discovered === true,
    };
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  return {
    status: "ok",
    source,
    contract: { name: saw as ContractName, spec, canonical: spec.canonical },
    catalog: {
      contract: saw as ContractName,
      generatedAt: parsed.generatedAt ?? "unknown",
      deadIds: parsed.deadIds ?? [],
      providers,
    },
    generatedAt: parsed.generatedAt ?? "unknown",
    ageMs,
    stale: ageMs > staleMs,
  };
}

export function normalizeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\s+/g, "-");
}

export function* servingIds(
  catalog: LiveCatalog,
): Generator<{ id: string; provider: string }> {
  for (const [provider, entry] of Object.entries(catalog.providers)) {
    for (const id of entry.serving) yield { id, provider };
  }
}

export function deadIdSet(catalog: LiveCatalog): ReadonlySet<string> {
  return deadIds(catalog);
}
export function deadIds(catalog: LiveCatalog): ReadonlySet<string> {
  const dead = new Set<string>();
  for (const entry of Object.values(catalog.providers))
    for (const id of entry.quarantined) dead.add(normalizeId(id));
  for (const id of catalog.deadIds) dead.add(normalizeId(id));
  return dead;
}

export type MatchTier = "exact" | "bare" | "substring";
export type Candidate = {
  readonly id: string;
  readonly provider: string;
  readonly tier: MatchTier;
  readonly live: boolean;
  readonly reason: string;
};
const TIER_ORDER: Record<MatchTier, number> = {
  exact: 0,
  bare: 1,
  substring: 2,
};

export function resolve(catalog: LiveCatalog, requested: string): Candidate[] {
  const dead = deadIdSet(catalog);
  const want = normalizeId(requested);
  if (!want) return [];
  const byTier = new Map<MatchTier, Candidate[]>();
  const push = (tier: MatchTier, c: Candidate) => {
    const b = byTier.get(tier);
    if (b) b.push(c);
    else byTier.set(tier, [c]);
  };
  for (const { id, provider } of servingIds(catalog)) {
    const norm = normalizeId(id);
    const bare = norm.split("/").pop() ?? norm;
    const live = !dead.has(norm);
    if (norm === want)
      push("exact", {
        id,
        provider,
        tier: "exact",
        live,
        reason: "full id match",
      });
    else if (bare === want)
      push("bare", {
        id,
        provider,
        tier: "bare",
        live,
        reason: "bare id match",
      });
    else if (want.length >= 3 && bare.includes(want))
      push("substring", {
        id,
        provider,
        tier: "substring",
        live,
        reason: "substring match",
      });
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => TIER_ORDER[a] - TIER_ORDER[b])
    .flatMap(([, l]) => l)
    .sort((a, b) => a.id.length - b.id.length);
}

export type PickPolicy = {
  readonly requireLive?: boolean;
  readonly minTier?: MatchTier;
  readonly denyProviders?: readonly string[];
  readonly preferProviders?: readonly string[];
};
export type PickRequest =
  { readonly kind: "named"; readonly id: string } | { readonly kind: "auto" };
export type PickResult =
  | {
      readonly status: "picked";
      readonly candidate: Candidate;
      readonly considered: number;
    }
  | {
      readonly status: "no-candidate";
      readonly tried: number;
      readonly reason: string;
    }
  | { readonly status: "no-serving-ids" };

/** Deterministic tie-break: SHA256 of (provider, id) so runs are reproducible. */
function stableHash(c: Candidate): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(`${c.provider}|${c.id}`).digest("hex");
}

function rank(
  candidates: readonly Candidate[],
  prefer: readonly string[],
): Candidate {
  if (!prefer.length)
    return [...candidates].sort(
      (a, b) =>
        a.id.length - b.id.length || stableHash(a).localeCompare(stableHash(b)),
    )[0]!;
  const prefIndex = new Map(prefer.map((p, i) => [p, i]));
  return [...candidates].sort((a, b) => {
    const ai = prefIndex.get(a.provider) ?? Number.MAX_SAFE_INTEGER;
    const bi = prefIndex.get(b.provider) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (
      a.id.length - b.id.length || stableHash(a).localeCompare(stableHash(b))
    );
  })[0]!;
}

/** Pipeline: filter → tier → live → rank. Borrowed from pinto-bean PickOne. */
export function pick(
  catalog: LiveCatalog,
  request: PickRequest,
  policy: PickPolicy = {},
): PickResult {
  const {
    requireLive = true,
    minTier = "bare",
    denyProviders = [],
    preferProviders = [],
  } = policy;
  const deny = new Set(denyProviders);
  const dead = deadIdSet(catalog);
  if (request.kind === "auto") {
    const all = [...servingIds(catalog)]
      .filter(({ provider }) => !deny.has(provider))
      .map(({ id, provider }) => {
        const live = !dead.has(normalizeId(id));
        return {
          id,
          provider,
          tier: "exact" as MatchTier,
          live,
          reason: "auto candidate",
        };
      })
      .filter((c) => !requireLive || c.live);
    if (!all.length) return { status: "no-serving-ids" };
    return {
      status: "picked",
      candidate: rank(all, preferProviders),
      considered: all.length,
    };
  }
  const candidates = resolve(catalog, request.id)
    .filter((c) => !deny.has(c.provider))
    .filter((c) => !requireLive || c.live)
    .filter((c) => TIER_ORDER[c.tier] <= TIER_ORDER[minTier]);
  if (!candidates.length) {
    return {
      status: "no-candidate",
      tried: [...servingIds(catalog)].length,
      reason: `no provider serves ${request.id} under policy`,
    };
  }
  return {
    status: "picked",
    candidate: rank(candidates, preferProviders),
    considered: candidates.length,
  };
}

export type Probe = {
  readonly gateway: "herd" | "flock";
  readonly ok: boolean;
  readonly models: readonly string[];
  readonly ms: number;
  readonly error: string | null;
};
export function gatewayRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function probeGateway(
  gateway: "herd" | "flock",
  baseUrl: string,
  token: string,
  timeoutMs = 8000,
): Promise<Probe> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${gatewayRoot(baseUrl)}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = performance.now() - t0;
    if (!res.ok)
      return {
        gateway,
        ok: false,
        models: [],
        ms,
        error: `HTTP ${res.status}`,
      };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return { gateway, ok: true, models, ms, error: null };
  } catch (e) {
    return {
      gateway,
      ok: false,
      models: [],
      ms: performance.now() - t0,
      error: (e as Error).message,
    };
  }
}

export function writeLiveCatalog(
  path: string,
  data: Omit<LiveCatalog, "contract" | "generatedAt">,
): void {
  const canonical = Object.entries(CONTRACTS).find(
    ([, s]) => s.canonical,
  )![0] as ContractName;
  const payload = {
    contract: canonical,
    generatedAt: new Date().toISOString(),
    ...data,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

// ── hot reload (opencode PR #9849 pattern) ──────────────────────────────

export type CatalogWatcher = { stop: () => void };

export function watchCatalog(
  source: string,
  onChange: (load: CatalogLoad) => void,
  debounceMs = 500,
): CatalogWatcher {
  let lastGood: CatalogLoad | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = (_curr: Stats, _prev: Stats) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const next = loadLiveCatalog(source);
      if (next.status === "ok") {
        lastGood = next;
        onChange(next);
      } else {
        console.error(
          `catalog reload failed (${next.status}): ${"reason" in next ? next.reason : next.contract.saw}`,
        );
        if (lastGood) onChange(lastGood); // last-known-good, per symphony #33
      }
      timer = null;
    }, debounceMs);
  };
  // fs.watchFile (polling) survives IDE atomic saves that replace the inode;
  // fs.watch watches the old inode and stops detecting changes (backend.ai PR #5749).
  watchFile(source, { interval: 1000 }, handler);
  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      unwatchFile(source, handler);
    },
  };
}
