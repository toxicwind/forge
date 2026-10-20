/**
 * Credential plane — the piece flock never had.
 *
 * flock loads ONE key per provider at boot and keeps it forever, so a dead
 * key produces a bare 502 with no diagnosis and no rotation. herd solved this
 * with a separate keypool service on :25109. cuttinggate folds it in, because
 * a router that knows a model is dead but cannot rotate a dead key is only
 * half a router.
 *
 * Ported from estate/config/keypools.yaml + estate/bin/herd-keypool.py.
 *
 *   401/402 -> the credential itself is wrong: long cooldown, it will not fix itself
 *   429    -> we are being rate limited: short cooldown, retrying is correct
 *   other  -> unknown failure: default cooldown
 */

import { readFileSync } from "node:fs";

export type KeySpec = {
  /** Environment variable holding the credential. */
  name: string;
  /** Only usable on free tiers — never spend it on a paid route. */
  freeOnly?: boolean;
};

export type HealthProbe = {
  method: "GET" | "POST";
  path: string;
  /** Statuses that mean the key works. */
  ok: number[];
};

export type KeyPool = {
  upstream: string;
  health: HealthProbe;
  failStatus: number[];
  probeTimeoutS: number;
  requestTimeoutS: number;
  /** Seconds to sit out, keyed by HTTP status. Missing status -> `defaultCooldownS`. */
  cooldown: Record<number, number>;
  defaultCooldownS: number;
  keys: KeySpec[];
  /** Body-rewriting protocol this provider needs, e.g. "gemini-interactions". */
  protocol?: string;
};

export type KeyState = {
  name: string;
  freeOnly: boolean;
  /** Epoch ms until which this key is not offered. 0 = usable. */
  coolingUntil: number;
  failures: number;
  successes: number;
  lastStatus: number | null;
  lastCheckedAt: number | null;
  /** Reason the key is unavailable, for /status. Never contains the key. */
  reason: string | null;
};

export class KeyPoolExhaustedError extends Error {
  constructor(
    readonly pool: string,
    readonly tried: string[],
    readonly statuses: number[],
  ) {
    super(
      `keypool '${pool}': no healthy key ` +
        `(tried ${tried.length ? tried.join(", ") : "none configured"}, ` +
        `statuses ${statuses.length ? statuses.join(",") : "none"})`,
    );
    this.name = "KeyPoolExhaustedError";
  }
}

export class CredentialPlane {
  private readonly pools = new Map<string, KeyPool>();
  private readonly state = new Map<string, Map<string, KeyState>>();

  constructor(pools: readonly KeyPool[]) {
    for (const pool of pools) {
      this.pools.set(pool.upstream, pool);
      const byKey = new Map<string, KeyState>();
      for (const key of pool.keys) {
        byKey.set(key.name, {
          name: key.name,
          freeOnly: key.freeOnly ?? false,
          coolingUntil: 0,
          failures: 0,
          successes: 0,
          lastStatus: null,
          lastCheckedAt: null,
          reason: null,
        });
      }
      this.state.set(pool.upstream, byKey);
    }
  }

  /** Keys present in the environment. A configured-but-absent key is not an error. */
  private available(pool: KeyPool, now: number): KeyState[] {
    const byKey = this.state.get(pool.upstream)!;
    return pool.keys
      .map((k) => byKey.get(k.name)!)
      .filter((s) => s.coolingUntil <= now && process.env[s.name]);
  }

  /** Healthy keys, healthiest first. "Healthiest" = fewest failures, then fewest uses. */
  usable(upstream: string, opts: { paid?: boolean } = {}): string[] {
    const pool = this.pools.get(upstream);
    if (!pool) return [];
    const now = Date.now();
    // A `freeOnly` key is worthless on a paid route; on a free route it is fine.
    return this.available(pool, now)
      .filter((s) => !(opts.paid && s.freeOnly))
      .sort((a, b) => a.failures - b.failures || a.successes - b.successes)
      .map((s) => s.name);
  }

  /** Record an outcome against one key. Unknown statuses use the default cooldown. */
  note(upstream: string, keyName: string, status: number | null, error?: string): void {
    const pool = this.pools.get(upstream);
    const byKey = this.state.get(upstream);
    if (!pool || !byKey) return;
    const state = byKey.get(keyName);
    if (!state) return;
    const now = Date.now();
    state.lastStatus = status;
    state.lastCheckedAt = now;
    if (status !== null && pool.health.ok.includes(status)) {
      state.successes += 1;
      state.failures = 0;
      state.coolingUntil = 0;
      state.reason = null;
      return;
    }
    state.failures += 1;
    const seconds = status === null
      ? pool.defaultCooldownS
      : (pool.cooldown[status] ?? pool.defaultCooldownS);
    state.coolingUntil = now + seconds * 1000;
    state.reason = error ?? (status === null ? "network/unknown" : `HTTP ${status}`);
  }

  /** True when a pool is configured for this upstream, even if currently exhausted. */
  hasPool(upstream: string): boolean {
    return this.pools.has(upstream);
  }

  /** Throw a diagnosable error instead of letting a bare 502 escape. */
  claim(upstream: string, opts: { paid?: boolean } = {}): string {
    const pool = this.pools.get(upstream);
    if (!pool) throw new KeyPoolExhaustedError(upstream, [], []);
    const keys = this.usable(upstream, opts);
    if (keys.length) return keys[0]!;
    const byKey = this.state.get(upstream)!;
    const tried = pool.keys.map((k) => k.name);
    const statuses = [...new Set([...byKey.values()].map((s) => s.lastStatus).filter((s): s is number => s !== null))];
    throw new KeyPoolExhaustedError(upstream, tried, statuses);
  }

  /** One GET/POST against the provider's health path. Returns true when the key works. */
  async probe(upstream: string, keyName: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const pool = this.pools.get(upstream);
    if (!pool) return false;
    const key = process.env[keyName];
    if (!key) return false;
    const url = `${pool.upstream.replace(/\/$/, "")}${pool.health.path}`;
    try {
      const res = await fetchImpl(url, {
        method: pool.health.method,
        headers: { Authorization: `Bearer ${key}`, "User-Agent": "cuttinggate" },
        signal: AbortSignal.timeout(pool.probeTimeoutS * 1000),
      });
      this.note(upstream, keyName, res.status);
      return pool.health.ok.includes(res.status);
    } catch (e) {
      this.note(upstream, keyName, null, (e as Error).message);
      return false;
    }
  }

  /**
   * Health per key for /status. Emits names, statuses and reasons only — a
   * credential value must never reach a log, a dashboard, or an HTTP response.
   */
  snapshot(): { upstream: string; protocol?: string; keys: (KeyState & { present: boolean; cooling: boolean })[] }[] {
    const now = Date.now();
    return [...this.pools.values()].map((pool) => ({
      upstream: pool.upstream,
      ...(pool.protocol ? { protocol: pool.protocol } : {}),
      keys: pool.keys.map((k) => {
        const s = this.state.get(pool.upstream)!.get(k.name)!;
        return { ...s, present: Boolean(process.env[s.name]), cooling: s.coolingUntil > now };
      }),
    }));
  }
}


/** Parse the estate keypools.yaml shape. Unconfigured cooldown falls back sanely. */
export type RawPool = Omit<Partial<KeyPool>, "cooldown" | "keys"> & {
  /** keypools.yaml puts the fallback cooldown inside this map as `default`. */
  cooldown?: Record<string, number>;
  keys?: (string | KeySpec)[];
};

export function parsePools(doc: { pools?: Record<string, RawPool> }): KeyPool[] {
  return Object.entries(doc.pools ?? {}).map(([name, raw]) => {
    const keys = (raw.keys ?? []).map((k) => (typeof k === "string" ? { name: k } : k));
    // keypools.yaml carries the fallback cooldown inside the cooldown map.
    const { default: fallback, ...perStatus } = raw.cooldown ?? {};
    const byStatus: Record<number, number> = {};
    for (const [k, v] of Object.entries(perStatus)) byStatus[Number(k)] = v;
    return {
      upstream: raw.upstream ?? name,
      health: raw.health ?? { method: "GET" as const, path: "/v1/models", ok: [200] },
      failStatus: raw.failStatus ?? [401, 402, 429],
      probeTimeoutS: raw.probeTimeoutS ?? 5,
      requestTimeoutS: raw.requestTimeoutS ?? 180,
      cooldown: byStatus,
      defaultCooldownS: raw.defaultCooldownS ?? fallback ?? 120,
      keys,
      ...(raw.protocol ? { protocol: raw.protocol } : {}),
    };
  });
}

/** Load estate/config/keypools.yaml. Bun 1.4 ships a YAML parser, so no dep. */
export function loadPoolsFromYaml(path: string): KeyPool[] {
  return parsePools(Bun.YAML.parse(readFileSync(path, "utf8")) as { pools?: Record<string, RawPool> });
}
