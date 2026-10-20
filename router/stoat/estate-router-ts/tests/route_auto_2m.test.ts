// Tests for the 2M-context tier + routeAuto (estate-owned openrouter/auto
// equivalent) + bodybuilder, added 2026-10-01. Pure-logic tests only: no
// network, no provider keys required.
import { describe, test, expect } from "bun:test";

// Must be set before the router modules are imported (DB_PATH and the
// catalog state path are read once at import).
process.env.ESTATE_DB = "/tmp/estate_router_auto2m_test.db";
process.env.ESTATE_CATALOG_STATE =
  `/tmp/estate_router_auto2m_test.catalog.${process.pid}.json`;

const {
  LONGCTX_2M_PROVIDER,
  LONGCTX_2M_MODEL,
  LONGCTX_2M_GATE_TOKENS,
  LONGCTX_2M_DAILY_CAP,
  longctx2MEnabled,
  longctx2MPinEligible,
  estPromptTokens,
  routeAuto,
  bodyPromptText,
  buildBodybuilderRequests,
  ROUTERS,
} = await import("../router_strategy");

const smallBody = (model = "auto") => ({
  model,
  messages: [{ role: "user", content: "hello" }],
});
// chars/4 estimator: 4_100_000 chars -> 1_025_000 est tokens > 1M gate.
const bigBody = (model = "auto") => ({
  model,
  messages: [{ role: "user", content: "x".repeat(4_100_000) }],
});

describe("2M-context tier constants", () => {
  test("gate is 1M tokens, provider/model pinned to the 2M lane", () => {
    expect(LONGCTX_2M_GATE_TOKENS).toBe(1_000_000);
    expect(LONGCTX_2M_PROVIDER).toBe("openrouter");
    expect(LONGCTX_2M_MODEL).toBe("x-ai/grok-4.20");
    expect(LONGCTX_2M_DAILY_CAP).toBe(5);
  });

  test("estimator crosses the 2M gate on a 4.1M-char prompt", () => {
    expect(estPromptTokens(bigBody())).toBeGreaterThan(1_000_000);
    expect(estPromptTokens(smallBody())).toBeLessThan(100);
  });
});

describe("longctx2MPinEligible", () => {
  test("small prompt is under_gate", () => {
    const v = longctx2MPinEligible(smallBody());
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("under_gate");
  });

  test("explicit model requests keep their lane", () => {
    // "fast" is a CODING alias -> isExplicit -> isRoutableModelId.
    const v = longctx2MPinEligible(bigBody("fast"));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("explicit_model");
    expect(v.estTokens).toBeGreaterThan(1_000_000);
  });

  test("kill switch ESTATE_LONGCTX_2M=0 disables the tier", () => {
    process.env.ESTATE_LONGCTX_2M = "0";
    try {
      expect(longctx2MEnabled()).toBe(false);
      const v = longctx2MPinEligible(bigBody());
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("disabled");
    } finally {
      delete process.env.ESTATE_LONGCTX_2M;
    }
    expect(longctx2MEnabled()).toBe(true);
  });

  test("default-path big prompt returns a well-formed verdict", () => {
    const v = longctx2MPinEligible(bigBody());
    expect(typeof v.ok).toBe("boolean");
    expect(v.estTokens).toBeGreaterThan(1_000_000);
    // Without a live key/circuit the verdict is a refusal reason, never
    // eligible:false with an unknown reason.
    if (!v.ok) {
      expect([
        "disabled",
        "under_gate",
        "explicit_model",
        "circuit_open",
        "no_key",
        "budget_exhausted",
      ]).toContain(v.reason);
    }
  });
});

describe("bodyPromptText", () => {
  test("returns last string content, newest first", () => {
    expect(
      bodyPromptText({
        model: "auto",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second" },
        ],
      }),
    ).toBe("second");
  });

  test("joins array content parts", () => {
    expect(
      bodyPromptText({
        model: "auto",
        messages: [
          {
            role: "user",
            content: [{ text: "a" }, { text: "b" }, { image: "x" }],
          },
        ],
      }),
    ).toBe("a\nb");
  });

  test("empty body returns empty string (isAst-safe)", () => {
    expect(bodyPromptText({ model: "auto", messages: [] })).toBe("");
    expect(bodyPromptText({ model: "auto" })).toBe("");
  });

  test("detects code-shaped prompts for the AST lane", () => {
    const code = "```python\ndef f():\n    pass\n```";
    expect(bodyPromptText({ model: "auto", messages: [{ role: "user", content: code }] })).toBe(code);
  });
});

describe("routeAuto registration", () => {
  test("auto is registered and is the routeAuto function", () => {
    expect(ROUTERS.auto).toBe(routeAuto);
    expect(typeof routeAuto).toBe("function");
  });

  test("buildBodybuilderRequests is exported", () => {
    expect(typeof buildBodybuilderRequests).toBe("function");
  });
});
