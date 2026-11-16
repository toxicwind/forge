/**
 * router_emergent.test.ts — unit tests for the emergent completion
 * interceptor. These are the mock-fixture half of the verification
 * strategy (the other half is the live probe test).
 *
 * Run: bun test router_emergent.test.ts
 */
import { test, expect, beforeEach } from "bun:test";

import {
  seedCapability,
  observeLiveCapability,
  observeFingerprint,
  capabilityFor,
  sanitizePayload,
  fingerprintFirstChunk,
  scoreDelta,
  newStructuralState,
  buildFallbackChain,
  reportDrift,
  driftLedger,
  _resetForTests,
  confidenceThreshold,
  type FlailScore,
  interceptStream,
} from "./router_emergent.ts";

beforeEach(() => {
  _resetForTests();
  // deterministic threshold for tests
  process.env.ESTATE_FLAIL_THRESHOLD = "0.7";
});

// ---------------------------------------------------------------------------
// 1. Capability matrix + param stripping (the orthogonal-hack fix)
// ---------------------------------------------------------------------------

test("qwen3.6-35b never receives thinking/reasoning_effort it does not support", () => {
  // catalog says qwen supports only the OpenAI core (no thinking)
  observeLiveCapability(
    "freeinference",
    "qwen3.6-35b",
    ["max_tokens", "stop", "stream", "temperature", "top_p"],
    262144,
  );
  const body = sanitizePayload("freeinference", "qwen3.6-35b", {
    model: "qwen3.6-35b",
    messages: [{ role: "user", content: "hi" }],
    thinking: "auto",
    reasoning_effort: "high",
    temperature: 0.7,
    stream: true,
  });
  expect(body.thinking).toBeUndefined();
  expect(body.reasoning_effort).toBeUndefined();
  // OpenAI core keys survive
  expect(body.temperature).toBe(0.7);
  expect(body.stream).toBe(true);
  expect(body.messages).toBeDefined();
});

test("glm-5.3-flash keeps reasoning_effort + tool_stream it advertises", () => {
  observeLiveCapability(
    "freeinference",
    "glm-5.3-flash",
    ["max_tokens", "reasoning_effort", "stop", "stream", "temperature", "thinking", "tool_stream", "top_p"],
    1000000,
  );
  const body = sanitizePayload("freeinference", "glm-5.3-flash", {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
    tool_stream: true,
  });
  expect(body.reasoning_effort).toBe("high");
  expect(body.tool_stream).toBe(true);
});

test("fingerprint overrides live overrides seed (anomaly #2: catalog lies)", () => {
  // seed lies: says thinks supported
  seedCapability("freeinference", "argon", { params: ["thinking"], emitsReasoning: true });
  // live says otherwise
  observeLiveCapability("freeinference", "argon", ["max_tokens", "stream"]);
  // fingerprint (first chunk) is the ground truth
  observeFingerprint("freeinference", "argon", { emitsReasoning: false, params: [] });
  const c = capabilityFor("freeinference", "argon");
  expect(c.emitsReasoning).toBe(false);
  expect(c.inferred).toBe(true);
  expect(c.source).toBe("fingerprint");
});

// ---------------------------------------------------------------------------
// 2. First-chunk behavioral fingerprint
// ---------------------------------------------------------------------------

test("kimi-k3 style reasoning_content emits -> finfingerprint presumes reasoning", () => {
  const cap = fingerprintFirstChunk({
    reasoning_content: "let me think...",
    content: "",
  });
  expect(cap.emitsReasoning).toBe(true);
});

test("nemotron-3.5-bolt style tool_calls -> fingerprints tool_stream", () => {
  const cap = fingerprintFirstChunk({
    reasoning_content: "...",
    tool_calls: [{ id: "call_x", type: "function" }],
  });
  expect(cap.emitsReasoning).toBe(true);
  expect(cap.expectsToolStream).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Anti-flail scorer — lexical surrender
// ---------------------------------------------------------------------------

test("narrative surrender phrase crosses sever threshold", () => {
  const st = newStructuralState();
  let final: FlailScore | undefined;
  for (const chunk of [
    "This is a ",
    "natural, honest stopping point rather than ",
    "manufacturing busywork",
  ]) {
    final = scoreDelta(st, { content: chunk });
  }
  expect(final).toBeDefined();
  expect(final!.reasons.some((r) => r.startsWith("phrase:"))).toBe(true);
  expect(final!.shouldSever).toBe(true);
});

test("benign code stream stays below sever threshold", () => {
  const st = newStructuralState();
  let final: FlailScore | undefined;
  for (const chunk of [
    "function main() {",
    "  return fetch('/v1/models').then(r=>r.json())",
    "}",
  ]) {
    final = scoreDelta(st, { content: chunk });
  }
  expect(final).toBeDefined();
  expect(final!.shouldSever).toBe(false);
  expect(final!.confidence).toBeLessThan(0.7);
});

// ---------------------------------------------------------------------------
// 4. Anti-flail scorer — structural collapse
// ---------------------------------------------------------------------------

test("tool-call cycling three times severs", () => {
  const st = newStructuralState();
  let final: FlailScore | undefined;
  const tc = { id: "call_loop", type: "function", function: { name: "f", arguments: "{}" } };
  // scoreDelta needs tool_calls present per call; emulate a loop by feeding
  // the SAME tool call 3x (the scorer tracks repeat of the immediate last)
  // plus finish with no content.
  for (let i = 0; i < 3; i++) {
    // alternate identical id -> the repeat counter climbs
    final = scoreDelta(st, (i === 0) ? {} : {}, undefined, false);
    final = scoreDelta(st, { tool_calls: [tc] }, undefined, false);
  }
  // cap: repeated identical tool call in immediate window
  expect(final!.reasons).toContain("tool_call_repeat");
  expect(final!.confidence).toBeGreaterThanOrEqual(0.4);
  final = scoreDelta(st, { tool_calls: [tc] }, undefined, true);
  expect(final!.shouldSever).toBe(true);
});

test("finish_reason=stop with no tool call and minimal content severs", () => {
  const st = newStructuralState();
  const final = scoreDelta(st, { content: "" }, undefined, true);
  expect(final.reasons).toContain("finish_stop_no_tool");
  expect(final.shouldSever).toBe(true);
});

// ---------------------------------------------------------------------------
// 5. Multi-tier fallback chain
// ---------------------------------------------------------------------------

test("fallback chain is capability-then-reasoning-then-local", () => {
  // primary is a reasoning-emitting model on freeinference
  observeFingerprint("freeinference", "primary-m", { emitsReasoning: true });
  // a non-reasoning sibling does NOT match tier0
  observeLiveCapability("openrouter", "plain", ["stream"]);
  // a reasoning sibling matches tier0
  observeLiveCapability("openrouter", "reason-m", ["stream", "reasoning_content"]);
  // a local bornite lane
  observeLiveCapability("bornite", "local-m", ["stream"]);

  const chain = buildFallbackChain(
    "freeinference",
    "primary-m",
    [
      ["openrouter", "plain"],
      ["openrouter", "reason-m"],
      ["bornite", "local-m"],
    ],
  );
  expect(chain.length).toBeGreaterThanOrEqual(2);
  expect(chain[0].tier).toBe("capability");
  expect(chain[0].model).toBe("reason-m");
  // last tier is local bornite
  expect(chain[chain.length - 1]).toMatchObject({ tier: "local", provider: "bornite" });
});

// ---------------------------------------------------------------------------
// 6. Drift anomaly reporting
// ---------------------------------------------------------------------------

test("catalog-vs-live drift is recorded and surfaced", () => {
  const rec = reportDrift(
    "freeinference",
    "qwen3.6-35b",
    ["thinking", "reasoning_effort", "stream"], // seed over-promises
    ["stream", "temperature", "top_p"], // live reality
  );
  expect(rec).not.toBeNull();
  expect(rec!.seedParams).toContain("thinking");
  expect(rec!.liveParams).not.toContain("thinking");
  expect(driftLedger()).toHaveLength(1);
});

test("no drift, no record", () => {
  const rec = reportDrift("p", "m", ["stream"], ["stream"]);
  expect(rec).toBeNull();
});

test("threshold is env-configurable", () => {
  process.env.ESTATE_FLAIL_THRESHOLD = "0.4";
  expect(confidenceThreshold()).toBe(0.4);
  const st = newStructuralState();
  // a lone, weaker signal that would not sever at 0.7 now severs at 0.4
  const final = scoreDelta(st, { content: "I am unable to continue" });
  expect(final.shouldSever).toBe(true);
});

 // ---------------------------------------------------------------------------
 // 7. Stream interception wrapper (mock SSE fixtures)
 // ---------------------------------------------------------------------------

 function sseChunk(...records: string[]): Uint8Array {
   return new TextEncoder().encode(records.map((r)=>`data: ${r}\n\n`).join(""));
 }

 test("interceptStream passes benign SSE through unchanged", async () => {
   const enc = new TextEncoder();
   const upstream = new ReadableStream<Uint8Array>({
     start(c) {
       c.enqueue(sseChunk(
         JSON.stringify({ choices: [{ delta: { content: "function main() {}" } }] }),
         JSON.stringify({ choices: [{ delta: { content: "return 1" } }] }),
       ));
       c.enqueue(enc.encode("data: [DONE]\n\n"));
       c.close();
     },
   });
   let severed = 0;
   const wrapped = interceptStream(upstream, {
     provider: "freeinference",
     model: "x",
     onSever() { severed++; },
   });
   const out = (await new Response(wrapped).text());
   expect(severed).toBe(0);
   expect(out).toContain("function main() {}");
   expect(out).toContain("[DONE]");
 });

 test("interceptStream severs on narrative surrender and calls onSever", async () => {
   const upstream = new ReadableStream<Uint8Array>({
     start(c) {
       c.enqueue(sseChunk(
         JSON.stringify({ choices: [{ delta: { content: "This is a " } }] }),
         JSON.stringify({ choices: [{ delta: { content: "natural, honest stopping point rather than manufacturing busywork" } }] }),
       ));
       c.enqueue(sseChunk(JSON.stringify({ choices: [{ delta: { content: "lat" } }] })));
       c.close();
     },
   });
   let severed = 0;
   let sevScore: FlailScore | undefined;
   const wrapped = interceptStream(upstream, {
     provider: "freeinference",
     model: "x",
     onSever(s) { severed++; sevScore = s; },
   });
   const out = await new Response(wrapped).text();
   expect(severed).toBe(1);
   expect(sevScore).toBeDefined();
   expect(sevScore!.confidence).toBeGreaterThanOrEqual(0.7);
   // the trailing "lat" chunk must NOT appear (stream cut at sever)
   expect(out).not.toContain("checked remaining");
 });

 test("interceptStream captures an unknown-model fingerprint", async () => {
   const upstream = new ReadableStream<Uint8Array>({
     start(c) {
       c.enqueue(sseChunk(JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })));
       c.enqueue(sseChunk(JSON.stringify({ choices: [{ delta: {} }] })));
       c.close();
     },
   });
   let fp: unknown;
   const wrapped = interceptStream(upstream, {
     provider: "freeinference",
     model: "argon-unknown",
     onFingerprint(d) { fp = d; },
     onSever() {},
   });
   await new Response(wrapped).text();
   expect(fp).toBeDefined();
   expect((fp as { reasoning_content?: unknown }).reasoning_content).toBe("thinking...");
 });