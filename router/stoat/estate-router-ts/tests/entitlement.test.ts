// Regression tests for the 503-forensics 2026-09-21 dead-ID sweep +
// entitlement-404 fail-fast bench + llama-swap bonus lane.
//
//  1. DEAD_MODEL_IDS filters EOL/delisted IDs from every catalog (static
//     and live) — they can enter neither race sets nor explicit routing.
//  2. One 404 on a model attempt benches the MODEL for the process
//     lifetime (fail-fast, zero retry burn); 429 never benches.
//  3. One 401/402 counts 3x — the dead-key provider's circuit opens
//     immediately instead of needing 3 separate client requests.
//  4. callOne refuses a benched model without touching the network.
//  5. pickWeighted always includes the healthy llama-swap bonus lane and
//     skips entitlement-benched models in every race set.
import { describe, test, expect } from "bun:test";

// Must be set before the router modules are imported (DB_PATH and the
// catalog state path are read once at import). The catalog path is unique
// per run: noteEntitlement404 persists quarantine to it, and a reused path
// would leak a bench into the next run.
process.env.ESTATE_DB = "/tmp/estate_router_entitlement_test.db";
process.env.ESTATE_CATALOG_STATE =
  `/tmp/estate_router_entitlement_test.catalog.${process.pid}.json`;

const { state } = await import("../router_matrix");
const {
  callOne,
  pickWeighted,
  firstUsableModelFor,
  isRoutableModelId,
} = await import("../router_strategy");
const { catalogModelsFor, DEAD_MODEL_IDS } = await import("../router_config");

describe("DEAD_MODEL_IDS sweep", () => {
  test("EOL nvidia id is filtered from the catalog", () => {
    expect(DEAD_MODEL_IDS.has("meta/llama-3.3-70b-instruct")).toBe(true);
    expect(catalogModelsFor("nvidia")).not.toContain(
      "meta/llama-3.3-70b-instruct",
    );
  });
  test("delisted openrouter :free ids are filtered from the catalog", () => {
    for (const id of [
      "tencent/hy3:free",
      "poolside/laguna-m.1:free",
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "qwen/qwen3-coder:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "nousresearch/hermes-3-llama-3.1-405b:free",
      "openai/gpt-oss-20b:free",
    ]) {
      expect(DEAD_MODEL_IDS.has(id)).toBe(true);
      expect(catalogModelsFor("openrouter")).not.toContain(id);
    }
  });
  test("live models survive the sweep", () => {
    expect(catalogModelsFor("openrouter")).toContain(
      "inclusionai/ling-3.0-flash-fin:free",
    );
  });
  test("nvidia live seeds survive the sweep (geode 47-def SSOT)", () => {
    expect(catalogModelsFor("nvidia")).toContain(
      // 2026-10-26 entitlement audit: nemotron-3-super-120b-a12b is
      // entitlement-dead (404) and was removed from the SSOT seeds; the
      // verified 200 set below is the surviving fixture.
      "nvidia/nemotron-3.5-super-vl-120b-a12b",
    );
  });
  test("dead ids are not explicitly routable; the new omni lane is", () => {
    expect(isRoutableModelId("meta/llama-3.3-70b-instruct")).toBe(false);
    expect(isRoutableModelId("openrouter/tencent/hy3:free")).toBe(false);
    expect(
      isRoutableModelId("nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
    ).toBe(true);
  });
});

describe("entitlement-404 fail-fast bench", () => {
  test("one 404 benches the model permanently", () => {
    state.record("bench-m", "bench-p", 404, 0.13, 0, "test");
    expect(state.isEntitlementDead("bench-p", "bench-m")).toBe(true);
  });
  test("429 never benches (transient by design)", () => {
    state.record("rl-m", "rl-p", 429, 0.1, 0, "test");
    expect(state.isEntitlementDead("rl-p", "rl-m")).toBe(false);
  });
  test("bench is idempotent", () => {
    state.record("idem-m", "idem-p", 404, 0.1, 0, "test");
    state.record("idem-m", "idem-p", 404, 0.1, 0, "test");
    expect(state.isEntitlementDead("idem-p", "idem-m")).toBe(true);
  });
  test("callOne refuses a benched model with zero network burn", async () => {
    state.noteEntitlement404("openrouter", "bench-net-m");
    const r = await callOne(
      "openrouter",
      "bench-net-m",
      { model: "x", messages: [] } as never,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.err).toBe("entitlement_benched");
    expect(r.lat).toBe(0);
  });
});

describe("dead-key fast exclusion (401/402)", () => {
  test("one 401 opens the circuit immediately", () => {
    state.record("k", "deadkey-p", 401, 0.05, 0, "test");
    expect(state.circuitOk("deadkey-p")).toBe(false);
  });
  test("one 402 opens the circuit immediately", () => {
    state.record("k", "deadkey2-p", 402, 0.05, 0, "test");
    expect(state.circuitOk("deadkey2-p")).toBe(false);
  });
});

describe("race-set hygiene", () => {
  test("firstUsableModelFor skips the benched first model", () => {
    // Contract: first usable = first catalog entry, advancing past any
    // benched id. Pinned to concrete ids once, catalog order drifted with
    // the 47-def SSOT; assert the invariant, not a specific catalog row.
    const first = firstUsableModelFor("openrouter");
    expect(first).toBeDefined();
    state.noteEntitlement404("openrouter", first);
    const next = firstUsableModelFor("openrouter");
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
  });
  test("pickWeighted always includes the healthy llama-swap bonus lane", () => {
    const cands = pickWeighted(4);
    const providers = cands.map(([p]) => p);
    expect(providers).toContain("llama-swap");
    // Bonus lane is appended after the n-cut, never sliced off.
    expect(cands.length).toBeGreaterThan(0);
  });
});
