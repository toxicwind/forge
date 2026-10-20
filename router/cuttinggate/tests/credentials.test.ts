import { describe, expect, test, beforeEach } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { ProviderGate } from "../src/circuit.ts";
import { Quarantine } from "../src/quarantine.ts";
import { Router } from "../src/router.ts";
import { CredentialPlane } from "../src/keypool.ts";

/**
 * The failure this exists to kill.
 *
 * flock loads one key per provider at boot and keeps it forever, so when a key
 * dies every completion 502s with no diagnosis and no rotation. Here the
 * credential plane is wired into the router: a 429 from upstream cools that key
 * and the *next* request is issued with a different one.
 */

const ENV = ["ALPHA_1", "ALPHA_2"] as const;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.ALPHA_1 = "one";
  process.env.ALPHA_2 = "two";
});

function plane(): CredentialPlane {
  return new CredentialPlane([
    {
      upstream: "alpha",
      health: { method: "GET", path: "/v1/auth/key", ok: [200] },
      failStatus: [401, 402, 429],
      probeTimeoutS: 5,
      requestTimeoutS: 180,
      cooldown: { 401: 300, 429: 60 },
      defaultCooldownS: 120,
      keys: [{ name: "ALPHA_1" }, { name: "ALPHA_2" }],
    },
  ]);
}

function ok(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** A router that answers with whatever the test queued, and records the key used. */
function routerWith(statuses: number[]) {
  const cfg = loadConfig({ port: 1, bases: { alpha: "http://alpha.invalid" }, keys: {}, maxConcurrent: 4 });
  let i = 0;
  const r = new Router(cfg, new ProviderGate(cfg), new Quarantine(), undefined, plane());
  r.register("m/model", "alpha");
  (r as unknown as { call: unknown }).call = async () => ok("hi", statuses[Math.min(i++, statuses.length - 1)]!);
  return { router: r };
}

describe("credential plane wired into the router", () => {
  test("a 429 from upstream cools that key for the next request", async () => {
    const { router } = routerWith([429]);
    await router.complete("m/model", [{ role: "user", content: "hi" }]);
    const state = planeKeys(router);
    expect(state.cooling).toBe(true);
    expect(state.lastStatus).toBe(429);
  });

  test("a 200 promotes the key straight back out", async () => {
    const { router } = routerWith([200]);
    await router.complete("m/model", [{ role: "user", content: "hi" }]);
    const state = planeKeys(router);
    expect(state.cooling).toBe(false);
    expect(state.failures).toBe(0);
  });

  test("a 401 says the credential is wrong, and does not retry it", async () => {
    const { router } = routerWith([401]);
    const result = await router.complete("m/model", [{ role: "user", content: "hi" }]);
    expect(result.ok).toBe(false);
    expect(planeKeys(router).lastStatus).toBe(401);
  });

  test("an exhausted pool is reported as starved, not as a mystery 502", () => {
    const cfg = loadConfig({ port: 1, bases: { alpha: "http://alpha.invalid" }, keys: {}, maxConcurrent: 4 });
    const creds = plane();
    const r = new Router(cfg, new ProviderGate(cfg), new Quarantine(), undefined, creds);
    r.register("m/model", "alpha");
    creds.note("alpha", "ALPHA_1", 429);
    creds.note("alpha", "ALPHA_2", 429);
    const [starved] = r.starved();
    expect(starved!.provider).toBe("alpha");
    expect(starved!.reason).toContain("no healthy key");
  });
});

/** The router keeps the plane private; read it back for assertions. */
function planeKeys(router: Router) {
  return (router as unknown as { credentials: CredentialPlane }).credentials.snapshot()[0]!.keys[0]!;
}
