// Regression test: service-specific ESTATE_ROUTER_PORT must win over the
// generic ESTATE_PORT when both are set.
// (2026-09-30: a phantom ESTATE_PORT=20128 in the daemon environment sent
// the router at vansrouter's port -> EADDRINUSE crash loop. The specific var
// is the SSOT; the generic one is legacy fallback only.)
import { describe, test, expect } from "bun:test";

const ROUTER_DIR = new URL("..", import.meta.url).pathname;
const CONFIG_ABS = ROUTER_DIR + "/router_config.ts";

function childScript(prelude: string): string {
  return (
    prelude +
    "const m = await import(" +
    JSON.stringify(CONFIG_ABS) +
    "); console.log(m.PORT);"
  );
}

async function resolvePort(
  env: Record<string, string>,
  prelude = "",
): Promise<string> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", childScript(prelude)],
    cwd: ROUTER_DIR,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe("port precedence (router_config.ts)", () => {
  test("ESTATE_ROUTER_PORT wins when both are set", async () => {
    const port = await resolvePort({
      ESTATE_ROUTER_PORT: "25298",
      ESTATE_PORT: "20128",
    });
    expect(port).toBe("25298");
  });

  test("ESTATE_ROUTER_PORT alone resolves", async () => {
    const port = await resolvePort(
      { ESTATE_ROUTER_PORT: "25296" },
      "delete process.env.ESTATE_PORT;",
    );
    expect(port).toBe("25296");
  });
});
