import { test, expect } from "bun:test";
import {
  substantive,
  sanitizeBodybuilderRequests,
} from "../router_strategy.ts";
import { isChatCapable } from "../router_config.ts";

function routeResult(content: unknown, toolCalls?: unknown[]) {
  return {
    ok: true,
    data: JSON.stringify({
      choices: [{ message: { content, tool_calls: toolCalls } }],
    }),
  } as any;
}

test("substantive rejects bare scalar classifier scores", () => {
  // 2026-10-01: llama-prompt-guard-2-86m served this as a chat completion
  expect(substantive(routeResult("0.0007095712935552001"))).toBe(false);
  expect(substantive(routeResult("0"))).toBe(false);
  expect(substantive(routeResult("1"))).toBe(false);
  expect(substantive(routeResult("-1.5e-3"))).toBe(false);
  expect(substantive(routeResult("  0.42  "))).toBe(false);
});

test("substantive accepts real chat text", () => {
  expect(substantive(routeResult("Link-state converges faster."))).toBe(true);
  expect(substantive(routeResult("0.5 is not the whole story here"))).toBe(true);
  expect(substantive(routeResult("Answer: 42"))).toBe(true);
});

test("substantive accepts tool calls, rejects empties and failures", () => {
  expect(substantive(routeResult("", [{ name: "x" }]))).toBe(true);
  expect(substantive(routeResult(""))).toBe(false);
  expect(substantive(routeResult("   "))).toBe(false);
  expect(substantive({ ok: false } as any)).toBe(false);
});

test("isChatCapable excludes nongenerative models", () => {
  expect(isChatCapable("meta-llama/llama-prompt-guard-2-86m")).toBe(false);
  expect(isChatCapable("meta-llama/Llama-Guard-3-8B")).toBe(false);
  expect(isChatCapable("openai/text-embedding-3-small")).toBe(false);
  expect(isChatCapable("cohere/rerank-english-v3.0")).toBe(false);
  expect(isChatCapable("openai/omni-moderation-latest")).toBe(false);
  expect(isChatCapable("nvidia/nemotron-reward-70b")).toBe(false);
  expect(isChatCapable("some-org/deberta-classifier")).toBe(false);
});

test("isChatCapable keeps real chat models", () => {
  expect(isChatCapable("meta-llama/llama-3.1-70b-instruct")).toBe(true);
  expect(isChatCapable("openai/gpt-oss-120b")).toBe(true);
  expect(isChatCapable("qwen/qwen3-32b")).toBe(true);
  expect(isChatCapable("google/gemma-3-27b-it")).toBe(true);
});

test("sanitizeBodybuilderRequests rewrites hallucinated ids", () => {
  const out = sanitizeBodybuilderRequests(
    [{ model: "text-davinci-003" }, { model: "openrouter/real-model" }],
    ["openrouter/real-model", "groq/other"],
    4,
  );
  expect(out[0].model).toBe("openrouter/real-model");
  expect(out[1].model).toBe("openrouter/real-model");
});

test("sanitizeBodybuilderRequests clamps sampling params", () => {
  const out = sanitizeBodybuilderRequests(
    [
      { model: "a", temperature: 9.5, max_tokens: 99999999 },
      { model: "a", temperature: -1, max_tokens: 0 },
      { model: "a", temperature: 0.7, max_tokens: 2000 },
    ],
    ["a"],
    4,
  );
  expect(out[0].temperature).toBe(2);
  expect(out[0].max_tokens).toBe(32000);
  expect(out[1].temperature).toBe(0);
  expect(out[1].max_tokens).toBe(1);
  expect(out[2].temperature).toBe(0.7);
  expect(out[2].max_tokens).toBe(2000);
});

test("sanitizeBodybuilderRequests respects maxRequests", () => {
  const out = sanitizeBodybuilderRequests(
    [{ model: "a" }, { model: "a" }, { model: "a" }],
    ["a"],
    2,
  );
  expect(out.length).toBe(2);
});
