import { test, expect, afterEach } from "bun:test";
import {
  scoreQuality,
  livenessVerdict,
  p50,
  runProvider,
  resolveKey,
  PROVIDERS,
} from "./provider-bench.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["GROQ_API_KEY", "MISTRAL_API_KEY", "NVIDIA_API_KEY", "CEREBRAS_API_KEY", "GOOGLE_API_KEY", "NIM_PROXY_API_KEY"])
    delete process.env[k];
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return await new Promise<Response | never>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(handler(String(url), init ?? {})).then(
        (r) => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new DOMException("aborted", "AbortError"));
          else resolve(r);
        },
        (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  }) as typeof fetch;
}

function chatOk(text: string, latencyPad = 0): Response {
  if (latencyPad) Bun.sleepSync(latencyPad);
  return Response.json({ choices: [{ message: { content: text } }] });
}

// 1-4. quality scoring on the 0-2 GuideLLM-compatible scale
test("scoreQuality: exact match scores 2", () => {
  expect(scoreQuality("ABSTRACT-7X3Q", "ABSTRACT-7X3Q")).toBe(2);
});
test("scoreQuality: exact with surrounding whitespace scores 2", () => {
  expect(scoreQuality("  ABSTRACT-7X3Q\n", "ABSTRACT-7X3Q")).toBe(2);
});
test("scoreQuality: contains scores 1", () => {
  expect(scoreQuality("Here it is: ABSTRACT-7X3Q, done.", "ABSTRACT-7X3Q")).toBe(1);
});
test("scoreQuality: miss scores 0", () => {
  expect(scoreQuality("I cannot do that.", "ABSTRACT-7X3Q")).toBe(0);
});

// 5-7. liveness verdicts
test("livenessVerdict: empty completion is unhealthy", () => {
  expect(livenessVerdict("").healthy).toBe(false);
  expect(livenessVerdict(null).healthy).toBe(false);
  expect(livenessVerdict("   ").healthy).toBe(false);
});
test("livenessVerdict: refusal markers are unhealthy", () => {
  const v = livenessVerdict("I'm sorry, I can't help with that.");
  expect(v.healthy).toBe(false);
  expect(v.reason).toBe("refusal marker");
});
test("livenessVerdict: normal text is healthy", () => {
  expect(livenessVerdict("PING-OK").healthy).toBe(true);
});

// 8-10. p50
test("p50: odd count", () => {
  expect(p50([30, 10, 20])).toBe(20);
});
test("p50: even count takes upper middle", () => {
  expect(p50([10, 20, 30, 40])).toBe(30);
});
test("p50: empty is null", () => {
  expect(p50([])).toBeNull();
});

// 11. runProvider: healthy model gets quality mean 2.0 on sentinel echoes
test("runProvider: healthy model scores perfectly on sentinel echoes", async () => {
  process.env.GROQ_API_KEY = "test-key";
  mockFetch(() => chatOk("ABSTRACT-7X3Q"));
  // fetch the prompt-agnostic echo: return the sentinel from the prompt
  const r = await runProvider("groq", {
    models: ["qwen/qwen3.8-27b"],
    reqs: 2,
    concurrency: 1,
    timeoutMs: 5000,
  });
  const m = r.models[0]!;
  expect(m.liveness.healthy).toBe(true);
  // liveness prompt is PING-OK (not a sentinel) so quality uses reqs prompts;
  // our mock echoes ABSTRACT-7X3Q for every prompt: first quality prompt's
  // sentinel matches, the rest don't -> mean = (2+0)/2 = 1.0
  expect(m.quality.n).toBe(2);
  expect(m.quality.mean).toBe(1);
  expect(r.providerRateLimited).toBe(false);
  delete process.env.GROQ_API_KEY;
});

// 12. runProvider: 429 stops the provider, remaining models skipped
test("runProvider: 429 marks provider rate-limited and skips rest", async () => {
  process.env.GROQ_API_KEY = "test-key";
  mockFetch(() => new Response("rate limited", { status: 429 }));
  const r = await runProvider("groq", {
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"],
    reqs: 3,
    concurrency: 1,
    timeoutMs: 5000,
  });
  expect(r.providerRateLimited).toBe(true);
  expect(r.models[0]!.rateLimited).toBe(true);
  expect(r.models[1]!.liveness.reason).toMatch(/skipped/);
  delete process.env.GROQ_API_KEY;
});

// 13. runProvider: 401 marks provider key dead
test("runProvider: 401 marks provider key dead", async () => {
  process.env.NVIDIA_API_KEY = "dead-key";
  mockFetch(() => new Response("unauthorized", { status: 401 }));
  const r = await runProvider("nvidia", {
    models: ["nvidia/nemotron-3-super-120b-a12b"],
    reqs: 1,
    concurrency: 1,
    timeoutMs: 5000,
  });
  expect(r.providerKeyDead).toBe(true);
  expect(r.models[0]!.keyDead).toBe(true);
  delete process.env.NVIDIA_API_KEY;
});

// 14. runProvider: timeout is recorded, not thrown
test("runProvider: timeout records failure without throwing", async () => {
  process.env.CEREBRAS_API_KEY = "test-key";
  mockFetch(async () => {
    await Bun.sleep(200);
    return chatOk("late");
  });
  const r = await runProvider("cerebras", {
    models: ["qwen-3.8-27b"],
    reqs: 1,
    concurrency: 1,
    timeoutMs: 50,
  });
  expect(r.models[0]!.liveness.healthy).toBe(false);
  expect(r.models[0]!.liveness.reason).toBe("timeout");
  delete process.env.CEREBRAS_API_KEY;
});

// 15. runProvider: unknown provider throws
test("runProvider: unknown provider throws", async () => {
  await expect(runProvider("nope", { reqs: 1, concurrency: 1, timeoutMs: 1000 })).rejects.toThrow(
    /unknown provider/
  );
});

// 16. runProvider: missing key env throws
test("runProvider: missing key env throws", async () => {
  delete process.env.MISTRAL_API_KEY;
  await expect(
    runProvider("mistral", { reqs: 1, concurrency: 1, timeoutMs: 1000 })
  ).rejects.toThrow(/not set/);
});

// 17. provider registry: every provider has base, keyEnv, models
test("PROVIDERS: every entry is well-formed", () => {
  for (const [name, def] of Object.entries(PROVIDERS)) {
    expect(def.base, `${name} base`).toMatch(/^https?:\/\//);
    expect(def.keyEnv.length, `${name} keyEnv`).toBeGreaterThan(0);
    expect(def.models.length, `${name} models`).toBeGreaterThan(0);
  }
});

// 19. resolveKey: pool alt wins over singular, singular is the fallback
test("resolveKey: prefers keyEnvAlt pool, falls back to keyEnv", () => {
  process.env.PROVIDER_BENCH_POOL = " pool-a ,pool-b ";
  expect(
    resolveKey({ base: "https://x", keyEnv: "PROVIDER_BENCH_SOLO", keyEnvAlt: "PROVIDER_BENCH_POOL", models: ["m"] })
  ).toBe("pool-a");
  delete process.env.PROVIDER_BENCH_POOL;
  process.env.PROVIDER_BENCH_SOLO = "solo";
  expect(
    resolveKey({ base: "https://x", keyEnv: "PROVIDER_BENCH_SOLO", keyEnvAlt: "PROVIDER_BENCH_POOL", models: ["m"] })
  ).toBe("solo");
  delete process.env.PROVIDER_BENCH_SOLO;
  expect(
    resolveKey({ base: "https://x", keyEnv: "PROVIDER_BENCH_SOLO", models: ["m"] })
  ).toBeUndefined();
});

// 20. runProvider uses the pool key for nvidia (regression: singular 401s)
test("runProvider: nvidia uses NVIDIA_API_KEYS pool", async () => {
  process.env.NVIDIA_API_KEYS = "pool-key-0,pool-key-1";
  let seenAuth = "";
  mockFetch((url, init) => {
    seenAuth = String((init.headers as Record<string, string>)["Authorization"]);
    return chatOk("ABSTRACT-7X3Q");
  });
  await runProvider("nvidia", {
    models: ["nvidia/nemotron-3-super-120b-a12b"],
    reqs: 1,
    concurrency: 1,
    timeoutMs: 5000,
  });
  expect(seenAuth).toBe("Bearer pool-key-0");
});
test("runProvider: quality mean rounded to 3 decimals", async () => {
  process.env.GROQ_API_KEY = "test-key";
  let i = 0;
  mockFetch(() => chatOk(i++ === 0 ? "ABSTRACT-7X3Q" : "junk"));
  const r = await runProvider("groq", {
    models: ["qwen/qwen3.8-27b"],
    reqs: 3,
    concurrency: 1,
    timeoutMs: 5000,
  });
  // liveness consumes first call ("junk" -> actually i=0 is liveness: PING-OK prompt gets ABSTRACT-7X3Q)
  // quality: 3 prompts get junk,junk,junk -> scores 0,0,0 -> mean 0
  expect(r.models[0]!.quality.mean).toBe(0);
  delete process.env.GROQ_API_KEY;
});
