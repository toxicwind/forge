import { test, expect } from "bun:test";
import {
  sigmaLookup,
  applySigmaBackfill,
  sigmaCatalogInfo,
} from "./sigma-enrich.ts";

test("sigma catalog loads with a fresh snapshot", () => {
  const info = sigmaCatalogInfo();
  expect(info.rows).toBeGreaterThan(400);
  expect(info.snapshot).toBe("2026-09-23");
});

test("sigmaLookup matches provider-prefixed estate ids", () => {
  // estate openrouter id "x-ai/grok-4.7" should hit sigma's grok-4.7 rows
  const hit = sigmaLookup("openrouter", "x-ai/grok-4.7");
  expect(hit).not.toBeNull();
  expect(hit!.contextWindow).toBeGreaterThan(0);
});

test("sigmaLookup returns null for unknown ids", () => {
  expect(sigmaLookup("openrouter", "definitely-not-a-real-model-xyz")).toBeNull();
});

test("applySigmaBackfill fills only missing context windows", () => {
  const live: Record<string, Record<string, unknown>> = {
    openrouter: {
      "x-ai/grok-4.7": { pricing: { prompt: "0", completion: "0" } },
      "already-known/model": { context_window: 128000 },
    },
  };
  const n = applySigmaBackfill(live);
  expect(n).toBeGreaterThan(0);
  const grok = live.openrouter["x-ai/grok-4.7"] as Record<string, unknown>;
  expect(typeof grok["context_window"]).toBe("number");
  expect((grok["context_window"] as number)).toBeGreaterThan(0);
  // live metadata wins: pre-existing context_window untouched
  expect(live.openrouter["already-known/model"]["context_window"]).toBe(128000);
  expect(live.openrouter["already-known/model"]["sigma_snapshot"]).toBeUndefined();
});
