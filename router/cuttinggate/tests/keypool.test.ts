import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialPlane, KeyPoolExhaustedError, loadPoolsFromYaml, parsePools } from "../src/keypool";

const ENV_KEYS = ["TEST_A", "TEST_B", "TEST_FREE"] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.TEST_A = "secret-a";
  process.env.TEST_B = "secret-b";
  process.env.TEST_FREE = "secret-free";
});

function plane(): CredentialPlane {
  return new CredentialPlane([
    {
      upstream: "https://up.test",
      health: { method: "GET", path: "/v1/auth/key", ok: [200] },
      failStatus: [401, 402, 429],
      probeTimeoutS: 5,
      requestTimeoutS: 180,
      cooldown: { 401: 300, 402: 300, 429: 60 },
      defaultCooldownS: 120,
      keys: [{ name: "TEST_A" }, { name: "TEST_B" }, { name: "TEST_FREE", freeOnly: true }],
    },
  ]);
}

describe("credential plane", () => {
  test("a 429 puts the key in cooldown and the next key is offered", () => {
    const p = plane();
    expect(p.usable("https://up.test")).toEqual(["TEST_A", "TEST_B", "TEST_FREE"]);
    p.note("https://up.test", "TEST_A", 429);
    expect(p.usable("https://up.test")).not.toContain("TEST_A");
  });

  test("a 401 cools for longer than a 429: a wrong credential will not fix itself", () => {
    const p = plane();
    p.note("https://up.test", "TEST_A", 401);
    p.note("https://up.test", "TEST_B", 429);
    expect(p.usable("https://up.test")).toEqual(["TEST_FREE"]);
    const keys = p.snapshot()[0]!.keys;
    const a = keys[0]!;
    const b = keys[1]!;
    // note() stamps both lastCheckedAt and coolingUntil from the same clock, so
    // the difference is exactly the configured cooldown.
    expect(a.coolingUntil - a.lastCheckedAt!).toBe(300_000);
    expect(b.coolingUntil - b.lastCheckedAt!).toBe(60_000);
  });

  test("a success clears the cooldown and the failure streak", () => {
    const p = plane();
    p.note("https://up.test", "TEST_A", 429);
    expect(p.usable("https://up.test")).not.toContain("TEST_A");
    p.note("https://up.test", "TEST_A", 200);
    expect(p.usable("https://up.test")).toContain("TEST_A");
    const state = p.snapshot()[0]!.keys[0]!;
    expect(state.failures).toBe(0);
    expect(state.cooling).toBe(false);
  });


  test("a free-only key is never offered for a paid route", () => {
    const p = plane();
    expect(p.usable("https://up.test", { paid: true })).not.toContain("TEST_FREE");
    expect(p.usable("https://up.test", { paid: false })).toContain("TEST_FREE");
  });

  test("a key that is configured but absent from the environment is skipped, not failed", () => {
    delete process.env.TEST_A;
    const p = plane();
    expect(p.usable("https://up.test")).not.toContain("TEST_A");
    expect(p.snapshot()[0]!.keys[0]!.present).toBe(false);
  });

  test("every key cooling produces a diagnosable error naming the statuses", () => {
    const p = plane();
    for (const k of ENV_KEYS) p.note("https://up.test", k, 401);
    expect(() => p.claim("https://up.test")).toThrow(KeyPoolExhaustedError);
    try {
      p.claim("https://up.test");
    } catch (e) {
      expect((e as Error).message).toContain("no healthy key");
      expect((e as Error).message).toContain("TEST_A");
      expect((e as Error).message).toContain("401");
    }
  });

  test("a network failure cools down without a status", () => {
    const p = plane();
    p.note("https://up.test", "TEST_A", null, "ECONNRESET");
    const state = p.snapshot()[0]!.keys[0]!;
    expect(state.cooling).toBe(true);
    expect(state.reason).toBe("ECONNRESET");
  });

  test("no snapshot ever contains a credential value", () => {
    const p = plane();
    const text = JSON.stringify(p.snapshot());
    for (const secret of ["secret-a", "secret-b", "secret-free"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("TEST_A");
  });
});

describe("keypools.yaml parsing", () => {
  test("the default cooldown lives inside the cooldown map", () => {
    const [pool] = parsePools({
      pools: { x: { cooldown: { 429: 60, default: 120 }, keys: ["K"] } },
    });
    expect(pool!.cooldown).toEqual({ 429: 60 });
    expect(pool!.defaultCooldownS).toBe(120);
  });

  test("string and object key specs both load, and free_only is preserved", () => {
    const [pool] = parsePools({ pools: { x: { keys: ["PLAIN", { name: "FREE", freeOnly: true }] } } });
    expect(pool!.keys).toEqual([{ name: "PLAIN" }, { name: "FREE", freeOnly: true }]);
  });

  test("the estate's real keypools.yaml loads", () => {
    const pools = loadPoolsFromYaml("/home/toxic/estate/config/keypools.yaml");
    expect(pools.length).toBeGreaterThan(0);
    expect(pools.every((p) => p.keys.length > 0)).toBe(true);
    expect(pools.some((p) => p.cooldown[429] === 60)).toBe(true);
  });

  test("an empty document yields no pools instead of throwing", () => {
    expect(parsePools({})).toEqual([]);
  });

  test("a malformed file surfaces as a parse error, not a silent empty plane", () => {
    const dir = mkdtempSync(join(tmpdir(), "keypool-"));
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "pools: [unclosed\n");
    expect(() => loadPoolsFromYaml(bad)).toThrow();
  });
});
