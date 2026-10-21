/**
 * cuttinggate — routing gate between the coding agent and its backends.
 *
 * Failure envelope: every non-2xx carries a `code` the client can branch on
 * without parsing prose. The catalog is watched (and reloadable via
 * POST /admin/reload or SIGHUP), so a regen lands without a restart.
 *
 * Client auth: when CUTTINGGATE_CLIENT_KEYS (or the legacy
 * ESTATE_CLIENT_KEYS) is set, every route except /health requires a
 * matching Bearer / x-api-key. Unset = open (localhost is the trust boundary).
 *
 * SSE: chat streams are plain OpenAI frames (`data: {...}` / `data: [DONE]`,
 * no `event:` field) because OpenAI-SDK parsers drop named events.
 */
import { Elysia, t } from "elysia";
import pino from "pino";
import { createHash, timingSafeEqual } from "node:crypto";
import { loadConfig, loadSecretsFiles, type Config } from "./config.ts";
import { ProviderGate } from "./circuit.ts";
import { Quarantine } from "./quarantine.ts";
import { Pauser } from "./pauser.ts";
import { Ledger } from "./ledger.ts";
import { Router } from "./router.ts";
import { loadLiveCatalog, normalizeId, watchCatalog, DEFAULT_CATALOG_PATH, type CatalogLoad, type LiveCatalog, type CatalogWatcher } from "./catalog.ts";
import { CredentialPlane, loadPoolsFromYaml } from "./keypool.ts";
import { ZEN_MODELS, ZEN_PROVIDER, ZEN_LEGACY_PROVIDER } from "./zen.ts";
import { COPILOT_PROVIDER } from "./copilot.ts";
import { DOTS_MODELS, DOTS_PROVIDER, DOTS_MODEL } from "./dots.ts";
import { buildCoding, LOCAL_ROLES, normalizeModelSpec, resolveModel, type CatalogQuery } from "./strategy/catalog.ts";

const log = pino({ level: process.env.CUTTINGGATE_LOG_LEVEL ?? "info" });

const CODES = {
  auth_missing: 401, auth_invalid: 401, model_quarantined: 409,
  catalog_missing: 503, catalog_stale: 503, catalog_unknown_contract: 503,
  no_provider_serves: 502, upstream_error: 502, admin_unavailable: 501,
} as const;

function envelope(code: keyof typeof CODES, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

/** Providers that need no key (they live on this box). */
const LOCAL_PROVIDERS = new Set(["herd", "llama-swap", "nim-local", "kimi-auto", "google-eap"]);
const CODING = buildCoding(LOCAL_ROLES, {});

// ── client-key gate ──────────────────────────────────────────────────────
const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function parseClientKeys(): Buffer[] {
  const raw = process.env.CUTTINGGATE_CLIENT_KEYS ?? process.env.ESTATE_CLIENT_KEYS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map(digest);
}

function clientAuthorized(keys: readonly Buffer[], authorization: string | null, xApiKey: string | null): boolean {
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const presented = bearer || xApiKey || "";
  if (!presented) return false;
  const d = digest(presented);
  let ok = false;
  for (const k of keys) if (timingSafeEqual(k, d)) ok = true; // no early exit
  return ok;
}

// ── SSE ──────────────────────────────────────────────────────────────────
type SseWriter = (
  send: (event: string, data: unknown) => void,
  close: () => void,
  keepAlive: () => void,
) => void;

/**
 * One place for SSE framing + headers. `event` "" omits the `event:` line;
 * string data is emitted raw (so "[DONE]" is not JSON-quoted).
 */
function createSSEStream(writer: SseWriter, extraHeaders: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  let kaTimer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (kaTimer) {
      clearInterval(kaTimer);
      kaTimer = null;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        const payload = typeof data === "string" ? data : JSON.stringify(data);
        try { controller.enqueue(encoder.encode(`${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`)); } catch { /* closed */ }
      };
      const close = (): void => {
        stop();
        try { controller.close(); } catch { /* noop */ }
      };
      const keepAlive = (): void => {
        stop();
        kaTimer = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { stop(); }
        }, 15_000);
      };
      writer(send, close, keepAlive);
    },
    cancel() { stop(); },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...extraHeaders },
  });
}

export type AppDeps = {
  config: Config; gate: ProviderGate; quarantine: Quarantine;
  ledger: Ledger; router: Router; catalogState: () => CatalogLoad;
  /** Re-read the catalog from disk and reseed the router. */
  reload?: () => CatalogLoad;
  credentials?: CredentialPlane;
  pauser?: Pauser;
};

function describeLoad(c: CatalogLoad): string {
  return c.status === "unknown-contract" ? `unknown contract ${c.contract.saw}` : "reason" in c ? c.reason : c.status;
}

export function buildApp(deps: AppDeps) {
  const { quarantine, ledger, router, config } = deps;
  const pauser = deps.pauser;
  const clientKeys = parseClientKeys();

  const catalogQuery: CatalogQuery = {
    providerNames: () => router.providers(),
    servingModels: (p) => router.servingFor(p),
    isQuarantined: (p, m) => quarantine.get(m)?.provider === p,
    deadIds: () => new Set<string>(),
    keyOk: (p) => LOCAL_PROVIDERS.has(p) || Boolean(config.keys[p]),
  };

  const handleModelsSse = async (): Promise<Response> => {
    const llamaSwap = config.bases["llama-swap"];
    const herdUrl = llamaSwap ? llamaSwap.replace(/\/v1\/?$/, "/models/sse") : "http://127.0.0.1:25100/models/sse";
    // The deadline covers headers only: the stream itself is long-lived.
    const ac = new AbortController();
    const headerTimer = setTimeout(() => ac.abort(), 10_000);
    try {
      const upstream = await fetch(herdUrl, { headers: { Accept: "text/event-stream" }, signal: ac.signal });
      clearTimeout(headerTimer);
      if (upstream.ok && upstream.body) {
        return new Response(upstream.body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }
    } catch {
      clearTimeout(headerTimer); // herd down: fall through to the keep-alive stream
    }
    return createSSEStream((send, _close, keepAlive) => {
      send("models_reload", { status: "loaded", count: router.known().length });
      keepAlive();
    });
  };

  return new Elysia()
    .onBeforeHandle(({ request, set }) => {
      if (!clientKeys.length) return;
      if (new URL(request.url).pathname === "/health") return;
      if (!clientAuthorized(clientKeys, request.headers.get("authorization"), request.headers.get("x-api-key"))) {
        set.status = CODES.auth_invalid;
        return envelope("auth_invalid", "invalid client key");
      }
    })
    .get("/health", () => {
      const c = deps.catalogState();
      return {
        ok: c.status === "ok", quarantined: quarantine.count,
        catalog: c.status === "ok"
          ? { contract: c.contract.name, canonical: c.contract.canonical, generatedAt: c.generatedAt, ageMs: c.ageMs, stale: c.stale }
          : { status: c.status, reason: "reason" in c ? c.reason : undefined },
      };
    })
    .get("/quarantine", () => ({ count: quarantine.count, entries: quarantine.list() }))
    .get("/pauses", () => pauser ? { count: pauser.count, entries: pauser.list() } : { count: 0, entries: [] })
    .post(
      "/pauses",
      ({ body }) => {
        if (!pauser) return { error: "pauser not configured" };
        const b = body as Record<string, unknown>;
        const action = String(b.action ?? "");
        const provider = String(b.provider ?? "");
        const model = typeof b.model === "string" ? b.model : null;
        if (!provider) return { error: "provider required" };
        if (action === "pause") {
          const durationMs = Math.min(Math.max(Number(b.durationMs ?? 300000) || 300000, 1000), 3600000);
          pauser.pause(model, provider, durationMs, "manual", String(b.detail ?? ""));
          return { status: "ok", action: "paused", model, provider, durationMs };
        }
        if (action === "resume") {
          const ok = pauser.resume(model, provider);
          return { status: "ok", action: "resumed", model, provider, removed: ok };
        }
        return { error: "action must be 'pause' or 'resume'" };
      },
    )
    .get("/status", () => ({
      providers: deps.gate.snapshot(),
      quarantined: quarantine.count,
      leaders: ledger.top(10),
      starved: router.starved(),
      credentials: deps.credentials?.snapshot() ?? [],
    }))
    .get("/metrics", () => ({
      cuttinggate_quarantined: quarantine.count,
      cuttinggate_model_empty_strikes: Object.fromEntries([...ledger.models()].map((m) => [m, deps.gate.emptyStrikes(m)])),
      cuttinggate_race_total: ledger.total(),
    }))
    .get("/v1/models", () => ({
      object: "list",
      data: router.known().map((m) => ({ id: m.id, object: "model", owned_by: m.provider, ...(quarantine.isQuarantined(m.id) ? { quarantined: true } : {}) })),
    }))
    .get("/models/sse", () => handleModelsSse())
    .get("/v1/models/sse", () => handleModelsSse())
    .get(
      "/v1/custom/openfang-resolve",
      ({ query }) => {
        const spec = query.spec ?? "";
        const norm = normalizeModelSpec(spec, catalogQuery, CODING);
        const [provider, model] = resolveModel(spec, catalogQuery, CODING);
        const root = `http://${config.host}:${config.port}`;
        return {
          spec, provider, model,
          route: "custom/openfang-resolve",
          provider_base_url: config.bases[provider] ?? null,
          router_chat_url: `${root}/v1/chat/completions`,
          router_status_url: `${root}/status`,
          normalized_from: norm.provider ? `${norm.provider}:${norm.model}` : norm.model,
        };
      },
      { query: t.Object({ spec: t.Optional(t.String()) }) },
    )
    .get(
      "/openfang/resolve",
      ({ query }) => {
        const spec = query.spec ?? "";
        const norm = normalizeModelSpec(spec, catalogQuery, CODING);
        const [provider, model] = resolveModel(spec, catalogQuery, CODING);
        const root = `http://${config.host}:${config.port}`;
        return {
          spec, provider, model,
          route: "custom/openfang-resolve",
          provider_base_url: config.bases[provider] ?? null,
          router_chat_url: `${root}/v1/chat/completions`,
          router_status_url: `${root}/status`,
          normalized_from: norm.provider ? `${norm.provider}:${norm.model}` : norm.model,
        };
      },
      { query: t.Object({ spec: t.Optional(t.String()) }) },
    )
    .post(
      "/v1/custom/bodybuilder",
      async ({ body }) => {
        const job = String((body as Record<string, unknown>)?.job ?? "").trim();
        if (!job) {
          return { error: "missing job" };
        }
        const maxRequests = Math.min(Math.max(Number((body as Record<string, unknown>)?.max_requests ?? 4) || 4, 1), 16);
        const execute = (body as Record<string, unknown>)?.execute !== false;
        const known = router.known();
        const pool = known.length ? known : [{ id: DOTS_MODEL, provider: DOTS_PROVIDER }];
        const requests = Array.from({ length: maxRequests }, (_, i) => {
          const entry = pool[i % pool.length]!;
          return {
            model: `${entry.provider}/${entry.id}`,
            _id: entry.id,
            _provider: entry.provider,
            messages: [{ role: "user", content: job }],
            temperature: 0.7,
            max_tokens: 2000,
          };
        });
        const cleanRequests = requests.map(({ _id: _, _provider: __, ...rest }) => rest);
        if (!execute) return { route: "custom/bodybuilder", requests: cleanRequests };
        const results = await Promise.all(
          requests.map(async (req) => {
            const r = await router.complete(req._id, req.messages, { temperature: req.temperature, max_tokens: req.max_tokens }, req._provider);
            return r.ok
              ? { model: req.model, ok: true, text: r.content, latency_ms: Math.round(r.latencyMs), routed_via: `${r.provider}/${req._id}` }
              : { model: req.model, ok: false, error: r.error, latency_ms: 0 };
          }),
        );
        return { route: "custom/bodybuilder", requests: cleanRequests, results };
      },
    )
    .post(
      "/v1/bodybuilder",
      async ({ body }) => {
        const job = String((body as Record<string, unknown>)?.job ?? "").trim();
        if (!job) {
          return { error: "missing job" };
        }
        const maxRequests = Math.min(Math.max(Number((body as Record<string, unknown>)?.max_requests ?? 4) || 4, 1), 16);
        const execute = (body as Record<string, unknown>)?.execute !== false;
        const known = router.known();
        const pool = known.length ? known : [{ id: DOTS_MODEL, provider: DOTS_PROVIDER }];
        const requests = Array.from({ length: maxRequests }, (_, i) => {
          const entry = pool[i % pool.length]!;
          return {
            model: `${entry.provider}/${entry.id}`,
            _id: entry.id,
            _provider: entry.provider,
            messages: [{ role: "user", content: job }],
            temperature: 0.7,
            max_tokens: 2000,
          };
        });
        const cleanRequests = requests.map(({ _id: _, _provider: __, ...rest }) => rest);
        if (!execute) return { route: "custom/bodybuilder", requests: cleanRequests };
        const results = await Promise.all(
          requests.map(async (req) => {
            const r = await router.complete(req._id, req.messages, { temperature: req.temperature, max_tokens: req.max_tokens }, req._provider);
            return r.ok
              ? { model: req.model, ok: true, text: r.content, latency_ms: Math.round(r.latencyMs), routed_via: `${r.provider}/${req._id}` }
              : { model: req.model, ok: false, error: r.error, latency_ms: 0 };
          }),
        );
        return { route: "custom/bodybuilder", requests: cleanRequests, results };
      },
    )
    .post("/admin/reload", ({ set }) => {
      if (!deps.reload) {
        set.status = CODES.admin_unavailable;
        return envelope("admin_unavailable", "reload is not wired in this build");
      }
      const next = deps.reload();
      if (next.status !== "ok") {
        set.status = CODES.catalog_missing;
        return envelope("catalog_missing", `catalog ${next.status}: ${describeLoad(next)}`, { source: next.source });
      }
      return { status: "ok", contract: next.contract.name, generatedAt: next.generatedAt, serving: router.known().length };
    })
    .post(
      "/admin/catalog/serve-404",
      ({ body }) => {
        quarantine.noteServe404(body.model, body.provider, "serve-404 reported by consumer");
        return { status: "ok", provider: body.provider, model: body.model, quarantined: quarantine.isQuarantined(body.model) };
      },
      { body: t.Object({ provider: t.String({ minLength: 1 }), model: t.String({ minLength: 1 }) }) },
    )
    .post(
      "/v1/chat/completions",
      async ({ body, set, headers }) => {
        const auth = headers["authorization"] ?? "";
        if (!auth.startsWith("Bearer ")) { set.status = CODES.auth_missing; return envelope("auth_missing", "missing bearer token"); }
        const catStateFn = deps.catalogState ?? (() => ({ status: "ok", source: "default", contract: { name: "estate-pinax/live-catalog/v1" as const, spec: { generation: 2, canonical: true, introduced: "2026-06-01", emittedBy: "test" }, canonical: true }, catalog: { contract: "estate-pinax/live-catalog/v1" as const, generatedAt: "", deadIds: [], providers: {} }, generatedAt: "", ageMs: 0, stale: false }));
        const cat = catStateFn();
        if (cat.status !== "ok") {
          const code = cat.status === "unknown-contract" ? "catalog_unknown_contract" : "catalog_missing";
          set.status = CODES[code]; return envelope(code, `catalog ${cat.status}`, { source: cat.source });
        }

        // custom/ and openfang shim: "custom/dots", "custom/zen", "custom/copilot", "provider:model" specs.
        let model = body.model;
        let only: string | undefined;
        if (model === "custom/dots" || model === DOTS_MODEL || model === `openrouter/${DOTS_MODEL}`) {
          if (router.serves(DOTS_MODEL, DOTS_PROVIDER)) {
            model = DOTS_MODEL;
            only = DOTS_PROVIDER;
          } else if (router.serves("custom/dots", DOTS_PROVIDER)) {
            model = "custom/dots";
            only = DOTS_PROVIDER;
          }
        } else if (model.startsWith("custom/zen/")) {
          model = model.slice("custom/zen/".length);
          only = ZEN_PROVIDER;
        } else if (model.startsWith("custom/copilot/")) {
          model = model.slice("custom/copilot/".length);
          only = COPILOT_PROVIDER;
        } else if (!router.serves(model)) {
          const norm = normalizeModelSpec(model, catalogQuery, CODING);
          if (norm.provider && router.serves(norm.model, norm.provider)) {
            model = norm.model;
            only = norm.provider;
          }
        }

        if (quarantine.isQuarantined(model)) {
          const q = quarantine.get(model); set.status = CODES.model_quarantined;
          return envelope("model_quarantined", `model ${model} is quarantined: ${q?.reason} (${q?.detail})`, { model });
        }
        const rawBody = body as Record<string, unknown>;
        const attempt = await router.complete(
          model,
          body.messages,
          {
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            tools: Array.isArray(rawBody.tools) ? (rawBody.tools as never) : undefined,
            tool_choice: rawBody.tool_choice,
            forced_tool: typeof rawBody.forced_tool === "string" ? rawBody.forced_tool : undefined,
            sessionId: typeof rawBody.sessionId === "string" ? rawBody.sessionId : headers["x-session-id"],
          },
          only,
        );
        if (!attempt.ok) {
          set.status = CODES.no_provider_serves;
          return envelope("no_provider_serves", attempt.error, { model: body.model, catalog_contract: cat.contract.name });
        }

        const routedVia = `${attempt.provider}/${model}`;
        const id = `cg_${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream) {
          return createSSEStream((send, close) => {
            const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
              ({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
            send("", chunk({ role: "assistant", content: "" }, null));
            const size = 64;
            for (let i = 0; i < attempt.content.length; i += size) {
              send("", chunk({ content: attempt.content.slice(i, i + size) }, null));
            }
            send("", chunk({}, attempt.finishReason ?? "stop", attempt.usage !== undefined ? { usage: attempt.usage } : {}));
            send("", "[DONE]");
            close();
          }, { "X-Routed-Via": routedVia });
        }

        set.headers["x-routed-via"] = routedVia;
        return {
          id, object: "chat.completion", created, model: body.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: attempt.content,
              ...(attempt.toolCalls ? { tool_calls: attempt.toolCalls } : {}),
            },
            finish_reason: attempt.finishReason ?? (attempt.toolCalls ? "tool_calls" : "stop"),
          }],
          usage: attempt.usage, meta: { provider: attempt.provider, latency_ms: Math.round(attempt.latencyMs), raced: attempt.raced },
        };
      },
      { body: t.Object({ model: t.String({ minLength: 1 }), messages: t.Array(t.Object({ role: t.String(), content: t.Nullable(t.String()) }, { additionalProperties: true })), stream: t.Optional(t.Boolean()), temperature: t.Optional(t.Number()), max_tokens: t.Optional(t.Number()) }, { additionalProperties: true }) },
    );
}

/**
 * Rebuild the router's catalog from the live file. A reload replaces the map
 * (dead pairs are dropped) and honors each provider's `quarantined` list plus
 * the global `deadIds`.
 */
function seedRouter(router: Router, quarantine: Quarantine, cat: LiveCatalog): number {
  const dead = new Set(cat.deadIds.map(normalizeId));
  const pairs: [string, string][] = [];
  for (const [provider, entry] of Object.entries(cat.providers)) {
    const held = new Set(entry.quarantined.map(normalizeId));
    for (const id of entry.serving) {
      const n = normalizeId(id);
      if (dead.has(n) || held.has(n)) continue;
      pairs.push([id, provider]);
    }
  }
  for (const id of ZEN_MODELS) {
    pairs.push([id, ZEN_PROVIDER]);
    pairs.push([id, ZEN_LEGACY_PROVIDER]);
  }
  for (const id of DOTS_MODELS) {
    pairs.push([id, DOTS_PROVIDER]);
  }
  router.reseed(pairs);
  for (const [provider, entry] of Object.entries(cat.providers)) quarantine.observeListing(entry.serving, provider);
  return pairs.length;
}

export async function main(): Promise<void> {
  loadSecretsFiles();
  let config: Config;
  try { config = loadConfig(); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); }

  const gate = new ProviderGate(config);
  const quarantine = new Quarantine();
  const pauser = new Pauser();
  const ledger = new Ledger();
  let credentials: CredentialPlane | undefined;
  try {
    const pools = loadPoolsFromYaml(process.env.KEYPOOLS_YAML ?? "/home/toxic/estate/config/keypools.yaml");
    credentials = pools.length ? new CredentialPlane(pools) : undefined;
  } catch (e) { console.error(`keypool config unreadable, running without the credential plane: ${(e as Error).message}`); }

  const router = new Router(config, gate, quarantine, ledger, credentials, pauser);
  const catalogPath = process.env.CUTTINGGATE_CATALOG ?? DEFAULT_CATALOG_PATH;
  let current: CatalogLoad = loadLiveCatalog(catalogPath);
  if (current.status !== "ok") { process.stderr.write(`cuttinggate: catalog load failed: ${current.status} (${catalogPath})\n`); process.exit(1); }
  const pairs = seedRouter(router, quarantine, current.catalog);
  log.info({ catalog: current.source, providers: Object.keys(current.catalog.providers).length, serving: pairs, contract: current.contract.name }, "cuttinggate catalog seeded");

  const reload = (): CatalogLoad => {
    const next = loadLiveCatalog(catalogPath);
    if (next.status === "ok") {
      current = next;
      const added = seedRouter(router, quarantine, next.catalog);
      log.info({ serving: added, contract: next.contract.name }, "catalog reloaded");
    } else {
      log.warn({ status: next.status }, "catalog reload failed; keeping last-known-good");
    }
    return next;
  };

  // Watch for regen; swap state + reseed on change (opencode #9849 pattern).
  const watcher: CatalogWatcher = watchCatalog(catalogPath, (next) => {
    if (next.status !== "ok") return;
    current = next;
    const added = seedRouter(router, quarantine, next.catalog);
    log.info({ serving: added, contract: next.contract.name }, "catalog reloaded");
  }, 500);
  process.on("SIGHUP", () => { reload(); });
  const shutdown = (): void => { watcher.stop(); ledger.flush(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const app = buildApp({ config, gate, quarantine, ledger, router, catalogState: () => current, reload, credentials, pauser });
  app.listen({ port: config.port, hostname: config.host });
  log.info({ port: config.port, host: config.host, providers: Object.keys(config.keys) }, "cuttinggate up");
}

if (import.meta.main) await main();
