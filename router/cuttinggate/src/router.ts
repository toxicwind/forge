/**
 * Model routing: which provider serves this request.
 *
 * Rule set, in order:
 *   1. A quarantined (model, provider) pair never leaves the building.
 *   2. Candidates are ordered by the winner ledger.
 *   3. Candidates race for the first *valid* answer. A 200 with empty content
 *      is a failure wearing a 200; a non-2xx is an error, never "empty".
 *   4. A serve-time 404 marks the slug.
 *
 * Breaker contract (see circuit.ts): an attempt THROWS (AttemptFailure) only
 * for failures that indict the provider: network/timeout, 5xx, 401/402/403.
 * 429s, model-level 404s, empties, key-pool exhaustion and race-cancelled
 * attempts RETURN, so they never open the provider's breaker.
 *
 * Keys are claimed per attempt and passed down; nothing per-provider is stored
 * on the instance, so concurrent requests cannot misattribute outcomes. The
 * keypool hands out env-var NAMES; the secret is resolved here.
 *
 * Clocks: every upstream attempt carries AbortSignal.timeout(ATTEMPT_MS); the
 * race loop wakes on settle OR the hard-ceiling timer (cleared every wake).
 */
import type { Config } from "./config.ts";
import { ProviderGate } from "./circuit.ts";
import { Quarantine } from "./quarantine.ts";
import { KeyPoolExhaustedError, type CredentialPlane } from "./keypool.ts";
import { Ledger } from "./ledger.ts";
import { COPILOT_PROVIDER, COPILOT_LEGACY_PROVIDER, CopilotClient, copilotHeaders } from "./copilot.ts";
import { ZEN_PROVIDER, ZEN_LEGACY_PROVIDER, ZEN_BASE_URL, foldZenSse, zenBody, zenHeaders } from "./zen.ts";
import { DOTS_PROVIDER, DOTS_LEGACY_PROVIDER, DOTS_MODEL, dotsBody, type DotsMessage, type DotsTool } from "./dots.ts";
import { Pauser } from "./pauser.ts";

export type KnownModel = { id: string; provider: string };

export type Attempt =
  | { ok: true; content: string; provider: string; latencyMs: number; raced: boolean; finishReason?: string; usage?: unknown; toolCalls?: unknown }
  | { ok: false; error: string };

export type ChatRequest = {
  model: string;
  messages: { role: string; content: string | null }[];
  temperature?: number;
  max_tokens?: number;
  tools?: DotsTool[];
  tool_choice?: unknown;
  forced_tool?: string;
  sessionId?: string;
};

/** One settled attempt, unblinded: every way an attempt can end is its own state. */
type Outcome =
  | { readonly kind: "valid"; readonly provider: string; readonly content: string; readonly finishReason?: string; readonly usage?: unknown; readonly toolCalls?: unknown; readonly latencyMs: number; readonly status: number }
  | { readonly kind: "empty"; readonly provider: string; readonly latencyMs: number; readonly status: number }
  | { readonly kind: "provider-error"; readonly provider: string; readonly latencyMs: number; readonly status: number; readonly error: string; readonly trip: boolean }
  | { readonly kind: "gate-rejected"; readonly provider: string; readonly error: string }
  | { readonly kind: "cancelled"; readonly provider: string };

type Valid = Extract<Outcome, { kind: "valid" }>;
type Failed = Extract<Outcome, { kind: "provider-error" }>;

/** Thrown inside the gate so the breaker counts it; carries the real outcome. */
class AttemptFailure extends Error {
  constructor(readonly outcome: Failed) {
    super(outcome.error);
    this.name = "AttemptFailure";
  }
}

/** Upstream 200 body shape: "content" (or tool_calls) vs "no content" vs "junk". */
type BodyInput = {
  choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }[];
  usage?: unknown;
} | null;

type BodyShape =
  | { readonly kind: "ok"; readonly content: string; readonly finishReason?: string; readonly usage?: unknown; readonly toolCalls?: unknown }
  | { readonly kind: "empty"; readonly finishReason?: string; readonly usage?: unknown }
  | { readonly kind: "malformed" };

function parseBody(body: BodyInput): BodyShape {
  if (!body) return { kind: "malformed" };
  const choice = body.choices?.[0];
  if (!choice) return { kind: "empty" };
  const content = choice.message?.content;
  const toolCalls = choice.message?.tool_calls;
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
  if ((!content || typeof content !== "string" || content.trim() === "") && !hasTools) {
    return { kind: "empty", finishReason: choice.finish_reason, usage: body.usage };
  }
  return {
    kind: "ok",
    content: typeof content === "string" ? content : "",
    finishReason: choice.finish_reason,
    usage: body.usage,
    ...(hasTools ? { toolCalls } : {}),
  };
}

const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const HARD_CEILING_MS = envMs("CUTTINGGATE_DEADLINE_MS", 120_000);
const ATTEMPT_MS = envMs("CUTTINGGATE_ATTEMPT_MS", 60_000);
const ZEN_ATTEMPT_MS = 12_000;

/** Statuses that say something about the KEY (reported to the credential plane). */
const KEY_FAULTS = new Set([401, 402, 403, 429]);

/** Statuses that indict the provider and so count against its breaker. */
const tripsBreaker = (status: number): boolean =>
  status >= 500 || status === 401 || status === 402 || status === 403;

export class Router {
  private catalog = new Map<string, Set<string>>();
  private readonly ledger: Ledger;
  private copilot?: CopilotClient;

  constructor(
    private readonly config: Config,
    private readonly gate: ProviderGate,
    private readonly quarantine: Quarantine,
    ledger?: Ledger,
    private readonly credentials?: CredentialPlane,
    private readonly pauser?: Pauser,
  ) {
    this.ledger = ledger ?? new Ledger();
  }

  setCopilot(client: CopilotClient): void { this.copilot = client; }

  starved(): { provider: string; reason: string }[] {
    if (!this.credentials) return [];
    const providers = new Set([...this.catalog.values()].flatMap((s) => [...s]));
    return [...providers]
      .filter((p) => this.credentials!.usable(p, { paid: false }).length === 0)
      .map((provider) => {
        const keys = this.credentials!.snapshot().find((e) => e.upstream === provider)?.keys ?? [];
        const statuses = [...new Set(keys.map((k) => k.lastStatus).filter((s): s is number => s !== null))];
        return {
          provider,
          reason: `no healthy key (tried ${keys.map((k) => k.name).join(", ") || "none configured"}, statuses ${statuses.join(", ") || "none"})`,
        };
      });
  }

  register(model: string, provider: string): void {
    const set = this.catalog.get(model);
    if (set) set.add(provider);
    else this.catalog.set(model, new Set([provider]));
  }

  /** Atomically replace the whole catalog (a reload must also DROP dead pairs). */
  reseed(pairs: Iterable<readonly [string, string]>): void {
    const next = new Map<string, Set<string>>();
    for (const [model, provider] of pairs) {
      const set = next.get(model);
      if (set) set.add(provider);
      else next.set(model, new Set([provider]));
    }
    this.catalog = next;
  }

  known(): KnownModel[] {
    return [...this.catalog.entries()].flatMap(([id, providers]) => [...providers].map((provider) => ({ id, provider })));
  }

  providers(): string[] {
    return [...new Set([...this.catalog.values()].flatMap((s) => [...s]))];
  }

  servingFor(provider: string): string[] {
    return [...this.catalog.entries()].filter(([, s]) => s.has(provider)).map(([id]) => id);
  }

  serves(model: string, provider?: string): boolean {
    const set = this.catalog.get(model);
    if (!set) return false;
    return provider === undefined ? set.size > 0 : set.has(provider);
  }

  private candidates(model: string, only?: string): string[] {
    const set = this.catalog.get(model);
    if (!set) return [];
    let list = [...set];
    if (only) list = list.filter((p) => p === only);
    // Quarantine is keyed by model and remembers WHICH provider 404'd: only that
    // pair is benched, the same model on another provider still serves.
    const q = this.quarantine.get(model);
    list = list.filter((p) => !(q && q.provider === p));
    // Paused models/providers are skipped until their pause lifts.
    if (this.pauser) {
      list = list.filter((p) => !this.pauser!.isPaused(model, p));
    }
    return this.ledger.order(model, list);
  }

  /** Claim a key for this one attempt. Returned, never stored on the instance. */
  private claimKey(provider: string): { name: string | null; secret: string } {
    if (this.credentials?.hasPool(provider)) {
      // Throws KeyPoolExhaustedError with a diagnosable message when no key is healthy.
      const name = this.credentials.claim(provider, { paid: false });
      return { name, secret: process.env[name] ?? "" };
    }
    return { name: null, secret: this.config.keys[provider] ?? "" };
  }

  private reportOutcome(provider: string, keyName: string | null, status: number | null, error?: string): void {
    if (!this.credentials || !keyName) return;
    const ok = status !== null && status >= 200 && status < 300;
    const keyFault = status === null || KEY_FAULTS.has(status);
    // Other statuses (400/404/5xx...) say nothing about the key: do not cool it.
    if (ok || keyFault) this.credentials.note(provider, keyName, status, error);
  }

  protected async call(provider: string, req: ChatRequest, signal: AbortSignal, key = ""): Promise<Response> {
    if (provider === COPILOT_PROVIDER || provider === COPILOT_LEGACY_PROVIDER) return this.callCopilot(req, signal);
    if (provider === ZEN_PROVIDER || provider === ZEN_LEGACY_PROVIDER) return this.callZen(req, signal, key);
    if (provider === DOTS_PROVIDER || provider === DOTS_LEGACY_PROVIDER || req.model === "custom/dots" || req.model === DOTS_MODEL) {
      return this.callDots(provider, req, signal, key);
    }

    const base = this.config.bases[provider];
    if (!base) throw new Error(`no base url for provider ${provider}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    return fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.model, messages: req.messages, temperature: req.temperature, max_tokens: req.max_tokens }),
      signal,
    });
  }

  private async callDots(provider: string, req: ChatRequest, signal: AbortSignal, key: string): Promise<Response> {
    const base = this.config.bases[provider] ?? this.config.bases[DOTS_PROVIDER] ?? this.config.bases["openrouter"] ?? "https://openrouter.ai/api/v1";
    const resolvedKey = key || this.config.keys[DOTS_PROVIDER] || this.config.keys["openrouter"] || "";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (resolvedKey) headers.authorization = `Bearer ${resolvedKey}`;
    const payload = dotsBody(req.messages as DotsMessage[], {
      sessionId: req.sessionId,
      tools: req.tools,
      tool_choice: req.tool_choice,
      forced_tool: req.forced_tool,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
    });
    return fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }

  private async callZen(req: ChatRequest, signal: AbortSignal, key: string): Promise<Response> {
    if (!key) throw new Error("zen: no API key configured (set ZEN_API_KEY or OPENCODE_API_KEY)");
    const normMsgs = req.messages.map((m) => ({ role: m.role, content: m.content ?? "" }));
    const res = await fetch(`${ZEN_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: zenHeaders(key),
      body: JSON.stringify(zenBody(req.model, normMsgs, { temperature: req.temperature, max_tokens: req.max_tokens })),
      signal: AbortSignal.any([signal, AbortSignal.timeout(ZEN_ATTEMPT_MS)]),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 500);
      return new Response(
        JSON.stringify({ error: { message: errText, type: "zen_upstream", status: res.status } }),
        { status: res.status, headers: { "content-type": "application/json" } },
      );
    }
    const { content, finishReason } = foldZenSse(await res.text());
    return new Response(
      JSON.stringify({
        id: `zen_${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason ?? "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  private async callCopilot(req: ChatRequest, signal: AbortSignal): Promise<Response> {
    const client = this.copilot;
    if (!client) throw new Error("copilot is routed but no account token is configured");
    const [credential, host] = await Promise.all([client.credential(), client.host()]);
    return fetch(`${host}/chat/completions`, {
      method: "POST",
      headers: copilotHeaders(credential),
      body: JSON.stringify({ model: req.model, messages: req.messages, temperature: req.temperature, max_tokens: req.max_tokens }),
      signal,
    });
  }

  /** One upstream attempt. Never throws; every ending is an Outcome. */
  private async attempt(provider: string, req: ChatRequest, raceSignal: AbortSignal): Promise<Outcome> {
    // A job that sat in the limiter queue past the race must not burn quota.
    if (raceSignal.aborted) return { kind: "cancelled", provider };
    const t0 = performance.now();
    const elapsed = (): number => performance.now() - t0;
    let keyName: string | null = null;
    try {
      const claim = this.claimKey(provider);
      keyName = claim.name;
      const signal = AbortSignal.any([raceSignal, AbortSignal.timeout(ATTEMPT_MS)]);
      const res = await this.call(provider, req, signal, claim.secret);
      this.reportOutcome(provider, keyName, res.status);
      if (res.status === 404) this.quarantine.noteServe404(req.model, provider, `upstream 404 for ${req.model}`);

      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 200);
        return {
          kind: "provider-error", provider, latencyMs: elapsed(), status: res.status,
          error: text ? `http_${res.status}: ${text}` : `http_${res.status}`,
          trip: tripsBreaker(res.status),
        };
      }

      const shape = parseBody((await res.json().catch(() => null)) as BodyInput);
      if (raceSignal.aborted) return { kind: "cancelled", provider };
      if (shape.kind === "ok") {
        return { kind: "valid", provider, content: shape.content, finishReason: shape.finishReason, usage: shape.usage, toolCalls: shape.toolCalls, latencyMs: elapsed(), status: res.status };
      }
      if (shape.kind === "empty") return { kind: "empty", provider, latencyMs: elapsed(), status: res.status };
      return { kind: "provider-error", provider, latencyMs: elapsed(), status: res.status, error: "malformed_body", trip: false };
    } catch (e) {
      if (raceSignal.aborted) return { kind: "cancelled", provider };
      if (e instanceof KeyPoolExhaustedError) {
        return { kind: "provider-error", provider, latencyMs: elapsed(), status: 0, error: e.message, trip: false };
      }
      const error = e instanceof Error ? e.message : String(e);
      this.reportOutcome(provider, keyName, null, error);
      return { kind: "provider-error", provider, latencyMs: elapsed(), status: 0, error, trip: true };
    }
  }

  /** Runs inside the gate: throws for breaker-relevant failures, returns the rest. */
  private async dispatch(provider: string, req: ChatRequest, raceSignal: AbortSignal): Promise<Outcome> {
    const r = await this.attempt(provider, req, raceSignal);
    if (r.kind === "provider-error" && r.trip) throw new AttemptFailure(r);
    return r;
  }

  private fromRejection(provider: string, e: unknown): Outcome {
    if (e instanceof AttemptFailure) return e.outcome;
    return { kind: "gate-rejected", provider, error: e instanceof Error ? e.message : String(e) };
  }

  async complete(
    model: string,
    messages: { role: string; content: string | null }[],
    extra: Partial<ChatRequest> = {},
    only?: string,
  ): Promise<Attempt> {
    const req: ChatRequest = { ...extra, model, messages };
    const providers = this.candidates(model, only);
    if (!providers.length) return { ok: false, error: `no provider serves ${model}${only ? ` on ${only}` : ""}` };

    const started = performance.now();
    const deadline = started + HARD_CEILING_MS;
    const race = new AbortController();
    const inbox: Outcome[] = [];
    let wake: (() => void) | null = null;
    let pending = providers.length;

    const post = (r: Outcome): void => {
      if (r.kind === "valid" || r.kind === "empty" || r.kind === "provider-error") {
        this.ledger.record(model, r.provider, r.latencyMs, r.kind === "valid");
      }
      if (r.kind === "empty") this.gate.noteEmpty(model);
      // First-class pause: provider errors/timeouts pause the model;
      // red herrings (404, 429, 400, 401/2/3) never trigger a pause.
      if (r.kind === "provider-error" && this.pauser) {
        this.pauser.noteFailure(model, r.provider, r.status, r.error);
      }
      inbox.push(r);
      pending -= 1;
      wake?.();
    };

    for (const provider of providers) {
      // Track attempt for cascade failure-rate denominator.
      this.pauser?.noteAttempt(model, provider);
      this.gate
        .run(provider, () => this.dispatch(provider, req, race.signal))
        .then(post, (e: unknown) => post(this.fromRejection(provider, e)));
    }

    let winner: Valid | null = null;
    const failures: string[] = [];

    while (!winner && (pending > 0 || inbox.length > 0)) {
      if (!inbox.length) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          failures.push("deadline exceeded");
          break;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        wake = resolve;
        const timer = setTimeout(resolve, remaining);
        await promise;
        clearTimeout(timer);
        wake = null;
      }
      for (const r of inbox.splice(0)) {
        if (r.kind === "valid") winner ??= r;
        else if (r.kind === "empty") failures.push(`${r.provider}: empty content`);
        else if (r.kind === "provider-error" || r.kind === "gate-rejected") failures.push(`${r.provider}: ${r.error}`);
      }
    }
    race.abort();

    if (winner) {
      return {
        ok: true,
        content: winner.content,
        provider: winner.provider,
        latencyMs: performance.now() - started,
        raced: providers.length > 1,
        finishReason: winner.finishReason,
        usage: winner.usage,
        ...(winner.toolCalls ? { toolCalls: winner.toolCalls } : {}),
      };
    }
    return {
      ok: false,
      error: failures.length
        ? `no provider returned valid content for ${model} (${failures.join("; ")})`
        : `no provider returned valid content (tried ${providers.join(", ")})`,
    };
  }
}
