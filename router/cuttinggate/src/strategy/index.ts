/**
 * @flock/strategy — Flock strategy tier.
 *
 * Ported from estate-scripts-router's router_strategy.ts (v3.2). Sits above the
 * policy tier (../policy: Elo, circuits, health analytics) and below the
 * serving layer: it decides WHICH provider/model serves a request and
 * executes the call with fail-fast hedging.
 *
 * Every strategy takes StrategyDeps first (no global singleton);
 * bindStrategies(deps) returns the classic ROUTERS record of
 * (body, session) => Promise<RouteResult>.
 */
export type {
  ChatBody,
  ProviderView,
  RouteResult,
  RouteTimings,
  StrategyDeps,
  StrategyFn,
} from "./types.ts";

export {
  ATTEMPT_MS,
  ATTEMPT_STREAM_MS,
  AST_RE,
  CONNECT_MS,
  DEFAULT_STRATEGY,
  FIFO_MAX,
  HEDGE_MS,
  LOCAL_ROLES,
  MAX_PARALLEL,
  TTFT_MS,
  UA,
  buildCoding,
  firstModelFor,
  isAst,
  isExplicit,
  isLocalSwapModelId,
  keyOkFor,
  loadLocalRoleModels,
  log,
  matchModelOnProvider,
  modelFree,
  normalizeModelSpec,
  nvidiaKeys,
  providerView,
  providerViews,
  resolveKeyEnv,
  resolveModel,
} from "./catalog.ts";
export type { CatalogQuery, LocalRoles, NormalizedSpec } from "./catalog.ts";

export {
  Governor,
  ModelPermit,
  isWorkerExhausted,
} from "./governor.ts";
export type { GovernorModelState } from "./governor.ts";

export { NvidiaKeyPool, NVIDIA_RPM } from "./nvidia-keys.ts";

export {
  PolicyBackedDeps,
  PROVIDER_ORDER,
  createDeps,
} from "./deps.ts";
export type { DepsOptions } from "./deps.ts";

export {
  LONGCTX_PIN_DAILY_CAP,
  LONGCTX_PIN_GATE_TOKENS,
  LONGCTX_PIN_MODEL,
  LONGCTX_PIN_PROVIDER,
  LING_DEFAULT,
  bindStrategies,
  callOne,
  estPromptTokens,
  firstUsableModelFor,
  freeCandidates,
  hedgedChain,
  isRoutableModelId,
  longctxPinEligible,
  longctxPinEnabled,
  modelProbeBonus,
  pickWeighted,
  routeAstRace,
  routeCascade,
  routeCircuitChain,
  routeFifo,
  routeFree,
  routeHybrid,
  routeSticky,
  routeWeighted,
  substantive,
  tryLongctxPin,
} from "./strategy.ts";
export type { LongctxPinReason, LongctxPinVerdict } from "./strategy.ts";

export { uiData, FLOCK_UI_HTML } from "./ui-data.ts";
