import { test, expect } from "bun:test";
import { filterByContext, estPromptTokens } from "../router_strategy.ts";

test("estPromptTokens counts chars/4 across messages", () => {
  const body = {
    messages: [
      { role: "user", content: "abcd" }, // 4 chars
      { role: "user", content: [{ text: "abcdefgh" }] }, // 8 chars
    ],
  };
  expect(estPromptTokens(body as any)).toBe(3); // 12/4
});

test("filterByContext keeps unknown-context models", () => {
  const cands: [string, string][] = [["openrouter", "unknown/model-xyz"]];
  const out = filterByContext(cands, 100000);
  expect(out).toEqual(cands);
});

test("filterByContext degrades to unfiltered when all fail", () => {
  // All candidates have tiny known context but pool must not empty
  const cands: [string, string][] = [["x", "y"]];
  const out = filterByContext(cands, 10_000_000);
  expect(out.length).toBeGreaterThan(0);
});
