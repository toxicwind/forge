import { describe, expect, test } from "bun:test";
import {
  ZEN_MODELS,
  ZEN_PROVIDER,
  foldZenSse,
  openCodeID,
  zenBody,
  zenHeaders,
} from "../src/zen";

describe("zen request shape (OpenCode free-tier gate)", () => {
  test("openCodeID keeps ses_/msg_ + 26 chars (12 hex ts + 14 base62)", () => {
    for (const p of ["ses_", "msg_"] as const) {
      const id = openCodeID(p);
      expect(id.startsWith(p)).toBe(true);
      expect(id.length).toBe(p.length + 26);
      expect(/^[0-9a-f]{12}[A-Za-z0-9]{14}$/.test(id.slice(p.length))).toBe(
        true,
      );
    }
  });

  test("two request IDs differ, session shape is stable-format", () => {
    const a = openCodeID("msg_");
    const b = openCodeID("msg_");
    expect(a).not.toBe(b);
  });

  test("zenHeaders carries the free-tier identity set", () => {
    const h = zenHeaders("k");
    expect(h["authorization"]).toBe("Bearer k");
    expect(h["content-type"]).toBe("application/json");
    expect(h["user-agent"]).toMatch(/^opencode\/1\.18\./);
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-project"]).toBe("global");
    expect(h["x-opencode-session"]).toMatch(/^ses_.{26}$/);
    expect(h["x-opencode-request"]).toMatch(/^msg_.{26}$/);
  });

  test("zenBody forces stream and injects the gate tools", () => {
    const b = zenBody("mimo-v2.5-free", [{ role: "user", content: "hi" }], {
      max_tokens: 16,
    });
    expect(b["stream"]).toBe(true);
    expect(b["tool_choice"]).toBe("none");
    expect(b["model"]).toBe("mimo-v2.5-free");
    expect(b["max_tokens"]).toBe(16);
    const tools = b["tools"] as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name).sort()).toEqual([
      "bash",
      "glob",
      "grep",
      "read",
    ]);
  });

  test("foldZenSse concatenates deltas and strips meta frames", () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}`,
      `data: {"inference-cost":{"tokens":3}}`,
      ``,
      `data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
      ``,
    ].join("\n");
    const { content, finishReason } = foldZenSse(sse);
    expect(content).toBe("Hello");
    expect(finishReason).toBe("stop");
  });

  test("foldZenSse falls back to plain JSON when stream is ignored", () => {
    const { content, finishReason } = foldZenSse(
      `{"choices":[{"message":{"content":"OK","role":"assistant"},"finish_reason":"stop"}]}`,
    );
    expect(content).toBe("OK");
    expect(finishReason).toBe("stop");
  });

  test("ZEN_MODELS is the 17-model set, no dupes", () => {
    expect(ZEN_PROVIDER).toBe("custom/zen");
    expect(ZEN_MODELS.length).toBe(17);
    expect(new Set(ZEN_MODELS).size).toBe(17);
    for (const id of ["mimo-v2.5-free", "ling-3.0-flash-fin-free", "big-pickle"])
      expect(ZEN_MODELS).toContain(id);
  });
});
