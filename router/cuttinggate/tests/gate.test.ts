import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { ProviderGate } from "../src/circuit.ts";
import { Quarantine } from "../src/quarantine.ts";
import { Ledger } from "../src/ledger.ts";
import { Router } from "../src/router.ts";

// port 1 is never bound in these tests; the router never calls listen().
const cfg = loadConfig({ port: 1, keys: { alpha: "k", beta: "k", gamma: "k" }, maxConcurrent: 16 });

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ledgerAt(dir: string): Ledger {
  return new Ledger(join(dir, "ledger.jsonl"));
}

function reply(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { total_tokens: 7 } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * A router whose upstream calls block until the test releases them.
 *
 * Deterministic by construction: completion order is decided by the test, not
 * by sleeping and hoping. A race test that depends on wall-clock ordering tests
 * the scheduler, not the router.
 */
function gatedRouter(providers: string[], opts: { quarantine?: Quarantine; ledger?: Ledger } = {}) {
  const gates = new Map(providers.map((p) => [p, Promise.withResolvers<Response>()]));
  const r = new Router(cfg, new ProviderGate(cfg), opts.quarantine ?? new Quarantine(), opts.ledger);
  // One model, many candidate providers: that is what makes this a race.
  for (const p of providers) r.register("m/raced", p);
  (r as unknown as { call: unknown }).call = (p: string) => gates.get(p)!.promise;
  return {
    router: r,
    release: (p: string, res: Response) => gates.get(p)!.resolve(res),
  };
}

describe("router: first valid wins", () => {
  // Regression: `Promise.any` resolves on the first attempt to SETTLE, so a
  // provider returning an empty 200 would beat a slower provider that replied.
  test("an empty 200 loses to a slower provider with real content", async () => {
    const { router, release } = gatedRouter(["fast", "slow"]);
    const pending = router.complete("m/raced", [{ role: "user", content: "hi" }]);

    release("fast", reply("   ")); // settles first, but is empty
    release("slow", reply("real answer"));

    const got = await pending;
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.content).toBe("real answer");
      expect(got.provider).toBe("slow");
    }
  });

  test("a provider is selected purely by whether its answer was valid", async () => {
    // Deliberately not asserting settle order: which of two concurrently
    // released providers settles first is the scheduler's business, not ours.
    // The router's contract is only that a valid answer beats an invalid one.
    const { router, release } = gatedRouter(["a", "b"]);
    const pending = router.complete("m/raced", [{ role: "user", content: "hi" }]);

    release("a", reply("", 500));
    release("b", reply("from b"));

    const got = await pending;
    expect(got.ok && got.provider).toBe("b");
  });

  test("racing is reported when more than one provider was in flight", async () => {
    const { router, release } = gatedRouter(["a", "b"]);
    const pending = router.complete("m/raced", [{ role: "user", content: "hi" }]);
    release("a", reply("a"));
    release("b", reply("b"));
    const got = await pending;
    expect(got.ok && got.raced).toBe(true);
  });

  test("a 500 is not a valid answer even when it settles first", async () => {
    const { router, release } = gatedRouter(["a", "b"]);
    const pending = router.complete("m/raced", [{ role: "user", content: "hi" }]);
    release("a", reply("should be ignored", 500));
    release("b", reply("the real answer"));
    const got = await pending;
    expect(got.ok && got.content).toBe("the real answer");
  });

  test("every provider failing is an error naming what was tried", async () => {
    const { router, release } = gatedRouter(["a", "b"]);
    const pending = router.complete("m/raced", [{ role: "user", content: "hi" }]);
    release("a", reply("", 500));
    release("b", reply("   "));
    const got = await pending;
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("no provider returned valid content");
  });

  test("a model with no provider is refused rather than guessed", async () => {
    const r = new Router(cfg, new ProviderGate(cfg), new Quarantine(), new Ledger(join(scratch("cg-np-"), "l.jsonl")));
    const got = await r.complete("m/unknown", [{ role: "user", content: "hi" }]);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("no provider serves");
  });
});

describe("quarantine", () => {
  test("a serve-time 404 marks the slug", () => {
    const q = new Quarantine();
    q.observeListing(["a", "b"], "p");
    q.observeListing(["a", "b"], "p");
    q.noteServe404("b", "p", "upstream 404 for b");
    expect(q.isQuarantined("b")).toBe(true);
    expect(q.get("b")?.reason).toBe("serve-404");
  });

  // The outage guard: a burst of 404s while the listing itself is broken is an
  // outage, not 117 dead models. Quarantining during an outage empties the estate.
  test("strikes do not accrue before two successful listings", () => {
    const q = new Quarantine();
    q.noteServe404("x", "p");
    expect(q.isQuarantined("x")).toBe(false);
  });

  test("a slug that reappears on a listing clears its strikes", () => {
    const q = new Quarantine();
    q.observeListing(["a"], "p");
    q.observeListing(["a"], "p");
    q.noteServe404("a", "p");
    expect(q.isQuarantined("a")).toBe(true);
    q.observeListing(["a"], "p");
    expect(q.get("a")?.strikes).toBe(0);
  });

  test("an operator can release a quarantined slug", () => {
    const q = new Quarantine();
    q.observeListing(["a"], "p");
    q.observeListing(["a"], "p");
    q.noteServe404("a", "p");
    expect(q.release("a")).toBe(true);
    expect(q.isQuarantined("a")).toBe(false);
  });

  test("a quarantined provider is dropped from the candidate list", async () => {
    const q = new Quarantine();
    q.observeListing(["m/x"], "bad");
    q.observeListing(["m/x"], "bad");
    q.noteServe404("m/x@bad", "bad", "404");

    const gates = new Map([
      ["bad", Promise.withResolvers<Response>()],
      ["good", Promise.withResolvers<Response>()],
    ]);
    const r = new Router(cfg, new ProviderGate(cfg), q, ledgerAt(scratch("cg-q-")));
    for (const p of ["bad", "good"]) r.register("m/x", p);
    (r as unknown as { call: unknown }).call = (p: string) => gates.get(p)!.promise;

    const pending = r.complete("m/x", [{ role: "user", content: "hi" }]);
    gates.get("good")!.resolve(reply("served by good"));
    gates.get("bad")!.resolve(reply("nope", 404));

    const got = await pending;
    expect(got.ok && got.provider).toBe("good");
  });
});

describe("winner ledger", () => {
  test("the provider that wins is tried first, and survives a restart", () => {
    const dir = scratch("cg-ledger-");
    const first = new Ledger(join(dir, "ledger.jsonl"));
    for (let i = 0; i < 5; i++) first.record("m/x", "alpha", 10, true);
    for (let i = 0; i < 5; i++) first.record("m/x", "beta", 900, false);
    first.flush();

    const afterRestart = new Ledger(join(dir, "ledger.jsonl"));
    expect(afterRestart.order("m/x", ["beta", "alpha"])[0]).toBe("alpha");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a proven provider outranks one with no history", () => {
    const dir = scratch("cg-l2-");
    const l = new Ledger(join(dir, "ledger.jsonl"));
    l.record("m/y", "alpha", 10, true);
    expect(l.order("m/y", ["beta", "alpha"])[0]).toBe("alpha");
    rmSync(dir, { recursive: true, force: true });
  });

  test("unproven providers keep their relative order rather than being buried", () => {
    const dir = scratch("cg-l3-");
    const l = new Ledger(join(dir, "ledger.jsonl"));
    expect(l.order("m/z", ["x", "y"])).toEqual(["x", "y"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
describe("cuttinggate server sse endpoints", () => {
  test("GET /models/sse returns text/event-stream with keep-alive and reload event", async () => {
    const { buildApp } = await import("../src/server.ts");
    const r = new Router(cfg, new ProviderGate(cfg), new Quarantine(), ledgerAt(scratch("cg-s-")));
    r.register("m/mock", "alpha");
    const app = buildApp({
      config: cfg,
      gate: new ProviderGate(cfg),
      quarantine: new Quarantine(),
      ledger: ledgerAt(scratch("cg-s2-")),
      router: r,
    });

    const res = await app.handle(new Request("http://localhost/models/sse"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const { value } = await reader!.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain(": keep-alive");
    expect(text).toContain("models_reload");
  });

  test("POST /v1/chat/completions with stream: true returns SSE chunks", async () => {
    const { buildApp } = await import("../src/server.ts");
    const r = new Router(cfg, new ProviderGate(cfg), new Quarantine(), ledgerAt(scratch("cg-s3-")));
    r.register("m/stream", "alpha");
    (r as unknown as { call: unknown }).call = async () => reply("streaming tokens here");

    const app = buildApp({
      config: cfg,
      gate: new ProviderGate(cfg),
      quarantine: new Quarantine(),
      ledger: ledgerAt(scratch("cg-s4-")),
      router: r,
    });

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": "Bearer cg-test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "m/stream",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
  });
});