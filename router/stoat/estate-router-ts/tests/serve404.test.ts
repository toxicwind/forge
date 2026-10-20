// Integration tests for POST /admin/catalog/serve-404.
// Spawns the router on a unique port, exercises the endpoint, verifies
// quarantine behavior and input validation.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";

const PORT = 25299; // unique test port (25xxx range, not production 25104)
const CATALOG_PATH = `/tmp/estate_router_serve404_test.catalog.${process.pid}.json`;

let router: Subprocess | null = null;

beforeAll(async () => {
  // Start the router with a unique catalog path so the test is isolated.
  router = spawn({
    cmd: [process.execPath, "router.ts"], // real bun, not the mise shim (shim overrides ESTATE_ROUTER_PORT from ports.env)
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      ESTATE_ROUTER_PORT: String(PORT),
      ESTATE_CATALOG_STATE: CATALOG_PATH,
      // No ESTATE_ADMIN_TOKEN: AUTH is unset, endpoint is open in test.
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  // Wait for the server to be ready.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) break;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

afterAll(() => {
  router?.kill();
});

async function post404(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/catalog/serve-404`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

describe("POST /admin/catalog/serve-404", () => {
  test("valid provider+model quarantines and returns ok", async () => {
    const { status, json } = await post404({
      provider: "groq",
      model: "test-model-404",
    });
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.provider).toBe("groq");
    expect(json.model).toBe("test-model-404");
    expect(json.quarantined).toBe(true);
  });

  test("missing provider returns 400", async () => {
    const { status, json } = await post404({ model: "x" });
    expect(status).toBe(400);
    expect(json.error).toContain("provider and model required");
  });

  test("missing model returns 400", async () => {
    const { status, json } = await post404({ provider: "groq" });
    expect(status).toBe(400);
    expect(json.error).toContain("provider and model required");
  });

  test("invalid JSON returns 400", async () => {
    const { status, json } = await post404("not-json{{{");
    expect(status).toBe(400);
    expect(json.error).toBe("invalid json");
  });

  test("unknown provider does not crash; returns ok", async () => {
    // noteServe404 returns early for unknown providers; the endpoint
    // must not throw.
    const { status, json } = await post404({
      provider: "nonexistent-provider-xyz",
      model: "some-model",
    });
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
  });

  test("empty strings are rejected", async () => {
    const { status } = await post404({ provider: "  ", model: "x" });
    expect(status).toBe(400);
  });
});
