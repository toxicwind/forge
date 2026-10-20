import { test, expect } from "bun:test";
import {
  OPENCODE_UA,
  openCodeID,
  zenFingerprintHeaders,
  applyZenFreeTierBody,
} from "../router_strategy.ts";

// Locks in the OpenCode Zen free-tier upstream contract (borrowed:
// denysvitali/llm-proxy, 12errh/zen-proxy). Verified live 2026-10-04:
// the gate is format-checked (ses_/msg_ IDs, opencode/ UA, stream:true,
// bash/glob/grep/read tools) and served alongside a valid key.

test("UA carries opencode/1.18+", () => {
  expect(OPENCODE_UA.startsWith("opencode/1.18")).toBe(true);
});

test("openCodeID format: prefix + 12 hex ts + 14 alnum", () => {
  for (const p of ["ses_", "msg_"]) {
    const id = openCodeID(p);
    expect(id.startsWith(p)).toBe(true);
    expect(id.length).toBe(p.length + 26);
    expect(/^[0-9a-f]{12}$/.test(id.slice(p.length, p.length + 12))).toBe(true);
    expect(/^[A-Za-z0-9]{14}$/.test(id.slice(p.length + 12))).toBe(true);
  }
});

test("headers carry the gate contract", () => {
  const h = zenFingerprintHeaders();
  expect(h["User-Agent"].startsWith("opencode/1.18")).toBe(true);
  expect(h["x-opencode-client"]).toBe("cli");
  expect(h["x-opencode-project"]).toBe("global");
  const ses = h["x-opencode-session"];
  expect(ses.startsWith("ses_") && ses.length === 4 + 26).toBe(true);
  const req = h["x-opencode-request"];
  expect(req.startsWith("msg_") && req.length === 4 + 26).toBe(true);
  // request IDs rotate per call; the session is process-stable (one CLI session)
  expect(zenFingerprintHeaders()["x-opencode-request"]).not.toBe(req);
  expect(zenFingerprintHeaders()["x-opencode-session"]).toBe(ses);
  expect(h["Authorization"].startsWith("Bearer ")).toBe(true);
  expect(h["Authorization"].length).toBeGreaterThan(8);
});

test("body gate forces stream:true + decoy tools + tool_choice none", () => {
  const payload: Record<string, unknown> = { model: "muse-spark-1.3-contributor-free" };
  applyZenFreeTierBody(payload);
  expect(payload.stream).toBe(true);
  const names = ((payload.tools as any[]) || []).map((t: any) => t.function?.name);
  for (const n of ["bash", "glob", "grep", "read"]) expect(names).toContain(n);
  expect(payload.tool_choice).toBe("none");
});

test("body gate preserves caller tools and explicit tool_choice", () => {
  const payload: Record<string, unknown> = {
    tools: [{ type: "function", function: { name: "bash", description: "real" } }],
    tool_choice: "auto",
  };
  applyZenFreeTierBody(payload);
  const tools = payload.tools as any[];
  const names = tools.map((t: any) => t.function?.name);
  expect(names.filter((n: string) => n === "bash").length).toBe(1);
  for (const n of ["glob", "grep", "read"]) expect(names).toContain(n);
  expect(payload.tool_choice).toBe("auto");
});
