/**
 * router_live_models.ts — live model discovery scheduler.
 *
 * Thin scheduler around the master providers package: for every provider
 * with a configured key, run the package's adapter-aware discovery
 * (OpenAI / Google v1beta / Mistral / static / none shapes), feed the
 * result into the unified catalog (which owns serving membership,
 * quarantine, and persistence), and keep the router-side live metadata
 * (pricing, context length...) that /v1/models and modelFree consume.
 *
 * State:
 * - provider-catalog.json — package-owned (quarantine, miss streaks,
 *   everDiscovered). Loaded synchronously by router_config.ts at import.
 * - live-models.json — router-owned { fetchedAt, meta } (per-model live
 *   metadata for /v1/models + modelFree). On upgrade from the old shape,
 *   a legacy { models } map is folded into the catalog once via the
 *   package's v1 migration path so the warm cache survives.
 *
 * Refresh runs at startup (non-blocking) and every 30 min.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  catalog,
  persistCatalog,
  LIVE_MODEL_META,
  keyOk,
  log,
} from "./router_config.ts";
import { discover } from "../../../../../../packages/providers/src/index.ts";
import { applySigmaBackfill, sigmaCatalogInfo } from "./sigma-enrich.ts";

const META_STATE_PATH = "/home/toxic/estate/.state/live-models.json";
// No timer: refresh is event-driven (startup, admin, SIGHUP, request-triggered).
// See startLiveDiscovery below.

export const LIVE_STATUS: Record<
  string,
  { ok: boolean; count: number; fetchedAt: string; error?: string }
> = {};

// ---------------------------------------------------------------------------
// Persistence (router-owned live metadata; catalog state is package-owned)
// ---------------------------------------------------------------------------
function persistMeta(): void {
  try {
    mkdirSync(dirname(META_STATE_PATH), { recursive: true });
    writeFileSync(
      META_STATE_PATH,
      JSON.stringify(
        { fetchedAt: new Date().toISOString(), meta: LIVE_MODEL_META },
        null,
        1,
      ),
    );
  } catch (e) {
    log("live-models persist failed:", e);
  }
}

function loadPersistedMeta(): void {
  try {
    if (!existsSync(META_STATE_PATH)) return;
    const j = JSON.parse(readFileSync(META_STATE_PATH, "utf8"));
    if (j && typeof j.meta === "object") {
      for (const [p, meta] of Object.entries(j.meta)) {
        if (meta && typeof meta === "object")
          LIVE_MODEL_META[p] = meta as Record<string, unknown>;
      }
    }
    // Upgrade path: fold a legacy { models } map into the catalog once so
    // the warm cache survives the migration. The package's v1 migration
    // marks them everDiscovered and filters the dead list; the next
    // refresh reconciles everything via the normal miss-streak rules.
    if (j && typeof j.models === "object") {
      catalog.loadJSON({ live: j.models });
      log("live-models migrated legacy models map into the catalog");
    }
  } catch (e) {
    log("live-models load failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
type RawModel = Record<string, unknown>;

// Drop the long prose description — it bloats the persisted state and the
// /v1/models payload without helping routing. Everything else (pricing,
// context_length, architecture, limits...) is live metadata worth keeping.
function slimMeta(raw: object): Record<string, unknown> {
  const rest: RawModel = { ...raw };
  delete rest.description;
  return rest;
}

/** In-flight refresh promise for singleflight: concurrent triggers share one run. */
let refreshInFlight: Promise<void> | null = null;

export async function refreshLiveModels(): Promise<void> {
  // Singleflight: if a refresh is already running, wait for it instead of
  // starting a duplicate discovery sweep.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshLiveModelsInner().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshLiveModelsInner(): Promise<void> {
  for (const p of catalog.providerNames()) {
    if (!keyOk(p)) {
      LIVE_STATUS[p] = {
        ok: false,
        count: catalog.servingModels(p).length,
        fetchedAt: new Date().toISOString(),
        error: "no_key",
      };
      continue;
    }
    try {
      const def = catalog.getDef(p)!;
      const result = await discover(def, { timeoutMs: 15000 });
      catalog.applyDiscovery(p, result);
      const meta: Record<string, Record<string, unknown>> = {};
      if (result.ok) {
        for (const [id, raw] of Object.entries(result.meta)) {
          if (raw && typeof raw === "object") meta[id] = slimMeta(raw);
        }
      }
      LIVE_MODEL_META[p] = meta;
      LIVE_STATUS[p] = {
        ok: result.ok,
        count: result.ok ? result.ids.length : 0,
        fetchedAt: new Date().toISOString(),
        ...(result.ok ? {} : { error: (result.error ?? "unknown").slice(0, 120) }),
      };
      log(
        `live-models ${p}: ${result.ok ? `${(result.ids ?? []).length} models` : `failed (${result.error})`}`,
      );
    } catch (e) {
      LIVE_STATUS[p] = {
        ok: false,
        count: catalog.servingModels(p).length,
        fetchedAt: new Date().toISOString(),
        error: String(e).slice(0, 120),
      };
      log(`live-models ${p} failed:`, String(e).slice(0, 120));
    }
  }
  const sigmaN = applySigmaBackfill(LIVE_MODEL_META);
  if (sigmaN > 0) log(`live-models sigma backfill enriched ${sigmaN} models`);
  persistCatalog();
  persistMeta();
}

export function startLiveDiscovery(): void {
  loadPersistedMeta();
  const info = sigmaCatalogInfo();
  const n = applySigmaBackfill(LIVE_MODEL_META);
  log(`live-models sigma catalog ${info.snapshot} (${info.rows} rows): backfilled ${n} models`);
  // non-blocking: serve from seeds + persisted catalog state immediately
  refreshLiveModels().catch((e) => log("live-models initial refresh failed:", e));
  // Event-driven refresh triggers (no timers):
  // - SIGHUP: explicit operator signal to re-discover.
  // - /admin/reload (router.ts): already calls refreshLiveModels().
  // - Request-triggered: call refreshLiveModels() when a request observes
  //   stale data (singleflight dedupes concurrent triggers).
  process.on("SIGHUP", () => {
    log("live-models SIGHUP refresh triggered");
    refreshLiveModels().catch((e) => log("live-models SIGHUP refresh failed:", e));
  });
}
