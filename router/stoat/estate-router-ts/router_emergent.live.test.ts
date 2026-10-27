/**
 * router_emergent.live.test.ts — LIVE provider probe (optional).
 *
 * The second half of the verification strategy (mock fixtures are the
 * first, in router_emergent.test.ts). This test hits REAL upstreams to
 * prove the capability matrix resolves live data, not just seeded mocks.
 *
 * It is SKIPPED when the key is absent (CI-safe): set
 * FREEINFERENCE_API_KEY in the environment to enable.
 *
 * Run: FREEINFERENCE_API_KEY=... bun test router_emergent.live.test.ts
 */
import { test, expect } from "bun:test";

import {
  observeLiveCapability,
  capabilityFor,
  sanitizePayload,
  driftLedger,
  _resetForTests,
} from "./router_emergent.ts";

const BASE = process.env.FREEINFERENCE_BASE || "https://freeinference.org";
const KEY = process.env.FREEINFERENCE_API_KEY || "";
const ENABLED = KEY.length > 0;

test.skipIf(!ENABLED)("live capability probe against real FreeInference", async () => {
  _resetForTests();
  // 1. Pull the real /v1/models catalog
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  expect(r.ok).toBe(true);
  const j = (await r.json()) as {
    data?: Array<Record<string, unknown>>;
  };
  expect(Array.isArray(j.data)).toBe(true);
  expect((j.data || []).length).toBeGreaterThan(0);

  // 2. Observe capability for every model, let the real 2026 matrix in
  const provider = "freeinference";
  const observed = new Map<string, string[]>();
  for (const d of j.data || []) {
    const id = String(d.id);
    const params = Array.isArray(d.supported_sampling_parameters)
      ? (d.supported_sampling_parameters as string[])
      : undefined;
    observeLiveCapability(
      provider,
      id,
      params,
      typeof d.context_length === "number"
        ? (d.context_length as number)
        : undefined,
    );
    if (params) observed.set(id, params);
  }
  expect(observed.size).toBeGreaterThan(0);

  // 3. Sanitization for a real model: a model whose supported_sampling_parameters
  //    does NOT advertise thinking/reasoning_effort must reject them.
  for (const [id, params] of observed) {
    const cap = capabilityFor(provider, id);
    expect(cap.source).toBe("live");
    expect(cap.params).toEqual([...params].sort());
    const body = sanitizePayload(provider, id, {
      model: id,
      messages: [{ role: "user", content: "hi" }],
      thinking: "auto",
      reasoning_effort: "high",
      temperature: 0.7,
    });
    if (!params.includes("thinking")) expect(body.thinking).toBeUndefined();
    if (!params.includes("reasoning_effort")) {
      expect(body.reasoning_effort).toBeUndefined();
    }
    // OpenAI core is preserved regardless
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toBeDefined();
  }

  // 4. No false drift when checking live against its own live params.
  expect(driftLedger().length).toBe(0);
});

test.skipIf(!ENABLED)("free bge-m3 embedding model resolves as a live capability", async () => {
  _resetForTests();
  const r = await fetch(`${BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json()) as {
    data?: Array<Record<string, unknown>>;
  };
  const bgem = (j.data || []).find((d) => String(d.id).includes("bge-m3"));
  expect(bgem).toBeDefined();
  observeLiveCapability("freeinference", String(bgem!.id), [], 8192);
  const cap = capabilityFor("freeinference", String(bgem!.id));
  expect(cap.source).toBe("live");
  expect(cap.contextLength).toBe(8192);
});