// router-max tests (2026-10-02): auto-switch on failure, auto-load discovery
// helpers, bodybuilder 2M handling, stickiness opt-in, bench-prior weights,
// task classification, cost tiers. Pure-logic: no network, no provider keys.
import { describe, test, expect } from "bun:test";

// Must be set before the router modules are imported (DB_PATH and the
// catalog state path are read once at import).
process.env.ESTATE_DB = "/tmp/estate_router_max_test.db";
process.env.ESTATE_CATALOG_STATE =
  `/tmp/estate_router_max_test.catalog.${process.pid}.json`;

const {
  shouldFailover,
  sequentialFailover,
  routeFreeChain,
  chunkJobText,
  buildBodybuilderRequests,
  resolveLongctx2MModel,
  LONGCTX_2M_PROVIDER,
  LONGCTX_2M_MODEL,
  ROUTERS,
} = await import("../router_strategy");
const { classifyTask, costTier, parseStickyOpt } = await import(
  "../router_config"
);
const { resolveSigmaAlias } = await import("../sigma-enrich");
const { state } = await import("../router_matrix");
const {
  loadBenchPriorsFile,
  qualityBonus,
  benchModelBonus,
} = await import("../bench-priors");

const okBody = (content: string) => ({
  ok: true as const,
  status: 200,
  provider: "p",
  model: "m",
  lat: 0.2,
  data: JSON.stringify({ choices: [{ message: { content } }] }),
});

describe("classifyTask", () => {
  test("code-shaped text -> code", () => {
    expect(classifyTask("def foo():\n    return 42")).toBe("code");
    expect(classifyTask("```python\nprint(1)\n```")).toBe("code");
  });
  test("deliberative text -> reasoning", () => {
    expect(classifyTask("Prove that P != NP step by step")).toBe("reasoning");
    expect(
      classifyTask("Explain why the trade-off favors latency here"),
    ).toBe("reasoning");
  });
  test("plain chat -> chat", () => {
    expect(classifyTask("what is the weather today")).toBe("chat");
    expect(classifyTask("")).toBe("chat");
  });
});

describe("costTier", () => {
  test(":free suffix convention -> free (no live metadata in test env)", () => {
    expect(costTier("openrouter", "some-model:free")).toBe("free");
  });
  test("local zero-cost lane -> free even without :free suffix", () => {
    expect(costTier("llama-swap", "beellama/exaone-4-0-1-2b-iq4xs")).toBe("free");
  });
  test("sigma cost <= $1/1M -> cheap", () => {
    expect(costTier("baseten", "moonshotai/Kimi-K2.6")).toBe("cheap");
  });
  test("unknown pricing -> standard", () => {
    expect(costTier("openrouter", "x-ai/grok-4.20")).toBe("standard");
  });
});

describe("parseStickyOpt", () => {
  test("parses opt-in/out/null", () => {
    expect(parseStickyOpt("1")).toBe(true);
    expect(parseStickyOpt("true")).toBe(true);
    expect(parseStickyOpt("0")).toBe(false);
    expect(parseStickyOpt("false")).toBe(false);
    expect(parseStickyOpt(null)).toBe(null);
    expect(parseStickyOpt("banana")).toBe(null);
  });
});

describe("sticky opt-out (state-level)", () => {
  test("opt-out suppresses sticky read and write", () => {
    const sid = `rmax-sticky-${Date.now()}`;
    state.setStickyOpt(sid, true);
    state.stickySet(sid, "p1", "m1");
    expect(state.stickyGet(sid)).toEqual(["p1", "m1"]);
    state.setStickyOpt(sid, false);
    expect(state.stickyGet(sid)).toEqual([null, null]);
    state.stickySet(sid, "p2", "m2"); // suppressed
    expect(state.stickyGet(sid)).toEqual([null, null]);
    state.setStickyOpt(sid, null); // clear
  });
});

describe("shouldFailover", () => {
  test("429/5xx/timeout/entitlement -> failover", () => {
    expect(shouldFailover({ ok: false, status: 429, err: "rate_limited" })).toBe(true);
    expect(shouldFailover({ ok: false, status: 503, err: "boom" })).toBe(true);
    expect(shouldFailover({ ok: false, status: 504, err: "attempt_timeout" })).toBe(true);
    expect(
      shouldFailover({ ok: false, status: 404, err: "entitlement_benched" }),
    ).toBe(true);
  });
  test("400 malformed -> terminal", () => {
    expect(shouldFailover({ ok: false, status: 400, err: "bad_request" })).toBe(false);
    expect(shouldFailover({ ok: true, status: 200 })).toBe(false);
  });
});

describe("sequentialFailover", () => {
  const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };

  test("429 on first candidate switches to second without failing", async () => {
    const calls: string[] = [];
    const fake = async (p: string, mid: string) => {
      calls.push(`${p}/${mid}`);
      if (calls.length === 1)
        return { ok: false as const, status: 429, provider: p, lat: 0.1, err: "rate_limited" };
      return okBody("second wins");
    };
    const r = await sequentialFailover(
      [["llama-swap", "m1"], ["llama-swap", "m2"]],
      body,
      "rmax-seq-1",
      "test_chain",
      fake as never,
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["llama-swap/m1", "llama-swap/m2"]);
    expect(r.switches).toBe(1);
    expect(r.switch_log?.length).toBe(1);
    expect(r.switch_log?.[0]).toMatch(/m1 -> .*m2/);
  });

  test("400 terminal stops the chain after one call", async () => {
    const calls: string[] = [];
    const fake = async (p: string, mid: string) => {
      calls.push(`${p}/${mid}`);
      return { ok: false as const, status: 400, provider: p, lat: 0.05, err: "bad_request" };
    };
    const r = await sequentialFailover(
      [["llama-swap", "m1"], ["llama-swap", "m2"]],
      body,
      "rmax-seq-2",
      "test_chain",
      fake as never,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(calls.length).toBe(1);
    expect(r.switches).toBe(0);
  });

  test("all candidates fail -> last error reported", async () => {
    const fake = async (p: string) => ({
      ok: false as const,
      status: 503,
      provider: p,
      lat: 0.1,
      err: "down",
    });
    const r = await sequentialFailover(
      [["llama-swap", "m1"], ["llama-swap", "m2"]],
      body,
      "rmax-seq-3",
      "test_chain",
      fake as never,
    );
    expect(r.ok).toBe(false);
    expect(r.switches).toBe(1);
    expect(r.err).toBe("down");
  });
});

describe("chunkJobText", () => {
  test("short job -> single chunk", () => {
    expect(chunkJobText("hello", 100)).toEqual(["hello"]);
  });
  test("splits at paragraph boundaries, drops nothing", () => {
    const paras = Array.from({ length: 10 }, (_, i) => `para ${i} ` + "x".repeat(90));
    const job = paras.join("\n\n");
    const chunks = chunkJobText(job, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n\n")).toBe(job);
  });
  test("pathological single paragraph hard-splits", () => {
    const job = "z".repeat(1200);
    const chunks = chunkJobText(job, 500);
    expect(chunks.join("")).toBe(job);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });
});

describe("buildBodybuilderRequests 2M-aware decomposition", () => {
  test("huge job skips the LLM decomposer and chunks with fitted models", async () => {
    const job = "TASK: summarize.\n\n" + "y".repeat(900_000);
    const { requests } = await buildBodybuilderRequests(job, {
      maxRequests: 4,
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.length).toBeLessThanOrEqual(4);
    // content fully covered, no chunk dropped: every non-separator char of
    // the job appears in order across the segments (hard-splits may insert
    // separators where none existed, so compare separator-normalized).
    const joined = requests
      .map((r) => {
        const msgs = r.messages as Array<{ content: string }>;
        return msgs[0]!.content.split("SEGMENT:\n")[1] ?? "";
      })
      .join("\n\n");
    const norm = (s: string) => s.replace(/\n{2,}/g, "");
    expect(norm(joined)).toBe(norm("TASK: summarize.\n\n" + "y".repeat(900_000)));
    // every chunk rides a real free-pool member (context-fitted choice)
    const { freeCandidates: fc } = await import("../router_strategy");
    const poolIds = new Set(fc().map(([p, m]) => `${p}/${m}`));
    expect(poolIds.size).toBeGreaterThan(0);
    for (const r of requests) {
      expect(poolIds.has(String(r.model))).toBe(true);
    }
  }, 30_000);
});

describe("resolveSigmaAlias", () => {
  test("loose alias resolves to catalog id", () => {
    expect(resolveSigmaAlias("Kimi-K2.6")).toBe("moonshotai/Kimi-K2.6");
  });
  test("unknown id -> null", () => {
    expect(resolveSigmaAlias("definitely-not-a-model-xyz")).toBe(null);
  });
});

describe("resolveLongctx2MModel", () => {
  test("clean catalog falls back to the verified constant", () => {
    const [p, m] = resolveLongctx2MModel();
    expect(p).toBe(LONGCTX_2M_PROVIDER);
    expect(m).toBe(LONGCTX_2M_MODEL);
  });
});

describe("bench-priors dual-shape loader", () => {
  test("legacy shape loads provider Elo", async () => {
    const p = `/tmp/rmax-bench-legacy-${process.pid}.json`;
    await Bun.write(
      p,
      JSON.stringify({ generated_ts: "x", priors: { groq: { elo: 1080 } } }),
    );
    const b = loadBenchPriorsFile(p);
    expect(b.providerElo.groq).toBe(1080);
    expect(b.modelBonus.size).toBe(0);
  });
  test("v2 shape: provider_priors + model_priors with clamping", async () => {
    const p = `/tmp/rmax-bench-v2-${process.pid}.json`;
    await Bun.write(
      p,
      JSON.stringify({
        schema_version: 2,
        generated_ts: "y",
        provider_priors: { groq: { elo: 1085 } },
        model_priors: [
          { provider: "openrouter", model: "m:free", quality_mean: 2.0, healthy_frac: 1.0 },
          { provider: "openrouter", model: "bad:free", quality_mean: 0.2, healthy_frac: 0.1 },
        ],
      }),
    );
    const b = loadBenchPriorsFile(p);
    expect(b.providerElo.groq).toBe(1085);
    expect(b.modelBonus.get("openrouter/m:free")).toBe(10);
    expect(b.modelBonus.get("openrouter/bad:free")).toBe(-13);
  });
  test("qualityBonus clamps", () => {
    expect(qualityBonus({ provider: "p", model: "m", quality_mean: 2 })).toBe(10);
    expect(qualityBonus({ provider: "p", model: "m", quality_mean: 0 })).toBe(-10);
    expect(
      qualityBonus({ provider: "p", model: "m", quality_mean: 0, healthy_frac: 0 }),
    ).toBe(-15);
  });
  test("missing file fails open", () => {
    const b = loadBenchPriorsFile("/tmp/rmax-bench-nope.json");
    expect(b.source).toBe("missing");
    expect(b.modelBonus.size).toBe(0);
  });
});

describe("ROUTERS registry", () => {
  test("free_chain is registered", () => {
    expect(typeof ROUTERS.free_chain).toBe("function");
    expect(typeof ROUTERS.auto).toBe("function");
  });
});

describe("benchModelBonus kill switch", () => {
  test("ESTATE_BENCH_PRIORS=0 disables", () => {
    process.env.ESTATE_BENCH_PRIORS = "0";
    expect(benchModelBonus("openrouter", "m:free")).toBe(0);
    delete process.env.ESTATE_BENCH_PRIORS;
  });
});
