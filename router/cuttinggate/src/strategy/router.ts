#!/usr/bin/env bun
// ⚠️  DEPRECATED 2026-10-04 — superseded by Rust flock on :25193.
// Kept for reference; do not deploy. See flock-ssot/ROUTER_CANON.md.
/**
 * Estate Router v3.2 (Bun/TypeScript)
 * Port of estate-scripts-router/router.py — same strategies, HealthDB WAL, circuit breakers.
 *
 * Strategies: fifo_matrix (alias fifo_flock) | ast_race (alias flock_race) | sticky_affinity | weighted_elo | circuit_chain | hybrid
 * Default hybrid: sticky → ast_race → circuit_chain; explicit CODING aliases go direct.
 *
 * Env SSOT: estate/config/ports.env (mise _.file) + ~/.secrets
 *   ESTATE_ROUTER_PORT / ESTATE_PORT — never invent non-25xxx ports
 */

import { createHash } from "node:crypto";
import { watch, readFileSync, existsSync } from "node:fs";
import { handleMeshRequest } from "../../../../../../src/lib/ghas-mesh-features.ts";
import type { ChatBody } from "./router_types.ts";
import { CODING, PROVIDERS, keyOk, getKey, STRATEGY, MAX_PARALLEL, PORT, json, log, DB_PATH, isExplicit, normalizeModelSpec, resolveModel, loadEnvFile, catalog, catalogModelsFor } from "./router_config.ts";
import { LIVE_MODEL_META, modelFree } from "./router_config.ts";
import { startLiveDiscovery, refreshLiveModels, LIVE_STATUS } from "./router_live_models.ts";
import { state, startQuarantineProber } from "./router_matrix.ts";
import { ROUTERS, routeHybrid, callOne, pickWeighted, isRoutableModelId, tryLongctxPin, tryLongctx2MPin, buildBodybuilderRequests, runBodybuilderAutonomous, substantive } from "./router_strategy.ts";
import { uiData, ROUTER_UI_HTML } from "./router_ui.ts";
import {
  loadAuthFromEnv,
  identifyRequest,
  handleLogin,
  handleLogout,
} from "./router_auth.ts";

// ---------------------------------------------------------------------------
// Optional client auth (absorbed from the retired :8000 key-proxy).
// Set ESTATE_CLIENT_KEYS=comman,separated,keys to require a client key.
// Unset = open (daemon binds 127.0.0.1; localhost is the trust boundary).
// ---------------------------------------------------------------------------
const CLIENT_KEYS = (process.env.ESTATE_CLIENT_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function clientAuthorized(req: Request): boolean {
  if (!CLIENT_KEYS.length) return true;
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const key = bearer || req.headers.get("x-api-key") || "";
  return key !== "" && CLIENT_KEYS.includes(key);
}

// ---------------------------------------------------------------------------
// Optional operator auth (flock auth.rs role/session semantics port).
// Active only when users are configured via ESTATE_AUTH_USERS_FILE or
// ESTATE_AUTH_USERS. /v1/* keeps the client-key gate above untouched;
// /health stays open. Operator surface (/ui, /metrics, /debug/*) then
// requires a signed session cookie, Bearer user:pass, or HTTP Basic auth.
// ---------------------------------------------------------------------------
const AUTH = loadAuthFromEnv();
if (AUTH) {
  log(
    `operator auth on: ${AUTH.store.userCount()} user(s), trustProxy=${AUTH.admin.trustProxy}`,
  );
} else {
  log("operator auth off: no users configured (ESTATE_AUTH_USERS_FILE)");
}

function isOperatorPath(path: string): boolean {
  return (
    path === "/ui" ||
    path === "/ui/" ||
    path === "/ui/data" ||
    path === "/metrics" ||
    path.startsWith("/debug/")
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function sessionId(req: Request, body: ChatBody): string {
  const h = req.headers.get("X-Session-Id");
  if (h) return h;
  const seed = JSON.stringify((body.messages || []).slice(0, 1));
  return createHash("md5").update(seed).digest("hex").slice(0, 12);
}

async function handleStream(
  body: ChatBody,
  sid: string,
  _strat: string,
): Promise<Response> {
  // 2M-context tier (2026-10-01): >1M est tokens -> direct keyed
  // openrouter lane (x-ai/grok-4.20, 2M context), skipping the race.
  // Ineligible or pinned failure falls through to the 1M pin below.
  const pinned2mStream = await tryLongctx2MPin(body, sid, true);
  if (pinned2mStream?.ok && pinned2mStream.stream) {
    const pst2 = pinned2mStream.timings;
    return new Response(pinned2mStream.stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Routed-Via": `${pinned2mStream.provider}/${pinned2mStream.model}`,
        "X-Longctx-Pin": "2m",
        ...(pst2
          ? {
              "X-Estate-Timings": `connect_ms=${pst2.connect_ms};ttft_ms=${pst2.ttft_ms ?? "-"};total_ms=${pst2.total_ms}`,
            }
          : {}),
      },
    });
  }

  // 1M-context pin (DECISION 12187): >200k est tokens -> direct keyed
  // nvidia lane, skipping the race. Ineligible or pinned failure falls
  // through to the normal stream logic below (single race fallback).
  const pinnedStream = await tryLongctxPin(body, sid, true);
  if (pinnedStream?.ok && pinnedStream.stream) {
    const pst = pinnedStream.timings;
    return new Response(pinnedStream.stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Routed-Via": `${pinnedStream.provider}/${pinnedStream.model}`,
        "X-Longctx-Pin": "1",
        ...(pst
          ? {
              "X-Estate-Timings": `connect_ms=${pst.connect_ms};ttft_ms=${pst.ttft_ms ?? "-"};total_ms=${pst.total_ms}`,
            }
          : {}),
      },
    });
  }

  const model = String(body.model || "auto");
  const tryStream = async (p: string, mid: string) => {
    const r = await callOne(p, mid, body, true);
    if (!r.ok || !r.stream) return null;
    state.stickySet(sid, p, mid);
    const st = r.timings;
    return new Response(r.stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Routed-Via": `${p}/${mid}`,
        ...(st
          ? {
              "X-Estate-Timings": `connect_ms=${st.connect_ms};ttft_ms=${st.ttft_ms ?? "-"};total_ms=${st.total_ms}`,
            }
          : {}),
      },
    });
  };

  // Explicit model: resolved lane first, then fail over to the weighted
  // field (mirrors routeHybrid). resolveModel covers CODING aliases,
  // provider:model slash/colon specs, and local model ids.
  const routed = isRoutableModelId(model) ? resolveModel(model) : null;
  if (routed) {
    const resp = await tryStream(routed[0], routed[1]);
    if (resp) return resp;
  } else {
    const [sp, sm] = state.stickyGet(sid);
    if (sp && keyOk(sp) && state.circuitOk(sp) && !state.laneDead(sp)) {
      const resp = await tryStream(sp, sm || model);
      if (resp) return resp;
    }
  }

  const cands: [string, string][] = routed
    ? [routed, ...pickWeighted(MAX_PARALLEL).filter(([cp]) => cp !== routed[0])]
    : pickWeighted(MAX_PARALLEL);
  for (const [p, mid] of cands) {
    const resp = await tryStream(p, mid);
    if (resp) return resp;
  }
  return json({ error: "all_stream_providers_exhausted" }, 503);
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/mesh")) {
      const m = await handleMeshRequest(req, {
        service: "estate-scripts-router",
        version: "v3.2",
      });
      if (m) return m;
    }

    // Client-key gate (only when ESTATE_CLIENT_KEYS is set). /health stays
    // open for liveness probes; everything else requires a key.
    if (path !== "/health" && !clientAuthorized(req)) {
      return json({ error: "unauthorized" }, 401);
    }

    // Auth endpoints (only reachable when users are configured).
    if (AUTH && req.method === "POST" && path === "/auth/login") {
      return handleLogin(req, AUTH.admin, AUTH.store);
    }
    if (AUTH && req.method === "POST" && path === "/auth/logout") {
      return handleLogout(AUTH.admin, req);
    }

    // Operator-surface gate (flock auth.rs port). /v1/* keeps the client-key
    // gate above untouched; /health stays open.
    if (AUTH && isOperatorPath(path)) {
      const id = await identifyRequest(req, AUTH.admin, AUTH.store);
      if (!id) {
        return json({ error: "unauthorized" }, 401, {
          "WWW-Authenticate": "Bearer",
        });
      }
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      // Union of every model every configured key can serve (unified catalog:
      // seeds pre-discovery, live discovery after), plus the CODING aliases.
      // Each entry carries the provider's live metadata (pricing,
      // context_length, architecture...) plus the router's own routing
      // metadata under "x-estate". The free flag is the same live-derived
      // eligibility routing consumes (modelFree), not a static suffix guess.
      // x-estate.source is the catalog's model source:
      // seed | live | static | overlay.
      const seen = new Set<string>();
      const data: Record<string, unknown>[] = [];
      const sovMeta = (p: string, id: string, source: string) => ({
        provider: p,
        source,
        free: modelFree(p, id),
        elo: Math.round((state.elo.get(p) || 1000) * 10) / 10,
        circuit: state.circuit.get(p) || "unknown",
        empty_strikes: state.emptyStrikeCount(p, id),
      });
      const push = (p: string, id: string, source: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const meta = (LIVE_MODEL_META[p] || {})[id] || {};
        data.push({
          id,
          object: "model",
          owned_by: p,
          ...(meta as Record<string, unknown>),
          "x-estate": sovMeta(p, id, source),
        });
      };
      for (const p of Object.keys(PROVIDERS)) {
        if (!keyOk(p)) continue;
        for (const m of catalogModelsFor(p)) {
          push(p, m, catalog.modelSource(p, m));
        }
      }
      for (const id of Object.keys(CODING)) {
        if (seen.has(id)) continue;
        seen.add(id);
        data.push({
          id,
          object: "model",
          owned_by: "alias",
          "x-estate": {
            provider: "alias",
            source: "alias",
            free: id === "free",
            elo: null,
            circuit: null,
            empty_strikes: 0,
          },
        });
      }
      return json({ object: "list", data, live: LIVE_STATUS });
    }

    if (req.method === "GET" && path === "/status") {
      // v3.2: live per-provider state — the resilience dashboard.
      const dbSummary = state.health.getProviderSummary();
      const pct = state.health.getLatencyPercentiles();
      const providers: Record<string, unknown> = {};
      for (const [p, conf] of Object.entries(PROVIDERS)) {
        providers[p] = {
          keys: keyOk(p) ? "configured" : "no_key",
          base_url: conf.base,
          circuit: state.circuitInfo(p),
          lane_dead: state.laneDead(p),
          elo: Math.round((state.elo.get(p) || 1000) * 10) / 10,
          models: catalogModelsFor(p).length,
          live_models: catalog.liveIds(p).length,
          live_status: LIVE_STATUS[p] || null,
          health: dbSummary[p] || null,
          latency_ms: pct[p] || { p50_ms: null, p95_ms: null, n: 0 },
          ...(p === "kimi-auto" ? { resolved: kimiResolved } : {}),
        };
      }
      return json({
        status: "ok",
        router: "estate-scripts-router-ts",
        version: "v3.2",
strategy: STRATEGY,
strategy_detail: STRATEGY === "auto" ? "auto: ast_race (code-shaped) -> free race (default) -> hybrid (fallback); per-request X-Strategy/X-Routed-Via headers show the chosen lane" : STRATEGY,
        uptime_s: Math.round(process.uptime()),
        started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        providers,
      });
    }

    if (req.method === "GET" && path === "/metrics") {
      // Prometheus exposition (absorbed from the retired :8000 key-proxy).
      const dbSummary = state.health.getProviderSummary() as Record<
        string,
        {
          successes?: number;
          failures?: number;
          success_rate?: number;
          avg_latency_ms?: number;
          rate_limited?: number;
        }
      >;
      const L: string[] = [];
      const circuitNum = (p: string) => {
        const s = state.circuit.get(p) || "closed";
        return s === "open" ? 1 : s === "half" ? 2 : 0;
      };
      for (const p of Object.keys(PROVIDERS)) {
        const s = dbSummary[p] || {};
        const req_total = (s.successes || 0) + (s.failures || 0);
        L.push(
          `estate_router_requests_total{provider="${p}"} ${req_total}`,
          `estate_router_success_rate{provider="${p}"} ${s.success_rate ?? 0}`,
          `estate_router_avg_latency_ms{provider="${p}"} ${s.avg_latency_ms ?? 0}`,
          `estate_router_rate_limited_total{provider="${p}"} ${s.rate_limited ?? 0}`,
          `estate_router_circuit_open{provider="${p}"} ${circuitNum(p)}`,
          `estate_router_elo{provider="${p}"} ${Math.round((state.elo.get(p) || 1000) * 10) / 10}`,
          `estate_router_live_models{provider="${p}"} ${catalog.liveIds(p).length}`,
        );
      }
      for (const [k, v] of state.emptyStrikes) {
        const [p, ...rest] = k.split("/");
        L.push(
          `estate_router_model_empty_strikes{provider="${p}",model="${rest.join("/").replace(/"/g, "")}"} ${v.n}`,
        );
      }
      // Model-pressure governor (flock governor.rs AIMD port). Only models
      // that have engaged the governor appear — bounded label cardinality.
      for (const [k, s] of state.governor.entries()) {
        if (s.limit <= 0 && s.exhaustedTotal <= 0) continue;
        const [p, ...rest] = k.split("/");
        const m = rest.join("/").replace(/"/g, "");
        L.push(
          `estate_governor_model_limit{provider="${p}",model="${m}"} ${s.limit}`,
          `estate_governor_model_inflight{provider="${p}",model="${m}"} ${s.inflight}`,
          `estate_governor_worker_exhausted_total{provider="${p}",model="${m}"} ${s.exhaustedTotal}`,
        );
      }
      return new Response(
        "# HELP estate_router_requests_total Total chat completion requests per provider\n" +
          "# TYPE estate_router_requests_total counter\n" +
          L.join("\n") +
          "\n",
        { headers: { "Content-Type": "text/plain; version=0.0.4" } },
      );
    }

    if (req.method === "GET" && (path === "/ui" || path === "/ui/")) {
      return new Response(ROUTER_UI_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "GET" && path === "/ui/data") {
      return json(uiData());
    }

    if (req.method === "GET" && path === "/health") {
      const dbSummary = state.health.getProviderSummary();
      const providers: Record<string, unknown> = {};
      for (const p of Object.keys(PROVIDERS)) {
        providers[p] = {
          keys: keyOk(p) ? "configured" : "no_key",
          elo: Math.round((state.elo.get(p) || 1000) * 10) / 10,
          circuit: state.circuit.get(p) || "unknown",
          models: catalogModelsFor(p).length,
          live_models: catalog.liveIds(p).length,
          live_status: LIVE_STATUS[p] || null,
          health: dbSummary[p] || null,
        };
      }
      return json({
        status: "ok",
        router: "estate-scripts-router-ts",
        version: "v3.2",
        strategy: STRATEGY,
        parallel: MAX_PARALLEL,
        providers,
      });
    }

    if (req.method === "POST" && path === "/admin/reload") {
      if (AUTH) {
        const id = await identifyRequest(req, AUTH.admin, AUTH.store);
        if (!id) return json({ error: "unauthorized" }, 401);
      }
      return json({ status: "ok", reloaded: hotReload("http") });
    }

    // 404 event intake for non-TS consumers (Go herd). The catalog is the
    // brain: a serve-time 404 quarantines the id immediately in the unified
    // catalog and the live export is rewritten, so herd picks it up from the
    // file. Herd reports the event; the quarantine decision lives here, once.
    if (req.method === "POST" && path === "/admin/catalog/serve-404") {
      if (AUTH) {
        const id = await identifyRequest(req, AUTH.admin, AUTH.store);
        if (!id) return json({ error: "unauthorized" }, 401);
      }
      let body: { provider?: string; model?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const provider = String(body.provider ?? "").trim();
      const model = String(body.model ?? "").trim();
      if (!provider || !model) return json({ error: "provider and model required" }, 400);
      state.noteEntitlement404(provider, model);
      return json({ status: "ok", provider, model, quarantined: true });
    }

    // openfang `agent set` parsing shim (router-side; the fork itself is
    // track-4 domain). Normalizes any spec the buggy CLI can produce —
    // "nvidia:gpt-oss-20b", "provider/model", bare ids, aliases — into the
    // canonical (provider, model, base_url) triple the daemon should use.
    if (req.method === "GET" && (path === "/v1/custom/openfang-resolve" || path === "/openfang/resolve")) {
      const spec = url.searchParams.get("spec") || "";
      const norm = normalizeModelSpec(spec);
      const [p, mid] = resolveModel(spec);
      const conf = PROVIDERS[p];
      return json({
        spec,
        provider: p,
        model: mid,
        provider_base_url: conf?.base || null,
        router_chat_url: `http://127.0.0.1:${PORT}/v1/chat/completions`,
        router_status_url: `http://127.0.0.1:${PORT}/status`,
        normalized_from: norm.provider ? `${norm.provider}:${norm.model}` : norm.model,
        note:
          "Point the daemon at the router (OpenAI-compatible): set the " +
          "agent provider base_url to router_chat_url, or use provider " +
          "provider_base_url with model as returned. The router itself " +
          "accepts the raw spec — the mangled 'provider:model' form is " +
          "normalized here, not in the fork.",
      });
    }

    if (req.method === "GET" && path === "/debug/sqlite") {
      try {
        return json(state.health.debugAgg());
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (req.method === "GET" && path === "/debug/health") {
      try {
        const healing: Record<string, unknown> = {};
        for (const p of Object.keys(PROVIDERS)) {
          healing[p] = state.health.recentHealing(p);
        }
        return json({
          summary: state.health.getProviderSummary(),
          healing,
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Estate-owned openrouter/bodybuilder equivalent: natural-language
    // multi-model job -> structured {requests:[...]} fan-out bodies for the
    // caller to execute in parallel. Generation is free (free-race lane);
    // execution stays with the caller.
    if (req.method === "POST" && path === "/v1/bodybuilder") {
      let b: Record<string, unknown>;
      try {
        b = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const job = String(b.job || "");
      if (!job) return json({ error: "missing job" }, 400);
      const bbOpts = {
        maxRequests:
          typeof b.max_requests === "number" ? b.max_requests : undefined,
        sid: sessionId(req, b as never),
      };
      // Autonomous by default (Chris 2026-10-01): the caller sends the prompt
      // and gets answers. execute:false restores bodies-only for callers that
      // run the fan-out themselves.
      if (b.execute === false)
        return json(await buildBodybuilderRequests(job, bbOpts));
      return json(await runBodybuilderAutonomous(job, bbOpts));
    }

    if (req.method === "POST" && path.includes("/chat/completions")) {
      let body: ChatBody;
      try {
        body = (await req.json()) as ChatBody;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const sid = sessionId(req, body);
      const strat = req.headers.get("X-Estate-Strategy") || STRATEGY;
      // openfang shim: canonicalize "provider:model" / "provider/model"
      // mangled specs before routing.
      const rawModel = String(body.model || "auto");
      const norm = normalizeModelSpec(rawModel);
      if (norm.provider) {
        const canon = `${norm.provider}:${norm.model}`;
        if (canon !== rawModel) {
          log(`model spec normalized: ${rawModel} -> ${canon}`);
          body = { ...body, model: canon };
        }
      }
      log(`${req.method} ${path} model=${body.model} strat=${strat}`);

      if (body.stream) {
        return handleStream(body, sid, strat);
      }

      // 2M-context tier (2026-10-01): est tokens >1M -> direct keyed
      // openrouter lane (x-ai/grok-4.20, 2M context), skipping the race.
      // Ineligible or pinned failure falls through to the 1M pin, then the
      // normal strategy dispatch.
      const pinned2m = await tryLongctx2MPin(body, sid, false);
      if (pinned2m && substantive(pinned2m)) {
        const t2 = pinned2m.timings;
        return new Response(pinned2m.data, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-Via": `${pinned2m.provider}/${pinned2m.model}`,
            "X-Latency": String(Math.round((pinned2m.lat || 0) * 1000) / 1000),
            "X-Strategy": strat,
            "X-Longctx-Pin": "2m",
            ...(t2
              ? {
                  "X-Estate-Timings": `connect_ms=${t2.connect_ms};ttft_ms=${t2.ttft_ms ?? "-"};total_ms=${t2.total_ms}`,
                }
              : {}),
          },
        });
      }

      // 1M-context pin (DECISION 12187): est tokens >200k -> direct keyed
      // nvidia lane, skipping the race. Ineligible or pinned failure falls
      // through to the normal strategy dispatch (single race fallback).
      const pinned = await tryLongctxPin(body, sid, false);
      if (pinned && substantive(pinned)) {
        const t = pinned.timings;
        return new Response(pinned.data, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-Via": `${pinned.provider}/${pinned.model}`,
            "X-Latency": String(Math.round((pinned.lat || 0) * 1000) / 1000),
            "X-Strategy": strat,
            "X-Longctx-Pin": "1",
            ...(t
              ? {
                  "X-Estate-Timings": `connect_ms=${t.connect_ms};ttft_ms=${t.ttft_ms ?? "-"};total_ms=${t.total_ms}`,
                }
              : {}),
          },
        });
      }

      const fn = ROUTERS[strat] || routeHybrid;
      const r = await fn(body, sid);
      if (r.ok) {
        const t = r.timings;
        return new Response(r.data, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-Via": `${r.provider}/${r.model}`,
            "X-Latency": String(Math.round((r.lat || 0) * 1000) / 1000),
            "X-Strategy": strat,
            ...(t
              ? {
                  "X-Estate-Timings": `connect_ms=${t.connect_ms};ttft_ms=${t.ttft_ms ?? "-"};total_ms=${t.total_ms}`,
                }
              : {}),
          },
        });
      }
      return json(
        { error: r.err || "exhausted", status: r.status },
        r.status || 503,
      );
    }

    return new Response("Not Found", { status: 404 });
  },
});

// Hot config reload: secrets are re-read with overwrite so a key refresh
// (NVIDIA_API_KEY, NIM_PROXY_API_KEY, ...) lands without a restart.
const SECRET_FILES = [
  `${process.env.HOME}/.secrets`,
  "/home/toxic/.secrets",
  "/home/toxic/estate/.env.local",
];
function hotReload(source: string): Record<string, unknown> {
  for (const f of SECRET_FILES) loadEnvFile(f, true);
  const keys: Record<string, string> = {};
  for (const p of Object.keys(PROVIDERS)) keys[p] = keyOk(p) ? "configured" : "no_key";
  log(`hot reload (${source}): keys=${JSON.stringify(keys)}`);
  // Refresh live model catalogs in the background; the quarantine prober
  // re-admits revived providers on its next window.
  refreshLiveModels().catch((e) => log("post-reload live refresh failed:", e));
  const priors = state.applyBenchPriors();
  log(`hot reload (${source}): priors=${JSON.stringify(priors)}`);
  return { source, keys, priors };
}
process.on("SIGHUP", () => hotReload("SIGHUP"));

// Active quarantine re-prober: cheap GET {base}/models with a short
// deadline; success half-opens the provider, failure re-opens at the next
// exponential backoff level.
async function probeProvider(p: string): Promise<boolean> {
  const conf = PROVIDERS[p];
  if (!conf) return false;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "EstateRouter/3.2 quarantine-probe",
  };
  if (!conf.no_auth) {
    const k = getKey(p);
    if (!k) return false;
    headers["Authorization"] = `Bearer ${k}`;
  }
  try {
    const r = await fetch(`${conf.base.replace(/\/+$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    // 401/403 = key still bad (stay quarantined); anything else reachable
    // (even 404/429) means the endpoint is alive -> half-open.
    return r.status !== 401 && r.status !== 403;
  } catch {
    return false;
  }
}
startQuarantineProber(probeProvider);

// Push-not-poll kimi-auto resolution (HFT: subscribe, don't poll).
// The shim reads state live per request; this watch keeps /status's
// resolved_model marker instant without waiting for the 30-min discovery.
const KIMI_STATE_PATH =
  process.env.KIMI_AUTO_STATE ||
  `${process.env.HOME}/.local/share/kimi-auto/state.json`;
let kimiResolved: { model: string | null; healthy: boolean; updated_at: string | null } = {
  model: null,
  healthy: false,
  updated_at: null,
};
function readKimiState(): void {
  try {
    if (!existsSync(KIMI_STATE_PATH)) return;
    const j = JSON.parse(readFileSync(KIMI_STATE_PATH, "utf8"));
    kimiResolved = {
      model: typeof j.model === "string" ? j.model : null,
      healthy: j.healthy !== false,
      updated_at: j.updated_at || null,
    };
  } catch (e) {
    log("kimi state read failed:", String(e).slice(0, 120));
  }
}
readKimiState();
try {
  watch(KIMI_STATE_PATH, () => {
    readKimiState();
    log(`kimi-auto state changed -> ${kimiResolved.model} (healthy=${kimiResolved.healthy})`);
  });
} catch (e) {
  log("kimi state watch unavailable:", String(e).slice(0, 120));
}

// Warm standby (HFT: dial once, keep alive): low-frequency liveness pings
// for LOCAL providers only (no cloud spend). A dead local backend earns
// circuit strikes here so quarantine can engage before user traffic hits it;
// consecutive successes keep the TCP path warm.
const LOCAL_WARM = ["herd", "kimi-auto", "nim-local"];
function startWarmStandby(): void {
  const tick = async () => {
    for (const p of LOCAL_WARM) {
      try {
        if (!keyOk(p)) continue;
        const conf = PROVIDERS[p];
        if (!conf) continue;
        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": "EstateRouter/3.2 warm-standby",
        };
        const r = await fetch(`${conf.base.replace(/\/+$/, "")}/models`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        // recordProbe: strikes + circuit only — no Elo inflation, no DB rows.
        state.recordProbe(p, r.ok, r.ok ? "" : `warm-standby http_${r.status}`);
      } catch (e) {
        state.recordProbe(p, false, `warm-standby: ${String(e).slice(0, 120)}`);
      }
    }
  };
  setInterval(() => {
    tick().catch((e) => log("warm standby tick:", String(e).slice(0, 120)));
  }, 30000);
  tick().catch(() => {});
}
startWarmStandby();

// Live model discovery: curated list + every model each key can serve.
startLiveDiscovery();

const keyed = Object.keys(PROVIDERS).filter(keyOk);

console.log(`Estate Router TS v3.2 on http://127.0.0.1:${PORT}/v1`);

console.log(
  `Strategy=${STRATEGY} | routes: ${Object.keys(ROUTERS).join(", ")}`,
);

console.log(`Streaming=SSE | Providers: ${keyed.join(", ") || "(none)"}`);

console.log(`Health DB: ${DB_PATH} (WAL)`);

console.log(`Listening ${server.hostname}:${server.port}`);

// hotreload-probe 1784356795195
