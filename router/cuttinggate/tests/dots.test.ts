import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOTS_MODEL,
  DOTS_PROVIDER,
  DOTS_STOP_TOKENS,
  dotsBody,
  injectStrictTools,
  normalizeDotsMessages,
} from "../src/dots.ts";
import { COPILOT_PROVIDER } from "../src/copilot.ts";
import { ZEN_PROVIDER } from "../src/zen.ts";
import { loadConfig } from "../src/config.ts";
import { ProviderGate } from "../src/circuit.ts";
import { Quarantine } from "../src/quarantine.ts";
import { Ledger } from "../src/ledger.ts";
import { Router, type ChatRequest } from "../src/router.ts";
import { buildApp } from "../src/server.ts";

describe("custom/dots coercion layer", () => {
  test("provider and model constants follow custom/* namespace", () => {
    expect(DOTS_PROVIDER).toBe("custom/dots");
    expect(COPILOT_PROVIDER).toBe("custom/copilot");
    expect(ZEN_PROVIDER).toBe("custom/zen");
    expect(DOTS_MODEL).toBe("dots-studio/dots-3-note-preview:free");
  });

  test("normalizes assistant content=null to empty string", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
    ];
    const norm = normalizeDotsMessages(msgs);
    expect(norm[0]?.content).toBe("hi");
    expect(norm[1]?.content).toBe("");
  });

  test("injects strict=true and additionalProperties=false into tool schemas", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    const out = injectStrictTools(tools);
    expect(out?.[0]?.function?.strict).toBe(true);
    expect(out?.[0]?.function?.parameters?.additionalProperties).toBe(false);
  });

  test("constructs full estate payload with reasoning cap, stop tokens, and provider flags", () => {
    const payload = dotsBody(
      [{ role: "assistant", content: null }, { role: "user", content: "run tool" }],
      {
        sessionId: "sess-123",
        tools: [{ type: "function", function: { name: "ping", parameters: { type: "object" } } }],
        forced_tool: "ping",
      },
    );
    expect(payload.model).toBe(DOTS_MODEL);
    expect(payload.sessionId).toBe("sess-123");
    expect(payload.max_tokens).toBe(4096);
    expect(payload.temperature).toBe(0.1);
    expect(payload.reasoning).toEqual({ max_tokens: 128, exclude: true });
    expect(payload.stop).toBeUndefined();
    expect(payload.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
    expect(payload.tool_choice).toEqual({ type: "function", function: { name: "ping" } });

    const withStop = dotsBody([{ role: "user", content: "hi" }], { require_parameters: false });
    expect(withStop.stop).toEqual([...DOTS_STOP_TOKENS]);
  });
});

describe("custom/* HTTP routes end-to-end (custom/dots, custom/bodybuilder, custom/zen, custom/copilot, custom/openfang-resolve)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-custom-"));
  const cfg = loadConfig({
    port: 1,
    keys: {
      "custom/dots": "or-key",
      "custom/zen": "zen-key",
      "custom/copilot": "gh-key",
    },
    maxConcurrent: 16,
  });

  test("POST /v1/chat/completions with model=custom/dots coerces payload and preserves tool_calls", async () => {
    const router = new Router(cfg, new ProviderGate(cfg), new Quarantine(), new Ledger(join(dir, "l1.jsonl")));
    router.register(DOTS_MODEL, DOTS_PROVIDER);
    router.register("custom/dots", DOTS_PROVIDER);

    let capturedProvider = "";
    let capturedReq: ChatRequest | undefined;
    (router as unknown as { call: unknown }).call = async (provider: string, req: ChatRequest) => {
      capturedProvider = provider;
      capturedReq = req;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "ffs_grep", arguments: "{}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { total_tokens: 42 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const app = buildApp({
      config: cfg,
      gate: new ProviderGate(cfg),
      quarantine: new Quarantine(),
      ledger: new Ledger(join(dir, "l2.jsonl")),
      router,
      catalogState: () => ({
        status: "ok",
        source: "test",
        contract: { name: "estate-pinax/live-catalog/v1", spec: { generation: 2, canonical: true, introduced: "2026-06-01", emittedBy: "test" }, canonical: true },
        catalog: { contract: "estate-pinax/live-catalog/v1", generatedAt: "", deadIds: [], providers: {} },
        generatedAt: "",
        ageMs: 0,
        stale: false,
      }),
    });

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "x-session-id": "sess-live-99",
        },
        body: JSON.stringify({
          model: "custom/dots",
          messages: [
            { role: "assistant", content: null },
            { role: "user", content: "search bodybuilder" },
          ],
          tools: [{ type: "function", function: { name: "ffs_grep", parameters: { type: "object" } } }],
          forced_tool: "ffs_grep",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedProvider).toBe("custom/dots");
    expect(capturedReq?.forced_tool).toBe("ffs_grep");
    expect(capturedReq?.sessionId).toBe("sess-live-99");
    const json = (await res.json()) as { choices: { message: { content: string; tool_calls: unknown[] }; finish_reason: string }[] };
    expect(json.choices[0]?.finish_reason).toBe("tool_calls");
    expect(json.choices[0]?.message.tool_calls).toHaveLength(1);
  });

  test("POST /v1/custom/bodybuilder decomposes and executes fan-out requests", async () => {
    const router = new Router(cfg, new ProviderGate(cfg), new Quarantine(), new Ledger(join(dir, "l3.jsonl")));
    router.register(DOTS_MODEL, DOTS_PROVIDER);
    (router as unknown as { call: unknown }).call = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "subtask result" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const app = buildApp({
      config: cfg,
      gate: new ProviderGate(cfg),
      quarantine: new Quarantine(),
      ledger: new Ledger(join(dir, "l4.jsonl")),
      router,
      catalogState: () => ({
        status: "ok",
        source: "test",
        contract: { name: "estate-pinax/live-catalog/v1", spec: { generation: 2, canonical: true, introduced: "2026-06-01", emittedBy: "test" }, canonical: true },
        catalog: { contract: "estate-pinax/live-catalog/v1", generatedAt: "", deadIds: [], providers: {} },
        generatedAt: "",
        ageMs: 0,
        stale: false,
      }),
    });

    const res = await app.handle(
      new Request("http://localhost/v1/custom/bodybuilder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: "audit all custom routes", max_requests: 2, execute: true }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { route: string; requests: unknown[]; results: { ok: boolean; text: string }[] };
    expect(data.route).toBe("custom/bodybuilder");
    expect(data.requests).toHaveLength(2);
    expect(data.results).toHaveLength(2);
    expect(data.results[0]?.ok).toBe(true);
    expect(data.results[0]?.text).toBe("subtask result");
  });

  test("GET /v1/custom/openfang-resolve resolves specs with custom/openfang-resolve route tag", async () => {
    const router = new Router(cfg, new ProviderGate(cfg), new Quarantine(), new Ledger(join(dir, "l5.jsonl")));
    router.register(DOTS_MODEL, DOTS_PROVIDER);
    const app = buildApp({
      config: cfg,
      gate: new ProviderGate(cfg),
      quarantine: new Quarantine(),
      ledger: new Ledger(join(dir, "l6.jsonl")),
      router,
      catalogState: () => ({
        status: "ok",
        source: "test",
        contract: { name: "estate-pinax/live-catalog/v1", spec: { generation: 2, canonical: true, introduced: "2026-06-01", emittedBy: "test" }, canonical: true },
        catalog: { contract: "estate-pinax/live-catalog/v1", generatedAt: "", deadIds: [], providers: {} },
        generatedAt: "",
        ageMs: 0,
        stale: false,
      }),
    });

    const res = await app.handle(new Request("http://localhost/v1/custom/openfang-resolve?spec=dots-studio/dots-3-note-preview:free"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { route: string; provider: string; model: string };
    expect(data.route).toBe("custom/openfang-resolve");
  });
});
