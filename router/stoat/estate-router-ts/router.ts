#!/usr/bin/env bun
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
import { handleMeshRequest } from "../../../../../../estate/src/lib/ghas-mesh-features.ts";
import type { ChatBody, RequestCtx, RouteResult } from "./router_types.ts";
import { CODING, PROVIDERS, keyOk, getKey, STRATEGY, MAX_PARALLEL, PORT, json, log, DB_PATH, isExplicit, normalizeModelSpec, resolveModel, loadEnvFile, catalog, catalogModelsFor, parseStickyOpt, classifyTask } from "./router_config.ts";
import { LIVE_MODEL_META, modelFree } from "./router_config.ts";
import { startLiveDiscovery, refreshLiveModels, LIVE_STATUS } from "./router_live_models.ts";
import { state, startQuarantineProber } from "./router_matrix.ts";
import { BELIEF } from "./router_matrix.ts";
import { obeliskEngine, getRankedArms, getTaskPath, observeAttemptOutcome, substanceScore, validateContract } from "./obelisk_engine.ts";
import { classifyRateLimit } from "./rate_limit_deconvolution.ts";
import { ROUTERS, routeHybrid, callOne, pickWeighted, rankedPairs, isRoutableModelId, tryLongctxPin, tryLongctx2MPin, buildBodybuilderRequests, runBodybuilderAutonomous, substantive } from "./router_strategy.ts";
import { uiData, ROUTER_UI_HTML } from "./router_ui.ts";
import {
  loadAuthFromEnv,
  identifyRequest,
  handleLogin,
  handleLogout,
} from "./router_auth.ts";

import { Coalescer, coalesceKey, isLead, sharedToResponse, Lead } from "./coalescer.ts";
import { RoutingDecision } from "./decision.ts";
import { flockMetrics } from "./flock-metrics.ts";
import {
  DEADLINE_HEADER,
  parseFlockDeadline,
  InflightGate,
  digestClientKeys,
  presentedClientKey,
  clientKeyAuthorized,
  AUTH_FAILURE_DELAY_MS,
  sleep,
} from "./request-gates.ts";
import { isProxyableV1Path, proxyV1Path } from "./v1paths.ts";
import { rebuildRateLimiter } from "./router_strategy.ts";

// ---------------------------------------------------------------------------
// Optional client auth (absorbed from the retired :8000 key-proxy).
// Set ESTATE_CLIENT_KEYS=comman,separated,keys to require a client key.
// Unset = open (daemon binds 127.0.0.1; localhost is the trust boundary).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Flock-port request gates: client-key digests (G18), the global in-flight
// cap (G5), and the request coalescer (G1). Client keys are compared as
// SHA-256 digests with a constant-time compare — the runtime never holds a
// usable token (flock proxy.rs client auth).
// ---------------------------------------------------------------------------
const CLIENT_KEY_DIGESTS = digestClientKeys(
  (process.env.ESTATE_CLIENT_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const inflightGate = new InflightGate();
const coalescer = new Coalescer(
  parseInt(process.env.ESTATE_COALESCE_TTL_MS || "5000", 10) || 5000,
);
const COALESCE_ENABLED = process.env.ESTATE_COALESCE !== "0";

function clientAuthorized(req: Request): boolean {
  return clientKeyAuthorized(CLIENT_KEY_DIGESTS, presentedClientKey(req));
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
  strat: string,
  rctx: RequestCtx,
  releaseSlot: () => void,
): Promise<Response> {
  // G3: commit 200 immediately and heartbeat while waiting/retrying (flock
  // proxy.rs streaming()). Clients see `: connected`, then `: heartbeat`
  // every ESTATE_SSE_HEARTBEAT_MS while routing, `: retrying` between
  // attempts, and routed-via/strategy/timings comments on the first chunk.
  // ESTATE_STREAM_IDLE_MS kills a stalled upstream; client hangup closes
  // everything promptly and frees the in-flight slot.
  const enc = new TextEncoder();
  const hbMs =
    parseInt(process.env.ESTATE_SSE_HEARTBEAT_MS || "10000", 10) || 10000;
  const idleMs =
    parseInt(process.env.ESTATE_STREAM_IDLE_MS || "300000", 10) || 300000;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let done = false;
  let hb: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    if (hb) clearInterval(hb);
    try {
      controller?.close();
    } catch {
      /* noop */
    }
    releaseSlot();
  };
  const send = (s: string): boolean => {
    if (done || !controller) return false;
    try {
      controller.enqueue(enc.encode(s));
      return true;
    } catch {
      return false;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      finish();
    },
  });
  hb = setInterval(() => {
    send(": heartbeat\n\n");
  }, hbMs);
  const onAbort = () => {
    send(
      `data: ${JSON.stringify({ error: { message: "deadline_exceeded", type: "proxy_error", code: 504 } })}\n\n`,
    );
    finish();
  };
  rctx.signal?.addEventListener("abort", onAbort, { once: true });

  const response = new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });

  void (async () => {
    try {
      const requestStart = performance.now();
      const model = String(body.model || "auto");
      const promptText = (body.messages ?? []).map((m: { content?: unknown }) => String(m.content ?? "")).join("\n");
      const taskPath = getTaskPath(promptText);
      const pairs = getRankedArms(taskPath, model === "auto" ? null : model);
      const K = Math.min(3, pairs.length);
      const delta = 100;

      const sleep = (ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      };

      const inFlight = pairs.slice(0, K).map(([p, m], i) => {
        const ac = new AbortController();
        const promise = sleep(i * delta).then(async () => {
          if (ac.signal.aborted) return null;
          const start = performance.now();
          const r = await callOne(p, m, body, true, ac.signal, rctx, true);
          const lat = performance.now() - start;
          const ok = r.ok && !!r.stream;
          if (!ok) {
            if (r.status === 429) {
              const sig = classifyRateLimit(r.err || "", {}, 500);
              BELIEF.observeRecovery(`${p}/${m}/${taskPath}`, sig.horizonSec, false, sig.family);
              BELIEF.observeBucket(p, "default", {}, false);
            } else {
              BELIEF.observe(`${p}/${m}/${taskPath}`, false, lat, 0);
              observeAttemptOutcome(`${p}/${m}`, taskPath, false, lat, 0, true);
            }
          }
          return r;
        });
        return { p, m, ac, promise };
      });
      const tried = inFlight.map((x) => `${x.p}/${x.m}`);

      let winner: RouteResult | null = null;
      for (const item of inFlight) {
        const res = await item.promise;
        if (res && res.stream) {
          winner = res;
          // Abort all other speculative runners
          inFlight.forEach((x) => {
            if (x !== item) x.ac.abort();
          });
          break;
        }
      }

      if (done) return;
      if (!winner || !winner.stream) {
        flockMetrics.recordRequest(
          "none",
          model,
          "/v1/chat/completions",
          502,
        );
        send(
          `data: ${JSON.stringify({ error: { code: "all_probes_failed", tried, type: "proxy_error" } })}\n\n`,
        );
        return;
      }
      const wst = winner.timings;
      flockMetrics.recordRequest(
        winner.provider || "none",
        winner.model || String(body.model || "auto"),
        "/v1/chat/completions",
        200,
      );
      // Pipe the winner with the stream_idle stall cutoff; heartbeats stop
      // at the first chunk.
      const reader = winner.stream.getReader();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          send(
            `data: ${JSON.stringify({ error: { message: "stream_idle_timeout", type: "proxy_error", code: 504 } })}\n\n`,
          );
          try {
            reader.cancel();
          } catch {
            /* noop */
          }
        }, idleMs);
        (idleTimer as unknown as { unref?: () => void }).unref?.();
      };
      let firstChunk = true;
      let tokenCount = 0;
      let sseBuffer = "";
      const streamStart = performance.now();
      armIdle();
      try {
        for (;;) {
          const { done: d, value } = await reader.read();
          if (d || done) break;
          armIdle();
          if (firstChunk) {
            firstChunk = false;
            if (hb) {
              clearInterval(hb);
              hb = undefined;
            }
            send(`: routed-via ${winner.provider}/${winner.model}\n`);
            send(`: strategy ${strat}\n`);
            if (wst) {
              send(
                `: timings connect_ms=${wst.connect_ms};ttft_ms=${wst.ttft_ms ?? "-"};total_ms=${wst.total_ms}\n`,
              );
            }
          }
          if (value) {
            sseBuffer += new TextDecoder().decode(value, { stream: true });
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? ""; // keep incomplete line
            for (const line of lines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                const dataJson = line.slice(6).trim();
                try {
                  const parsed = JSON.parse(dataJson);
                  const delta = parsed.choices?.[0]?.delta;
                  if (delta && (delta.content !== undefined || delta.reasoning_content !== undefined)) {
                    tokenCount++;
                  }
                  if (parsed.usage?.completion_tokens) {
                    const claimed = Number(parsed.usage.completion_tokens);
                    if (claimed > 0 && Math.abs(claimed - tokenCount) / Math.max(1, tokenCount) > 0.20) {
                      log(`[measurement] token mismatch provider_claimed=${claimed} counted=${tokenCount} — count wins`);
                    }
                  }
                } catch {
                  // Non-JSON frame (heartbeat/keepalive); ignore
                }
              }
            }
          }
          try {
            controller!.enqueue(value);
          } catch {
            break;
          }
        }
      } finally {
        const streamTotalMs = performance.now() - requestStart;
        const realTps = tokenCount >= 2 && streamTotalMs > 0 ? tokenCount / (streamTotalMs / 1000) : 0;
        if (winner.provider && winner.model) {
          const contract = validateContract(winner, winner.provider);
          const verifiedOk = contract.schema && contract.identity;
          BELIEF.observe(`${winner.provider}/${winner.model}/${taskPath}`, verifiedOk, streamTotalMs, realTps);
          BELIEF.observeBucket(winner.provider, "default", {}, verifiedOk);
          observeAttemptOutcome(`${winner.provider}/${winner.model}`, taskPath, verifiedOk, streamTotalMs, tokenCount, false);
        }
        if (idleTimer) clearTimeout(idleTimer);
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
      }
    } finally {
      finish();
    }
  })().catch((e) => {
    // Client hangup (AbortError) is routine traffic, not a bug: the SSE
    // stream already closed via onAbort/finish. Anything else is logged
    // loudly but must never kill the router (2026-10-03 crash-loop: an
    // unhandled AbortError exited Bun and pitchfork respawned -> ~20s flap).
    const nm = (e as { name?: string } | null)?.name;
    if (nm !== "AbortError") log("sse route rejected:", String(e).slice(0, 300));
  });
  return response;
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

    // G5: global in-flight cap (flock proxy.rs) — shed past the cap with 429
    // "overloaded". The release is scope-guarded: buffered paths release in
    // the finally at the end of fetch; stream paths set streamOwnsSlot and
    // release when the SSE stream closes or the client hangs up.
    const releaseInflight = inflightGate.enter();
    if (!releaseInflight) {
      flockMetrics.shed++;
      return json({ error: "overloaded", max_inflight: inflightGate.limit }, 429);
    }
    let streamOwnsSlot = false;
    try {

    // Client-key gate (only when ESTATE_CLIENT_KEYS is set). /health stays
    // open for liveness probes; everything else requires a key.
    // G18: constant-time digest auth (flock proxy.rs) with a 250ms failure
    // delay. Unset ESTATE_CLIENT_KEYS = open (localhost trust boundary);
    // /health stays open for liveness probes.
    if (path !== "/health" && !clientAuthorized(req)) {
      flockMetrics.unauthorized++;
      await sleep(AUTH_FAILURE_DELAY_MS);
      return json({ error: "unauthorized" }, 401);
    }

    // G4: x-flock-deadline-ms — absolute client deadline (malformed = 400).
    // Enforced on every attempt via the request AbortSignal; the buffered
    // path additionally races the routing promise so the 504 lands promptly.
    const acceptedMs = Date.now();
    const dlParsed = parseFlockDeadline(req.headers.get(DEADLINE_HEADER), acceptedMs);
    if (dlParsed && !dlParsed.ok) {
      return json({ error: "invalid_x_flock_deadline_ms" }, 400);
    }
    const deadlineMs = dlParsed && dlParsed.ok ? dlParsed.atMs : undefined;

    // Per-request context (G4/G8/G9/G12): deadline+hangup signal, request
    // headers for the turn-handle relay, path for labels/coalescing, and a
    // fresh routing-decision ledger.
    const mkCtx = (model?: string): RequestCtx => {
      const dc = new AbortController();
      if (deadlineMs !== undefined) {
        const ms = deadlineMs - Date.now();
        if (ms <= 0) {
          dc.abort(new Error("deadline_exceeded"));
        } else {
          const t = setTimeout(() => dc.abort(new Error("deadline_exceeded")), ms);
          (t as unknown as { unref?: () => void }).unref?.();
        }
      }
      return {
        signal: AbortSignal.any([req.signal, dc.signal]),
        deadlineMs,
        reqHeaders: req.headers,
        path,
        model,
        decision: new RoutingDecision(),
      };
    };
    // G12: compact decision header for the response + optional full JSON
    // debug log.
    const emitDecision = (rctx: RequestCtx): string => {
      const d = rctx.decision!;
      if (process.env.ESTATE_DECISION_LOG === "1") {
        log("routing decision", rctx.model, JSON.stringify(d.toJSON()));
      }
      return d.compact();
    };

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

    if (req.method === "GET" && path === "/belief") {
      return json({
        size: BELIEF.size(),
        providers: [...new Set([...BELIEF.field.keys()].map((k) => k.split("/")[0]))],
        entries: Object.fromEntries(
          [...BELIEF.field.entries()].map(([k, v]) => {
            const pok = typeof v.p_ok === "number" ? v.p_ok : ((v.successes + 1) / (v.successes + v.failures + 2));
            return [k, { p_ok: +pok.toFixed(3), n: v.n, e_lat: +(v.e_lat || 0).toFixed(0), e_tps: +(v.e_tps || 0).toFixed(1) }];
          })
        ),
        obelisk: {
          models: obeliskEngine.models(),
          rank_chat: obeliskEngine.rank("chat/general"),
          rank_code: obeliskEngine.rank("code/general"),
        },
      });
    }
    if (req.method === "GET" && path === "/status") {
      // v3.2: live per-provider state — the resilience dashboard.
      const dbSummary = state.health.getProviderSummary();
      const pct = state.health.getLatencyPercentiles();
      const providers: Record<string, unknown> = {};
      for (const p of Object.keys(PROVIDERS)) {
        providers[p] = {
          keys: keyOk(p) ? "configured" : "no_key",
          base_url: PROVIDERS[p].base,
          circuit: state.circuitInfo(p),
          lane_dead: false,
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
        model_disabler: state.disabler.stats(),
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
      L.push(
        `estate_router_inflight_requests ${inflightGate.count}`,
        `estate_router_max_inflight ${inflightGate.limit}`,
        ...flockMetrics.render(),
      );
      return new Response(
        "# HELP estate_router_requests_total Total chat completion requests per provider\n" +
          "# TYPE estate_router_requests_total counter\n" +
          "# HELP estate_router_inflight_requests Current in-flight requests (flock max_inflight)\n" +
          "# TYPE estate_router_inflight_requests gauge\n" +
          "# HELP estate_router_max_inflight Configured in-flight cap\n" +
          "# TYPE estate_router_max_inflight gauge\n" +
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
      }, 200, { "Access-Control-Allow-Origin": "*" });
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
    if (req.method === "GET" && path === "/openfang/resolve") {
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

    // G9: multi-path /v1/* proxying (flock V1_WILDCARD) — embeddings,
    // completions, and rankings proxy with model rewrite + ordered failover
    // instead of 404ing. Chat-specific machinery (substance guard, stream
    // injection, coalescing) is skipped inside proxyV1Path.
    if (req.method === "POST" && isProxyableV1Path(path)) {
      const rawText = await req.text();
      const rctx = mkCtx();
      return proxyV1Path(path, rawText, rctx);
    }

    if (req.method === "POST" && path.includes("/chat/completions")) {
      const rawText = await req.text();
      let body: ChatBody;
      try {
        body = JSON.parse(rawText) as ChatBody;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const sid = sessionId(req, body);
      const strat = req.headers.get("X-Estate-Strategy") || STRATEGY;
      // Router-max: session stickiness is client-controlled.
      // X-Estate-Sticky: 1 -> pin this session; 0 -> never pin.
      // Absent -> legacy behavior (races pin the winner).
      state.setStickyOpt(sid, parseStickyOpt(req.headers.get("X-Estate-Sticky")));
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

      const rctx = mkCtx(String(body.model || "auto"));

      if (body.stream) {
        streamOwnsSlot = true;
        return handleStream(body, sid, strat, rctx, releaseInflight);
      }

      // G1: request coalescing — identical in-flight buffered POSTs share
      // one upstream call (flock coalescer.rs). The leader routes; followers
      // receive the leader's response. A leader whose answer lacks
      // substance drops the lead instead of publishing emptiness.
      let lead: Lead | null = null;
      if (COALESCE_ENABLED) {
        const reg = coalescer.register(
          coalesceKey(req.method, path, JSON.stringify(body)),
        );
        if (isLead(reg)) {
          lead = reg.lead;
          flockMetrics.coalescedLeader++;
        } else {
          const shared = await reg.follower;
          if (shared) {
            flockMetrics.coalescedFollower++;
            flockMetrics.recordRequest(
              "coalesced",
              String(body.model || "auto"),
              path,
              shared.status,
            );
            return sharedToResponse(shared);
          }
          // Leader vanished without publishing (or the wait hit TTL) —
          // proceed alone.
        }
      }
      const settleLead = (r: RouteResult) => {
        if (!lead) return;
        const l = lead;
        lead = null;
        if (r.ok && r.data) {
          const bytes =
            typeof r.data === "string"
              ? new TextEncoder().encode(r.data)
              : (r.data as Uint8Array);
          if (bytes.length > 0 && substantive(r)) {
            l.complete({
              status: 200,
              contentType: "application/json",
              body: bytes,
              extra: r.interactionId
                ? [["x-interaction-id", r.interactionId]]
                : [],
            });
            return;
          }
        }
        l.drop();
      };

      // 2M-context tier (2026-10-01): est tokens >1M -> direct keyed
      // openrouter lane (x-ai/grok-4.20, 2M context), skipping the race.
      // Ineligible or pinned failure falls through to the 1M pin, then the
      // normal strategy dispatch.
      const pinned2m = await tryLongctx2MPin(body, sid, false, rctx);
      if (pinned2m && substantive(pinned2m)) {
        settleLead(pinned2m);
        const t2 = pinned2m.timings;
        flockMetrics.recordRequest(
          pinned2m.provider || "none",
          pinned2m.model || String(body.model || "auto"),
          path,
          200,
        );
        return new Response(pinned2m.data as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-Via": `${pinned2m.provider}/${pinned2m.model}`,
            "X-Latency": String(Math.round((pinned2m.lat || 0) * 1000) / 1000),
            "X-Strategy": strat,
            "X-Longctx-Pin": "2m",
            "X-Routing-Decision": emitDecision(rctx),
            ...(pinned2m.interactionId
              ? { "x-interaction-id": pinned2m.interactionId }
              : {}),
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
      const pinned = await tryLongctxPin(body, sid, false, rctx);
      if (pinned && substantive(pinned)) {
        settleLead(pinned);
        const t = pinned.timings;
        flockMetrics.recordRequest(
          pinned.provider || "none",
          pinned.model || String(body.model || "auto"),
          path,
          200,
        );
        return new Response(pinned.data as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-Via": `${pinned.provider}/${pinned.model}`,
            "X-Latency": String(Math.round((pinned.lat || 0) * 1000) / 1000),
            "X-Strategy": strat,
            "X-Longctx-Pin": "1",
            "X-Routing-Decision": emitDecision(rctx),
            ...(pinned.interactionId
              ? { "x-interaction-id": pinned.interactionId }
              : {}),
            ...(t
              ? {
                  "X-Estate-Timings": `connect_ms=${t.connect_ms};ttft_ms=${t.ttft_ms ?? "-"};total_ms=${t.total_ms}`,
                }
              : {}),
          },
        });
      }

      const fn = ROUTERS[strat] || routeHybrid;
      let r: RouteResult;
      if (deadlineMs !== undefined) {
        // G4: race routing against the client deadline so the 504 lands
        // promptly; the abort signal still cancels the upstream work.
        const waitMs = Math.max(0, deadlineMs - Date.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onDeadline: Promise<RouteResult> = new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ ok: false, status: 504, err: "deadline_exceeded" }),
            waitMs,
          );
          (timer as unknown as { unref?: () => void }).unref?.();
        });
        r = await Promise.race([fn(body, sid, rctx), onDeadline]);
        if (timer) clearTimeout(timer);
        if (r.status === 504 && r.err === "deadline_exceeded") {
          flockMetrics.deadlineExceeded++;
          settleLead(r);
          return json({ error: "deadline_exceeded" }, 504);
        }
      } else {
        r = await fn(body, sid, rctx);
      }
      if (r.ok) {
        settleLead(r);
        const t = r.timings;
        flockMetrics.recordRequest(
          r.provider || "none",
          r.model || String(body.model || "auto"),
          path,
          200,
        );
        return new Response(r.data as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Routed-Via": `${r.provider}/${r.model}`,
            "X-Latency": String(Math.round((r.lat || 0) * 1000) / 1000),
            "X-Strategy": strat,
            "X-Routing-Decision": emitDecision(rctx),
            ...(r.interactionId ? { "x-interaction-id": r.interactionId } : {}),
            ...(r.switches
              ? { "X-Estate-Switches": String(r.switches) }
              : {}),
            ...(r.cost_tier ? { "X-Cost-Tier": r.cost_tier } : {}),
            ...(r.task_type ? { "X-Task-Type": r.task_type } : {}),
            ...(t
              ? {
                  "X-Estate-Timings": `connect_ms=${t.connect_ms};ttft_ms=${t.ttft_ms ?? "-"};total_ms=${t.total_ms}`,
                }
              : {}),
          },
        });
      }
      settleLead(r);
      flockMetrics.recordRequest(
        r.provider || "none",
        String(body.model || "auto"),
        path,
        r.status || 503,
      );
      return json(
        { error: r.err || "exhausted", status: r.status },
        r.status || 503,
      );
    }

    return new Response("Not Found", { status: 404 });
    } finally {
      if (!streamOwnsSlot) releaseInflight();
    }
  },
});

// Hot config reload: secrets are re-read with overwrite so a key refresh
// (NVIDIA_API_KEY, NIM_PROXY_API_KEY, ...) lands without a restart.
const SECRET_FILES = [
  `${process.env.HOME}/.secrets`,
  "/home/toxic/.secrets",
  "/home/toxic/estate/.secrets",
  "/home/toxic/estate/config/.secrets",
  "/home/toxic/estate/.env.local",
  "/home/toxic/estate/.env",
  "/home/toxic/estate/config/tau/.env",
  "/home/toxic/.tau/.env",
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
  rebuildRateLimiter();
  log(`hot reload (${source}): priors=${JSON.stringify(priors)}`);
  return { source, keys, priors };
}
process.on("SIGHUP", () => hotReload("SIGHUP"));

// A client disconnect mid-request surfaces as AbortError in async work.
// Exiting here costs a full restart flap, so the router stays up: swallow
// abort-family rejections silently, log everything else loudly.
process.on("unhandledRejection", (reason) => {
  const nm = (reason as { name?: string } | null)?.name;
  if (nm === "AbortError") return;
  log("unhandledRejection (kept alive):", String(reason).slice(0, 300));
});

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
const LOCAL_WARM = ["llama-swap", "kimi-auto", "nim-local"];
function startWarmStandby(): void {
  const tick = async () => {
    for (const p of LOCAL_WARM) {
      try {
        if (!keyOk(p)) continue;
        const conf = PROVIDERS[p];
        const k = getKey(p);
        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": "EstateRouter/3.2 warm-standby",
        };
        if (k) headers["Authorization"] = `Bearer ${k}`;
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

// Model disabler background rechecker (2026-10-04): probes disabled models
// on backoff schedule; 2 consecutive successes re-admits them.
import("./model_rechecker.ts").then((m) => m.startRechecker()).catch((e) => console.error("rechecker start failed:", String(e).slice(0, 120)));

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
