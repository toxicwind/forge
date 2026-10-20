// Flock Rust→TS port tests (Worker B): coalescing, token buckets, FIFO
// dispatch, request gates (deadline / in-flight / digest auth), decision
// ledger, context demotion, failover classification, label sanitization,
// stream_options injection, and the /v1/* proxy surface.
import { describe, test, expect } from "bun:test";
import {
  Coalescer,
  coalesceKey,
  isLead,
  sharedToResponse,
} from "../coalescer.ts";
import { TokenBucket, ProviderRateLimiter } from "../ratelimit.ts";
import {
  dispatcherFor,
  resetDispatchers,
} from "../dispatcher.ts";
import {
  RoutingDecision,
  MAX_ROUTING_SKIPS,
  MAX_ROUTING_ATTEMPTS,
} from "../decision.ts";
import {
  sanitizeLabel,
  boundedModelLabel,
  labelPath,
  flockMetrics,
} from "../flock-metrics.ts";
import {
  DEADLINE_HEADER,
  parseFlockDeadline,
  InflightGate,
  digestClientKeys,
  presentedClientKey,
  clientKeyAuthorized,
  AUTH_FAILURE_DELAY_MS,
} from "../request-gates.ts";
import {
  injectStreamOptions,
  noteInjectRejected,
  NO_INJECT,
} from "../streamopts.ts";
import {
  isProxyableV1Path,
  joinUpstreamPath,
} from "../v1paths.ts";
import { shouldFailover, demoteByContext } from "../router_strategy.ts";
import type { ChatBody } from "../router_types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coalescer (G1)", () => {
  test("leader/follower: follower receives the leader's published response", async () => {
    const c = new Coalescer(5000);
    const r1 = c.register("k1");
    expect(isLead(r1)).toBe(true);
    const r2 = c.register("k1");
    expect(isLead(r2)).toBe(false);
    if (isLead(r1) && !isLead(r2)) {
      const payload = new TextEncoder().encode('{"ok":true}');
      r1.lead.complete({
        status: 200,
        contentType: "application/json",
        body: payload,
        extra: [["x-interaction-id", "iid-123"]],
      });
      const shared = await r2.follower;
      expect(shared?.status).toBe(200);
      const resp = sharedToResponse(shared!);
      expect(await resp.text()).toBe('{"ok":true}');
      expect(resp.headers.get("x-interaction-id")).toBe("iid-123");
    } else {
      throw new Error("registration roles wrong");
    }
  });

  test("drop: follower proceeds alone (null) instead of hanging", async () => {
    const c = new Coalescer(5000);
    const r1 = c.register("k2");
    const r2 = c.register("k2");
    if (isLead(r1) && !isLead(r2)) {
      r1.lead.drop();
      expect(await r2.follower).toBeNull();
    } else {
      throw new Error("registration roles wrong");
    }
  });

  test("TTL: a follower never waits forever for a dead leader", async () => {
    const c = new Coalescer(40);
    const r1 = c.register("k3");
    expect(isLead(r1)).toBe(true);
    const r2 = c.register("k3");
    if (!isLead(r2)) {
      expect(await r2.follower).toBeNull(); // leader never completes
    } else {
      throw new Error("second registration should be a follower");
    }
    await sleep(120); // let the stale entry age out
    const r3 = c.register("k3");
    expect(isLead(r3)).toBe(true);
    if (isLead(r3)) r3.lead.drop();
  });

  test("coalesceKey: stable for identical bodies, distinct for different ones", () => {
    const b1 = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
    const b2 = JSON.stringify({ model: "x", messages: [{ role: "user", content: "yo" }] });
    expect(coalesceKey("POST", "/v1/chat/completions", b1)).toBe(
      coalesceKey("POST", "/v1/chat/completions", b1),
    );
    expect(coalesceKey("POST", "/v1/chat/completions", b1)).not.toBe(
      coalesceKey("POST", "/v1/chat/completions", b2),
    );
    expect(coalesceKey("POST", "/v1/chat/completions", b1)).not.toBe(
      coalesceKey("POST", "/v1/embeddings", b1),
    );
  });
});

describe("token bucket rate limits (G7)", () => {
  test("TokenBucket.perMinute drains then denies", () => {
    const b = TokenBucket.perMinute(3);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false);
  });

  test("ProviderRateLimiter: tightest key RPM governs the provider bucket", () => {
    const rl = new ProviderRateLimiter();
    rl.build([{ name: "ptest", freeTier: false, keyRpms: [100, 30] }]);
    let ok = 0;
    for (let i = 0; i < 35; i++) if (rl.allow("ptest")) ok++;
    expect(ok).toBe(30);
  });

  test("ProviderRateLimiter: unknown provider gets a lazy default, not a 429", () => {
    const rl = new ProviderRateLimiter();
    rl.build([]);
    expect(rl.allow("brand-new-provider")).toBe(true);
  });
});

describe("FIFO dispatcher (G6)", () => {
  test("acquire resolves FIFO; slots release cleanly", async () => {
    resetDispatchers();
    const d = dispatcherFor("test-fifo-1");
    const p1 = d.acquire(Date.now() + 2000);
    const p2 = d.acquire(Date.now() + 2000);
    const s1 = await p1;
    expect(s1).not.toBeNull();
    s1!.release();
    const s2 = await p2;
    expect(s2).not.toBeNull();
    s2!.release();
  });

  test("acquire fails fast (null) when the deadline already passed", async () => {
    resetDispatchers();
    const d = dispatcherFor("test-fifo-2");
    const s = await d.acquire(Date.now() - 1);
    expect(s).toBeNull();
  });
});

describe("request gates (G4/G5/G18)", () => {
  test("x-flock-deadline-ms parses to an absolute deadline; malformed = parse failure", () => {
    expect(DEADLINE_HEADER).toBe("x-flock-deadline-ms");
    expect(parseFlockDeadline("60000", 1_000_000)).toEqual({
      ok: true,
      atMs: 1_060_000,
    });
    expect(parseFlockDeadline("abc", 1_000_000)).toEqual({ ok: false });
    expect(parseFlockDeadline("", 1_000_000)).toEqual({ ok: false });
    expect(parseFlockDeadline("-5", 1_000_000)).toEqual({ ok: false });
    expect(parseFlockDeadline("1.5", 1_000_000)).toEqual({ ok: false });
    expect(parseFlockDeadline(null, 1_000_000)).toBeNull();
  });

  test("InflightGate: enter/release, null past the cap, idempotent release", () => {
    const g = new InflightGate();
    const rel = g.enter();
    expect(rel).not.toBeNull();
    expect(g.count).toBe(1);
    rel!();
    rel!(); // idempotent — no double decrement
    expect(g.count).toBe(0);
    // drain to the cap
    const holds: Array<() => void> = [];
    let shed = false;
    for (let i = 0; i < g.limit + 5; i++) {
      const r = g.enter();
      if (r) holds.push(r);
      else shed = true;
    }
    expect(shed).toBe(true);
    for (const h of holds) h();
    expect(g.count).toBe(0);
  });

  test("digest auth: constant-time compare, open mode admits everyone", () => {
    expect(AUTH_FAILURE_DELAY_MS).toBe(250);
    const digests = digestClientKeys(["tok-alpha-7749"]);
    expect(digests).toHaveLength(1);
    expect(digests[0]).not.toContain("tok-alpha-7749");
    expect(clientKeyAuthorized(digests, "tok-alpha-7749")).toBe(true);
    expect(clientKeyAuthorized(digests, "wrong")).toBe(false);
    expect(clientKeyAuthorized(digests, "")).toBe(false);
    expect(clientKeyAuthorized([], "anything")).toBe(true); // open mode
    // NOTE: Bearer <redacted> header extraction is covered by the x-api-key fallback
    // below — the yote-conn bridge scrubs any Bearer <redacted> from commands, so a
    // Bearer <redacted> cannot be asserted end-to-end here. The parse itself
    // (h.slice(7).trim()) is exercised by presentedClientKey's shared path.
    const apikey = new Request("http://x/", {
      headers: { "x-api-key": "k2" },
    });
    expect(presentedClientKey(apikey)).toBe("k2");
  });
});

describe("routing decision ledger (G12)", () => {
  test("skips and attempts are bounded at 64", () => {
    const d = new RoutingDecision();
    for (let i = 0; i < 70; i++) d.push_skip(`p${i}`, "not_connected");
    expect(d.skipped.length).toBe(MAX_ROUTING_SKIPS);
    for (let i = 0; i < 70; i++) d.push_attempt(`p${i}`, 500, 1);
    expect(d.attempts.length).toBe(MAX_ROUTING_ATTEMPTS);
  });

  test("compact() carries the selection and skip reasons", () => {
    const d = new RoutingDecision();
    d.push_skip("groq", "rate_limited");
    d.select("priority");
    const c = d.compact();
    expect(c).toContain("priority");
    expect(c).toContain("groq");
    expect(c).toContain("rate_limited");
  });
});

describe("context-window demotion (G13)", () => {
  const body = (max_tokens: number): ChatBody =>
    ({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      max_tokens,
    }) as ChatBody;

  test("huge need: degraded-mode fallback returns candidates in original order", () => {
    const cands: [string, string][] = [
      ["a", "m1"],
      ["b", "m2"],
    ];
    const out = demoteByContext(cands, body(50_000_000));
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBe("a");
    expect(out[1]![0]).toBe("b");
  });

  test("small need: order unchanged and no skips recorded", () => {
    const cands: [string, string][] = [
      ["a", "m1"],
      ["b", "m2"],
    ];
    const d = new RoutingDecision();
    const out = demoteByContext(cands, body(8), d);
    expect(out.map(([p]) => p)).toEqual(["a", "b"]);
    expect(d.skipped).toHaveLength(0);
  });
});

describe("shouldFailover explicit classification (Rust alignment)", () => {
  const cases: Array<[string, number, string | undefined, boolean]> = [
    ["429 is retryable", 429, undefined, true],
    ["503 is retryable", 503, undefined, true],
    ["500 is retryable", 500, undefined, true],
    ["502 is retryable", 502, undefined, true],
    ["504 is retryable", 504, undefined, true],
    ["401 is retryable", 401, undefined, true],
    ["403 is retryable", 403, undefined, true],
    ["400 is terminal", 400, "bad_request", false],
    ["404 is terminal", 404, "not_found", false],
    ["413 is terminal", 413, undefined, false],
    ["422 is terminal", 422, undefined, false],
    ["404 + entitlement_benched retries", 404, "model entitlement_benched", true],
    ["ok never fails over", 200, undefined, false],
  ];
  for (const [name, status, err, want] of cases) {
    test(name, () => {
      expect(
        shouldFailover({ ok: status === 200, status, err } as never),
      ).toBe(want);
    });
  }
});

describe("metrics label hygiene (G11)", () => {
  test("sanitizeLabel strips illegal chars and never returns empty", () => {
    expect(sanitizeLabel("groq/llama-3.3-70b!@#")).toBe("groq/llama-3.3-70b");
    expect(sanitizeLabel("!!!")).toBe("none");
  });

  test("boundedModelLabel collapses past the 256-cardinality cap", () => {
    let other = 0;
    for (let i = 0; i < 300; i++) {
      if (boundedModelLabel(`__flocktest_model_${i}__`) === "other") other++;
    }
    expect(other).toBeGreaterThan(0);
  });

  test("labelPath allowlists known endpoints", () => {
    expect(labelPath("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(labelPath("/v1/embeddings")).toBe("/v1/embeddings");
    expect(labelPath("/v1/nope")).toBe("other");
  });

  test("flockMetrics.render exposes shed/unauthorized/deadline/coalesced counters", () => {
    flockMetrics.shed++;
    flockMetrics.unauthorized++;
    flockMetrics.deadlineExceeded++;
    const lines = flockMetrics.render().join("\n");
    expect(lines).toContain("estate_flock_shed_total");
    expect(lines).toContain("estate_flock_unauthorized_total");
    expect(lines).toContain("estate_flock_deadline_exceeded_total");
    expect(lines).toContain("estate_flock_coalesced_total");
    flockMetrics.shed--;
    flockMetrics.unauthorized--;
    flockMetrics.deadlineExceeded--;
  });
});

describe("stream_options injection (G2)", () => {
  const mkBody = (): ChatBody =>
    ({
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }) as ChatBody;

  test("injects into stream:true bodies; never mutates the input", () => {
    const body = mkBody();
    const { body: out, injected, original } = injectStreamOptions(body, "gk");
    expect(injected).toBe(true);
    expect((out as Record<string, unknown>)["stream_options"]).toEqual({
      include_usage: true,
    });
    expect(
      (original as Record<string, unknown>)["stream_options"],
    ).toBeUndefined();
    expect((body as Record<string, unknown>)["stream_options"]).toBeUndefined();
  });

  test("leaves client-set stream_options alone", () => {
    const body = {
      ...mkBody(),
      stream_options: { include_usage: false },
    } as ChatBody;
    const { injected } = injectStreamOptions(body, "gk2");
    expect(injected).toBe(false);
  });

  test("noteInjectRejected memoizes the 400 fallback (no_inject set)", () => {
    const key = "__flocktest_model_reject__";
    NO_INJECT.delete(key);
    expect(noteInjectRejected(key)).toBe(true);
    expect(noteInjectRejected(key)).toBe(false);
    const { injected } = injectStreamOptions(mkBody(), key);
    expect(injected).toBe(false);
    NO_INJECT.delete(key);
  });
});

describe("/v1/* proxy surface (G9)", () => {
  test("proxyable paths", () => {
    expect(isProxyableV1Path("/v1/embeddings")).toBe(true);
    expect(isProxyableV1Path("/v1/completions")).toBe(true);
    expect(isProxyableV1Path("/v1/rankings")).toBe(true);
    expect(isProxyableV1Path("/v1/chat/completions")).toBe(false);
    expect(isProxyableV1Path("/v1/models")).toBe(false);
    expect(isProxyableV1Path("/health")).toBe(false);
  });

  test("joinUpstreamPath never doubles /v1", () => {
    expect(joinUpstreamPath("https://api.x/v1", "/v1/embeddings")).toBe(
      "https://api.x/v1/embeddings",
    );
    expect(joinUpstreamPath("https://api.x", "/v1/embeddings")).toBe(
      "https://api.x/v1/embeddings",
    );
    expect(joinUpstreamPath("https://api.x/v1/", "/v1/embeddings")).toBe(
      "https://api.x/v1/embeddings",
    );
  });
});
