/**
 * flock/ts/strategy/deps — StrategyDeps backed by the policy tier.
 *
 * This is the composition root that replaces estate-scripts-router's global
 * `state` singleton (the RouterState/Matrix trio). PolicyBackedDeps wires
 * EloEngine + CircuitPolicy + PolicyHealthDB (../policy) together with a
 * Roost-backed ModelCatalog and the Governor, and exposes them through
 * the StrategyDeps interface the strategies consume.
 *
 * Matrix.record semantics are preserved in record(): health row + Elo
 * (+16 success / −8 rate-limit / −32 other-fail, floor 100) + circuit
 * transition (404 benches entitlement, 401/402 count, ≥3 consecutive
 * failures open the circuit with exponential backoff, healing events).
 * The policy tier's CircuitPolicy.recordOutcome already implements the
 * circuit half; record() routes the outcome to every sink.
 */
import { EloEngine } from "../../../../../flock/ts/policy/elo.ts";
import { CircuitPolicy } from "../../../../../flock/ts/policy/circuit.ts";
import { PolicyHealthDB } from "../../../../../flock/ts/policy/health.ts";
import { DEAD_MODEL_IDS, ModelCatalog, MODEL_ALIASES, PROVIDER_DEFS } from "../../../../../../packages/providers/src/index.ts";
import { Governor, isWorkerExhausted } from "./governor.ts";
import { NvidiaKeyPool } from "./nvidia-keys.ts";
import {
  ATTEMPT_MS,
  ATTEMPT_STREAM_MS,
  CONNECT_MS,
  FIFO_MAX,
  LOCAL_ROLES,
  buildCoding,
  isExplicit,
  isLocalSwapModelId,
  keyOkFor,
  log,
  matchModelOnProvider,
  modelFree,
  normalizeModelSpec,
  providerView,
  resolveKeyEnv,
  resolveModel,
} from "./catalog.ts";
import type { CatalogQuery, LocalRoles } from "./catalog.ts";
import type { ProviderView, StrategyDeps } from "./types.ts";

/** Default provider ordering — the router's canonical candidate list. */
export const PROVIDER_ORDER = [
  "herd",
  "nvidia",
  "openrouter",
  "groq",
  "pollinations",
  "kimi",
  "deepseek",
  "gemini",
  "venice",
  "openai",
];

export interface DepsOptions {
  dbPath?: string;
  governorPath?: string | null;
  strategyName?: string;
  fifoMax?: number;
}

export class PolicyBackedDeps implements StrategyDeps {
  elo: EloEngine;
  circuit: CircuitPolicy;
  health: PolicyHealthDB;
  catalog: ModelCatalog;
  governor: Governor;
  nvidiaPool = new NvidiaKeyPool();
  roles: LocalRoles;
  coding: Record<string, [string, string] | null>;
  fifoDepth = 0;
  strategyName: string;
  fifoMax: number;
  /** EOL-tier ids (mirrors what the catalog was seeded with). */
  readonly deadIdSet = new Set<string>(DEAD_MODEL_IDS);

  constructor(opts: DepsOptions = {}) {
    this.elo = new EloEngine();
    this.circuit = new CircuitPolicy();
    this.health = new PolicyHealthDB(
      opts.dbPath ?? "/home/toxic/estate/.state/health.db",
    );
    this.catalog = new ModelCatalog(PROVIDER_DEFS, {
      aliases: MODEL_ALIASES,
      deadIds: DEAD_MODEL_IDS,
    });
    this.governor = new Governor(opts.governorPath ?? null);
    this.roles = { ...LOCAL_ROLES };
    this.coding = buildCoding(this.roles, MODEL_ALIASES);
    this.strategyName = opts.strategyName ?? process.env.ESTATE_STRATEGY ?? "hybrid";
    this.fifoMax = opts.fifoMax ?? FIFO_MAX;
    for (const p of PROVIDER_ORDER) this.circuit.register(p);
  }

  // -- StrategyDeps ------------------------------------------------------
  log(...args: unknown[]) {
    log(...args);
  }

  providers(): ProviderView[] {
    const seen = new Set<string>();
    const out: ProviderView[] = [];
    for (const p of PROVIDER_ORDER) {
      const def = this.catalog.getDef(p);
      if (def && !seen.has(p)) {
        seen.add(p);
        out.push(providerView(def));
      }
    }
    return out;
  }

  servingModels(provider: string): string[] {
    return this.catalog.servingModels(provider);
  }

  liveMeta(provider: string): Record<string, Record<string, unknown>> {
    // Roost discovery records serving sets, not per-model pricing metadata
    // yet; modelFree() falls back to the deterministic ":free" suffix
    // convention. Extension point: when discovery records pricing, wire it
    // here keyed by model id.
    return {};
  }

  keyOk(provider: string): boolean {
    const def = this.catalog.getDef(provider);
    if (!def) return false;
    if (def.auth === "none") return true;
    return keyOkFor(providerView(def));
  }

  resolveKey(provider: string): string {
    const def = this.catalog.getDef(provider);
    if (!def) return "";
    const v = providerView(def);
    if (provider === "nvidia") return this.nvidiaPool.next() ?? "";
    return resolveKeyEnv(v) ?? "";
  }

  circuitOk(provider: string): boolean {
    return this.circuit.circuitOk(provider);
  }

  laneDead(provider: string): boolean {
    return this.circuit.laneDead(provider);
  }

  consecutiveFailures(provider: string): number {
    return this.circuit.consecutiveFailures(provider);
  }

  candidateScore(provider: string): number {
    return this.elo.candidateScore(provider);
  }

  isEntitlementDead(provider: string, model: string): boolean {
    return this.circuit.isEntitlementDead(provider, model);
  }

  flapBanned(provider: string, model: string): boolean {
    return this.circuit.flapBanned(provider, model);
  }

  recordEmpty(provider: string, model: string): void {
    this.circuit.recordEmpty(provider, model);
  }

  record(
    model: string,
    provider: string,
    status: number,
    latSec: number,
    winner = 0,
    strategy = "",
    session = "",
    estTokens = 0,
  ): void {
    const latMs = latSec * 1000;
    this.health.recordRequest(
      provider, model, status, latMs, strategy, winner, session, estTokens,
    );
    // Elo delta mirrors Matrix.recordOutcome: +16 / −8 (429) / −32, floor 100.
    this.elo.recordOutcome(provider, status, latMs);
    // Circuit transition: 404 benches entitlement, 401/402 count, ≥3
    // consecutive failures open with exponential backoff; healing events.
    this.circuit.recordOutcome(provider, model, status);
  }

  noteError(provider: string, status: number, err: string): void {
    this.circuit.noteError(provider, status, err);
  }

  noteWorkerExhausted(provider: string, model: string): void {
    this.governor.noteExhausted(`${provider}/${model}`);
  }

  stickyGet(session: string): [string | null, string | null] {
    return this.health.stickyGet(session);
  }

  stickySet(session: string, provider: string, model: string): void {
    this.health.stickySet(session, provider, model);
  }

  /** Pinned-path credit guard: attempts logged today (UTC) under `strategy`. */
  countStrategyToday(strategy: string): number {
    const row = this.health.conn
      .query(
        `SELECT COUNT(*) AS n FROM requests
         WHERE strategy=? AND ts >= strftime('%s','now','start of day')`,
      )
      .get(strategy) as { n: number } | null;
    return row?.n || 0;
  }

  governorAdmit(key: string) {
    const permit = this.governor.admit(key);
    return permit ? { release: () => permit.release() } : null;
  }

  // -- catalog query helpers the strategies share -------------------------
  catalogQuery(): CatalogQuery {
    const self = this;
    return {
      providerNames: () => PROVIDER_ORDER.filter((p) => self.keyOk(p)),
      servingModels: (p) => self.servingModels(p),
      isQuarantined: (p, m) => self.circuit.isEntitlementDead(p, m),
      deadIds: () => self.deadIdSet,
      keyOk: (p) => self.keyOk(p),
    };
  }

  firstUsableModelFor(p: string): string {
    const q = this.catalogQuery();
    for (const m of q.servingModels(p)) {
      if (!q.isQuarantined(p, m) && !q.deadIds().has(m)) return m;
    }
    return "";
  }

  /** (provider, model) resolution for a raw model spec. */
  resolveSpec(spec: string): [string, string] {
    return resolveModel(spec, this.catalogQuery(), this.coding, this.roles);
  }

  /**
   * Any model id the router can directly address: explicit alias, local id,
   * provider:model / provider/model spec, or any catalog id on any keyed
   * provider. Unknown ids keep the race-everything behavior.
   */
  isRoutableModelId(model: string): boolean {
    if (!model) return false;
    const q = this.catalogQuery();
    if (isExplicit(model, this.coding, this.roles)) return true;
    // openfang shim: "provider:model" / "provider/model" specs are directly
    // routable — normalizeModelSpec pins the provider.
    if (normalizeModelSpec(model, q, this.coding).provider) return true;
    for (const p of q.providerNames()) {
      if (q.servingModels(p).includes(model)) return true;
    }
    return false;
  }

  /**
   * Dead-lane exclusion + entitlement/flap filtering, Elo-ranked.
   * Mirrors router_strategy's healthyProviderScore list in each strategy.
   */
  rankedProviders(filter?: (p: string) => boolean): string[] {
    const out = this.providers()
      .map((v) => v.name)
      .filter((p) => this.keyOk(p) && this.circuitOk(p) && !this.laneDead(p))
      .filter((p) => (filter ? filter(p) : true));
    out.sort((a, b) => this.candidateScore(b) - this.candidateScore(a));
    return out;
  }

  /** True when the response body is a non-substantive completion. */
  isSubstantive(body: string): boolean {
    if (!body) return false;
    const t = body.trim();
    if (t.length < 20) return false;
    return true;
  }
}

/** Create a production deps instance (strategy name from ESTATE_STRATEGY). */
export function createDeps(opts: DepsOptions = {}): PolicyBackedDeps {
  return new PolicyBackedDeps(opts);
}

// Re-export bits the strategy module consumes as pure helpers.
export {
  ATTEMPT_MS,
  ATTEMPT_STREAM_MS,
  CONNECT_MS,
  FIFO_MAX,
  isWorkerExhausted,
  modelFree,
  matchModelOnProvider,
  isExplicit,
  isLocalSwapModelId,
};
export type { CatalogQuery, ProviderView };
