// HFT-synthesis tests for estate-scripts-router v3.2:
//  1. Speculative hedging (hedgedChain): slow first lane loses to a hedged
//     second lane, and the loser's abort is NOT recorded as a provider failure.
//  2. Model-spec normalization (router-side Openfang-shim parsing).
//  3. Exponential quarantine via synthetic probes (no Elo/DB side effects).
//  4. Latency-aware candidate scoring (EMA demotes chronic slowness).
import { describe, test, expect, afterAll } from "bun:test";

// Must be set before the router modules are imported (DB_PATH and the
// catalog state path are read once at import). The catalog path is unique
// per run: noteEntitlement404 persists quarantine to it, and a reused path
// would leak a bench into the next run.
process.env.ESTATE_DB = "/tmp/estate_router_hedge_test.db";
process.env.ESTATE_CATALOG_STATE =
  `/tmp/estate_router_hedge_test.catalog.${process.pid}.json`;

const { state } = await import("../router_matrix");
const { hedgedChain, substantive } = await import("../router_strategy");
const { PROVIDERS, normalizeModelSpec } = await import("../router_config");

const openaiOk = (tag: string) =>
  Response.json({
    id: "chatcmpl-test",
    choices: [{ index: 0, message: { role: "assistant", content: `ok:${tag}` } }],
  });

describe("latency-aware candidate scoring", () => {
  test("chronic slowness demotes a provider despite higher Elo", () => {
    state.elo.set("test-lo", 1200);
    state.emaLat.set("test-lo", 17000);
    state.elo.set("test-hi", 1000);
    state.emaLat.set("test-hi", 300);
    expect(state.candidateScore("test-hi")).toBeGreaterThan(
      state.candidateScore("test-lo"),
    );
    expect(state.latencyEmaMs("test-hi")).toBe(300);
  });

  test("EMA tracks successful completions", () => {
    state.record("m", "test-ema", 200, 1.0, 0, "test"); // 1000ms
    const first = state.latencyEmaMs("test-ema");
    expect(first).toBe(1000);
    state.record("m", "test-ema", 200, 3.0, 0, "test"); // 3000ms
    const second = state.latencyEmaMs("test-ema");
    expect(second!).toBeGreaterThan(first!);
    expect(second!).toBeLessThan(3000);
    // Failures do not move the EMA.
    state.record("m", "test-ema", 504, 8.0, 0, "test");
    expect(state.latencyEmaMs("test-ema")).toBe(second);
  });
});

describe("hedgedChain (HFT redundant-feeds)", () => {
  const slow = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((r) => setTimeout(r, 4000)); // slower than HEDGE_MS (1500)
      return openaiOk("slow");
    },
  });
  const fast = Bun.serve({
    port: 0,
    fetch: () => openaiOk("fast"),
  });
  afterAll(() => {
    slow.stop(true);
    fast.stop(true);
    delete PROVIDERS["test-slow"];
    delete PROVIDERS["test-fast"];
  });

  test("hedged second lane wins; loser abort is not a circuit strike", async () => {
    PROVIDERS["test-slow"] = {
      base: `http://127.0.0.1:${slow.port}/v1`,
      key_env: "TEST_SLOW_KEY",
      no_auth: true,
    };
    PROVIDERS["test-fast"] = {
      base: `http://127.0.0.1:${fast.port}/v1`,
      key_env: "TEST_FAST_KEY",
      no_auth: true,
    };
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4,
    };
    const t0 = performance.now();
    const r = await hedgedChain(
      [
        ["test-slow", "m"],
        ["test-fast", "m"],
      ],
      body,
      "sess-hedge",
      "test",
    );
    const dt = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(substantive(r)).toBe(true);
    expect(r.provider).toBe("test-fast");
    // Hedge fired (~1500ms), not full-parallel (~5ms) and not sequential (4000ms+).
    expect(dt).toBeGreaterThan(1000);
    expect(dt).toBeLessThan(3200);
    // The aborted loser must not take a circuit strike.
    expect(state.consecutiveFailures("test-slow")).toBe(0);
    expect(state.circuitOk("test-slow")).toBe(true);
    expect(r.timings).toBeDefined();
  });

  test("a provider with recent strikes loses the lane-0 head start", async () => {
    // test-slow leads in cands order but carries 2 strikes: it must be
    // demoted so test-fast serves immediately instead of after the hedge.
    state.record("m", "test-slow", 504, 8.0, 0, "test");
    state.record("m", "test-slow", 504, 8.0, 0, "test");
    expect(state.consecutiveFailures("test-slow")).toBe(2);
    expect(state.circuitOk("test-slow")).toBe(true); // closed, still eligible
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4,
    };
    const t0 = performance.now();
    const r = await hedgedChain(
      [
        ["test-slow", "m"],
        ["test-fast", "m"],
      ],
      body,
      "sess-demote",
      "test",
    );
    const dt = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("test-fast");
    // Demoted: fast lane led, so no 1500ms hedge wait.
    expect(dt).toBeLessThan(1000);
  });
});

describe("normalizeModelSpec (router-side Openfang shim)", () => {
  test("provider:model colon form", () => {
    const r = normalizeModelSpec("llama-swap:beellama/exaone-4-0-1-2b-iq4xs");
    expect(r.provider).toBe("llama-swap");
    expect(r.model).toContain("exaone");
  });
  test("provider/model slash form", () => {
    const r = normalizeModelSpec("nvidia/nvidia/nemotron-3-super-120b-a12b");
    expect(r.provider).toBe("nvidia");
  });
  test("bare model passes through provider-agnostic", () => {
    const r = normalizeModelSpec("auto");
    expect(r.provider).toBeNull();
  });
});

describe("recordProbe quarantine (synthetic, no Elo/DB pollution)", () => {
  test("3 consecutive probe failures open the circuit with backoff", () => {
    const p = "test-quar";
    const eloBefore = state.elo.get(p) || 1000;
    state.recordProbe(p, false, "t1");
    state.recordProbe(p, false, "t2");
    expect(state.circuitOk(p)).toBe(true); // 2 strikes: still closed
    state.recordProbe(p, false, "t3");
    const info = state.circuitInfo(p);
    expect(info.state).toBe("open");
    expect(info.quarantine_level).toBe(1);
    expect(info.backoff_s).toBeGreaterThan(0);
    expect(state.circuitOk(p)).toBe(false);
    // No Elo inflation from synthetic probes.
    expect(state.elo.get(p) || 1000).toBe(eloBefore);
    // A later success resets the strike count.
    state.recordProbe(p, true);
    expect(state.consecutiveFailures(p)).toBe(0);
  });
});
