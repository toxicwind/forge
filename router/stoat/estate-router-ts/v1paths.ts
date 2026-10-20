/**
 * G9 — multi-path /v1/* proxying (embeddings, completions, rankings).
 *
 * Port of flock-proxy's V1_WILDCARD handling (routes.rs + proxy.rs:114):
 * the TS router previously 404'd every non-chat /v1 path. Buffered
 * generation paths now proxy with model rewrite and failover, skipping
 * chat-specific logic (substance guard, stream_options injection).
 */
import type { ChatBody, RouteResult, RequestCtx } from "./router_types.ts";
import {
  PROVIDERS,
  getKey,
  keyOk,
  UA,
  ATTEMPT_MS,
  catalogModelsFor,
  resolveModel,
  resolveModel,
  log,
} from "./router_config.ts";
import { state } from "./router_matrix.ts";
import { flockMetrics } from "./flock-metrics.ts";
import { shouldFailover, isRoutableModelId } from "./router_strategy.ts";

/** Upstream sub-paths we proxy (Rust's label_path allowlist, minus models). */
const PROXYABLE = new Set(["/v1/completions", "/v1/embeddings", "/v1/rankings"]);

export function isProxyableV1Path(path: string): boolean {
  return PROXYABLE.has(path);
}

/** Join a provider base (usually .../v1) with a /v1/* path without doubling. */
export function joinUpstreamPath(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  let p = path;
  if (b.endsWith("/v1") && p.startsWith("/v1/")) p = p.slice(3);
  return b + p;
}

interface V1Candidate {
  provider: string;
  model: string;
}

function candidatesFor(model: string, path: string): V1Candidate[] {
  // Explicit model: pin its provider (resolveModel covers aliases,
  // provider:model specs, and catalog ids).
  if (model && isRoutableModelId(model)) {
    const [p, mid] = resolveModel(model);
    if (keyOk(p) && state.circuitOk(p)) return [{ provider: p, model: mid }];
  }
  const out: V1Candidate[] = [];
  // /v1/embeddings must ride an embedding-capable model id: sending a chat
  // model id to a provider's embeddings endpoint 404s/501s upstream, so the
  // whole G9 path degrades to an upstream error. Prefer catalog ids matching
  // /embed/i per provider; fall back to the first usable model otherwise.
  const wantEmbed = path === "/v1/embeddings";
  for (const p of Object.keys(PROVIDERS)) {
    if (!keyOk(p) || !state.circuitOk(p) || state.laneDead(p)) continue;
    // Prefer a provider whose catalog actually lists the requested model
    // (Rust's serves_model scoping); fall back to its first usable model.
    const listed = model && catalogModelsFor(p).includes(model);
    const mid = listed
      ? model
      : (() => {
          const usable = (m: string) =>
            !state.flapBanned(p, m) && !state.isEntitlementDead(p, m);
          const cat = catalogModelsFor(p);
          if (wantEmbed) {
            for (const m of cat) {
              if (/embed/i.test(m) && usable(m)) return m;
            }
            // No embedding-capable model on this provider: sit out instead of
            // burning a chat model id against its embeddings endpoint.
            return undefined;
          }
          for (const m of cat) {
            if (usable(m)) return m;
          }
          return undefined;
        })();
    if (mid) out.push({ provider: p, model: mid });
  }
  return out;
}

/**
 * Proxy a non-chat /v1/* POST to the provider fleet with ordered failover.
 * Chat-specific machinery (substance guard, stream injection, coalescing)
 * is intentionally skipped — these paths return tensors/scores, not chat
 * text. The Gemini turn-handle relay (x-interaction-id) still applies.
 */
export async function proxyV1Path(
  path: string,
  rawBody: string,
  rctx: RequestCtx = {},
): Promise<Response> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const model = String(parsed["model"] || "auto");
  const cands = candidatesFor(model, path);
  if (!cands.length) {
    return Response.json({ error: "no_providers_for_path", path }, { status: 503 });
  }
  const prevId = rctx.reqHeaders?.get("x-previous-interaction-id");
  let lastStatus = 503;
  let lastErr = "v1path_exhausted";
  for (const { provider, model: mid } of cands) {
    const conf = PROVIDERS[provider];
    if (!conf) continue;
    const url = joinUpstreamPath(conf.base, path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Accept-Encoding": "identity",
    };
    if (!conf.no_auth) headers.Authorization = `Bearer ${getKey(provider)}`;
    else headers.Authorization = "Bearer not-required-for-local";
    if (prevId) headers["x-previous-interaction-id"] = prevId;
    const bodyOut = JSON.stringify({ ...(parsed as ChatBody), model: mid });
    const start = performance.now();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: bodyOut,
        signal: rctx.signal
          ? AbortSignal.any([AbortSignal.timeout(ATTEMPT_MS), rctx.signal])
          : AbortSignal.timeout(ATTEMPT_MS),
      });
    } catch (e) {
      const lat = (performance.now() - start) / 1000;
      const msg = e instanceof Error ? e.message : String(e);
      state.noteError(provider, 504, msg.slice(0, 200));
      state.record(model, provider, 504, lat, 0, "v1path");
      flockMetrics.recordRequest(provider, model, path, 504);
      lastErr = msg.slice(0, 120);
      continue; // connection failure is always failover-eligible
    }
    const lat = (performance.now() - start) / 1000;
    const data = new Uint8Array(await resp.arrayBuffer());
    state.record(mid, provider, resp.status, lat, 0, "v1path");
    flockMetrics.recordRequest(provider, mid, path, resp.status);
    const interactionId = resp.headers.get("x-interaction-id");
    if (!resp.ok) {
      const probe: RouteResult = {
        ok: false,
        status: resp.status,
        provider,
        err: new TextDecoder().decode(data).slice(0, 200),
      };
      lastStatus = resp.status;
      lastErr = probe.err || lastErr;
      // On the embeddings path an upstream 404 means "this model id does not
      // serve embeddings here" — the next candidate (different
      // provider/model) may. Don't let one bad catalog id end the race.
      if (shouldFailover(probe) || (path === "/v1/embeddings" && resp.status === 404)) continue;
      return v1PathResponse(resp.status, data, resp.headers.get("content-type"), interactionId);
    }
    if (state.circuit.get(provider) === "half") state.circuit.set(provider, "closed");
    log(`v1path ${path} model=${model} -> ${provider}/${mid} ${lat.toFixed(2)}s`);
    return v1PathResponse(200, data, resp.headers.get("content-type"), interactionId);
  }
  return Response.json({ error: lastErr, status: lastStatus }, { status: lastStatus });
}

function v1PathResponse(
  status: number,
  data: Uint8Array,
  contentType: string | null,
  interactionId: string | null,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": contentType || "application/json",
  };
  if (interactionId) headers["x-interaction-id"] = interactionId;
  return new Response(data as BodyInit, { status, headers });
}
