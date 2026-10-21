import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_CATALOG_CONTRACT,
  LEGACY_CATALOG_CONTRACT,
  deadIds,
  gatewayRoot,
  loadLiveCatalog,
  normalizeId,
  resolve,
  servingIds,
  writeLiveCatalog,
  type LiveCatalog,
} from "../src/catalog";

function catalogFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cg-catalog-"));
  const path = join(dir, "live.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
}

const FIXTURE: LiveCatalog = {
  contract: LIVE_CATALOG_CONTRACT,
  generatedAt: "2026-10-02T00:00:00.000Z",
  deadIds: ["meta-llama/llama-3.3-70b-instruct"],
  providers: {
    "herd": { serving: ["beellama/qwen-flash-64k", "beellama/exaone-4-0-1-2b-iq4xs"], quarantined: [], discovered: true },
    nvidia: { serving: ["nvidia/nemotron-3.5-lightning-30b-a3b"], quarantined: ["nvidia/retired-slug"], discovered: true },
  },
};

describe("normalizeId", () => {
  test("strips whitespace, case, and scheme noise", () => {
    expect(normalizeId("  Meta-Llama/Llama-3.1-8B-Instruct ")).toBe("meta-llama/llama-3.1-8b-instruct");
    expect(normalizeId("https://host/v1")).toBe("host/v1");
  });
});

describe("gatewayRoot", () => {
  // Regression: probeGateway appended /v1/models to a base that already ended in
  // /v1, producing a 404 that was indistinguishable from a dead gateway.
  test("every common base form normalizes to the same root", () => {
    const want = "http://127.0.0.1:25100";
    expect(gatewayRoot(`${want}`)).toBe(want);
    expect(gatewayRoot(`${want}/v1`)).toBe(want);
    expect(gatewayRoot(`${want}/v1/`)).toBe(want);
    expect(gatewayRoot(`  ${want}/v1  `)).toBe(want);
  });
});

describe("loadLiveCatalog", () => {
  test("accepts the canonical contract", () => {
    const loaded = loadLiveCatalog(catalogFile(FIXTURE));
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.contract.canonical).toBe(true);
    expect([...servingIds(loaded.catalog)]).toHaveLength(3);
  });

  // The real outage: the file on disk said estate-providers/live-catalog/v1
  // and both readers did `if (contract !== expected) return null`, silently.
  test("accepts the pre-rename contract but flags it", () => {
    const loaded = loadLiveCatalog(catalogFile({ ...FIXTURE, contract: LEGACY_CATALOG_CONTRACT }));
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") return;
    expect(loaded.contract.canonical).toBe(false);
  });

  test("rejects a contract it does not understand", () => {
    const loaded = loadLiveCatalog(catalogFile({ ...FIXTURE, contract: "something-else/v9" }));
    if (loaded.status !== "unknown-contract") {
      expect(loaded.status).toBe("unknown-contract");
      return;
    }
    expect(loaded.contract.saw).toBe("something-else/v9");
    expect(loaded.contract.expected).toContain("estate-pinax/live-catalog/v1");
  });

  test("a missing file is a reason, not a throw", () => {
    const loaded = loadLiveCatalog("/definitely/not/here/live.json");
    expect(loaded.status).toBe("missing");
  });

  test("malformed JSON is a reason, not a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-bad-"));
    const path = join(dir, "live.json");
    writeFileSync(path, "{not json", "utf8");
    expect(loadLiveCatalog(path).status).toBe("malformed");
  });
});

describe("resolve", () => {
  test("an exact id resolves to every provider that serves it", () => {
    const hits = resolve(FIXTURE, "nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.provider).toBe("nvidia");
  });

  test("a bare name resolves across providers rather than picking one", () => {
    const hits = resolve(FIXTURE, "qwen-flash-64k");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tier).toBe("bare");
  });

  test("a dead id is never marked live", () => {
    const withDead: LiveCatalog = {
      ...FIXTURE,
      providers: { nvidia: { serving: ["nvidia/retired-slug"], quarantined: ["nvidia/retired-slug"], discovered: true } },
    };
    expect(resolve(withDead, "nvidia/retired-slug")[0]!.live).toBe(false);
  });

  test("an unknown id resolves to nothing instead of guessing", () => {
    expect(resolve(FIXTURE, "estate/free")).toHaveLength(0);
    expect(resolve(FIXTURE, "local-fast")).toHaveLength(0);
  });

  test("substring matching needs at least 3 characters", () => {
    expect(resolve(FIXTURE, "flu")).toHaveLength(0);
    expect(resolve(FIXTURE, "flash").length).toBeGreaterThan(0);
  });

  test("an empty query never resolves", () => {
    expect(resolve(FIXTURE, "   ")).toHaveLength(0);
  });
});

describe("deadIds", () => {
  test("collects quarantined entries and the explicit dead list", () => {
    const dead = deadIds(FIXTURE);
    expect(dead.has("nvidia/retired-slug")).toBe(true);
    expect(dead.has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
    expect(dead.has("beellama/qwen-flash-64k")).toBe(false);
  });
});

describe("writeLiveCatalog", () => {
  test("emits the canonical contract so both readers accept the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-write-"));
    const path = join(dir, "live.json");
    writeLiveCatalog(path, { deadIds: FIXTURE.deadIds, providers: FIXTURE.providers });
    const back = JSON.parse(readFileSync(path, "utf8")) as LiveCatalog;
    expect(back.contract).toBe(LIVE_CATALOG_CONTRACT);
    const reloaded = loadLiveCatalog(path);
    expect(reloaded.status === "ok" && reloaded.contract.canonical).toBe(true);
  });
});
