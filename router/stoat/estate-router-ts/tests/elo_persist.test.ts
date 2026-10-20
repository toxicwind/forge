// Elo durability (2026-09-21): provider Elo is written through to the
// HealthDB on every live update, restored on restart, falls back to
// bench-priors.json when no stored row exists, and is never clobbered by
// priors on hot-reload. Initial bench seeding is in-memory ONLY -- fallback
// priors are not learned state and never create elo_state rows.
//
//  1. Kill-restart round trip: live-learned Elo survives close + reopen.
//  2. No stored row -> bench prior (from the committed bench-priors.json).
//  3. Hot-reload (applyBenchPriors) never re-seeds restored/learned Elo.
//  4. Untouched providers still re-seed on priors refresh (benchlink
//     behavior preserved).
//  5. Failure decrements persist too.
//  6. Fallback priors never create elo_state rows (no prior persistence).
//  7. Equality edge: a restored value exactly equal to the bench prior is
//     still protected across a priors refresh (persisted set, not numeric
//     comparison).
//  8. Subprocess restart: values survive a real process exit, not just
//     close/reopen in one process.
//  9. Corrupt DB fails open: Matrix still constructs, routing on priors.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Must be set before the router modules are imported (DB_PATH and the
// catalog state path are read once at import). The catalog path is unique
// per run so no persisted quarantine leaks between runs.
// The module-level `state` singleton uses this; the tests below construct
// their own Matrix instances on per-test temp DBs.
process.env.ESTATE_DB = "/tmp/estate_router_elo_persist_module.db";
process.env.ESTATE_CATALOG_STATE =
  `/tmp/estate_router_elo_persist_test.catalog.${process.pid}.json`;

const { Matrix } = await import("../router_matrix");
const { PROVIDERS } = await import("../router_config");
const { HealthDB } = await import("../router_health");

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elo-persist-"));
  return path.join(dir, "router.db");
}

const PRIORS_URL = new URL("../bench-priors.json", import.meta.url);

function readPriors(): Record<string, number> {
  const doc = JSON.parse(fs.readFileSync(PRIORS_URL, "utf8"));
  const out: Record<string, number> = {};
  for (const [p, pr] of Object.entries(doc.priors || {})) {
    const elo = (pr as { elo?: number }).elo;
    if (typeof elo === "number" && Number.isFinite(elo)) out[p] = elo;
  }
  return out;
}

function eloRowCount(db: string): number {
  const ro = new Database(db, { readonly: true });
  const row = ro
    .query(`SELECT COUNT(*) AS n FROM elo_state`)
    .get() as { n: number };
  ro.close();
  return row.n;
}

const PROVS = Object.keys(PROVIDERS);

describe("Elo persistence", () => {
  test("kill-restart round trip restores live-learned Elo, not priors", () => {
    const db = tmpDb();
    const m1 = new Matrix(db);
    const p = "groq";
    const prior = m1.elo.get(p);
    expect(typeof prior).toBe("number");
    for (let i = 0; i < 5; i++) m1.record("elo-test-model", p, 200, 0.5);
    const learned = m1.elo.get(p)!;
    expect(learned).toBe(prior! + 5 * 16);
    // Write-through: the row is already in the DB before any restart.
    const ro = new Database(db, { readonly: true });
    const row = ro
      .query(`SELECT elo FROM elo_state WHERE provider=?`)
      .get(p) as { elo: number } | null;
    ro.close();
    expect(row?.elo).toBe(learned);
    // Simulate death: close every handle, then reopen.
    m1.health.conn.close();
    const m2 = new Matrix(db);
    expect(m2.elo.get(p)).toBe(learned);
    m2.health.conn.close();
  });

  test("no stored row falls back to bench priors", () => {
    const db = tmpDb();
    const m = new Matrix(db);
    const priors = readPriors();
    for (const p of PROVS) {
      expect(m.elo.get(p)).toBe(priors[p] ?? 1000);
    }
    m.health.conn.close();
  });

  test("hot-reload never clobbers restored Elo with priors", () => {
    const db = tmpDb();
    const m1 = new Matrix(db);
    const p = "cerebras";
    const prior = m1.elo.get(p)!;
    for (let i = 0; i < 3; i++) m1.record("elo-test-model", p, 429, 0.5);
    const learned = m1.elo.get(p)!;
    expect(learned).toBe(prior - 3 * 8); // moved via live traffic
    m1.health.conn.close();
    const m2 = new Matrix(db);
    expect(m2.elo.get(p)).toBe(learned); // restored, not the prior
    // Pretend bench-priors.json changed: force re-evaluation.
    m2.priorsMtime = 0;
    const r = m2.applyBenchPriors();
    expect(r.reloaded).toBe(true);
    expect(r.reseeded).not.toContain(p);
    expect(m2.elo.get(p)).toBe(learned);
    m2.health.conn.close();
  });

  test("untouched providers still re-seed when priors refresh", () => {
    const db = tmpDb();
    const m = new Matrix(db);
    const priors = readPriors();
    const p = "mistral";
    expect(m.elo.get(p)).toBe(priors[p] ?? 1000); // untouched by traffic
    m.priorsMtime = 0; // pretend the priors file changed
    const r = m.applyBenchPriors();
    expect(r.reseeded).toContain(p);
    expect(m.elo.get(p)).toBe(priors[p] ?? 1000);
    m.health.conn.close();
  });

  test("failure decrements persist too", () => {
    const db = tmpDb();
    const m1 = new Matrix(db);
    const p = "nvidia";
    const prior = m1.elo.get(p)!;
    m1.record("elo-test-model", p, 500, 1.0);
    const after = m1.elo.get(p)!;
    expect(after).toBe(Math.max(100, prior - 32));
    m1.health.conn.close();
    const m2 = new Matrix(db);
    expect(m2.elo.get(p)).toBe(after);
    m2.health.conn.close();
  });

  test("initial bench seeding never persists fallback priors", () => {
    const db = tmpDb();
    const m = new Matrix(db);
    // Zero elo_state rows: priors live in memory only.
    expect(eloRowCount(db)).toBe(0);
    const priors = readPriors();
    for (const p of PROVS) {
      expect(m.elo.get(p)).toBe(priors[p] ?? 1000);
    }
    m.health.conn.close();
  });

  test("equality edge: restored value equal to prior survives priors refresh", () => {
    const db = tmpDb();
    const priors = readPriors();
    const p = "groq";
    const prior = priors[p] ?? 1000;
    // The edge needs stored == prior exactly.
    // Persist exactly the bench prior as if previously learned.
    const h = new HealthDB(db);
    h.saveElo(p, prior);
    h.conn.close();
    // Startup restores it and marks it persisted.
    const m = new Matrix(db);
    expect(m.elo.get(p)).toBe(prior);
    expect(m.persistedEloProviders.has(p)).toBe(true);
    const backup = fs.readFileSync(PRIORS_URL, "utf8");
    try {
      // Priors refresh: groq prior -> prior+100. Old numeric logic (cur === last)
      // would re-seed to the new value; the persisted set must protect it.
      const doc = JSON.parse(backup);
      doc.priors[p].elo = prior + 100;
      doc.generated_ts = new Date().toISOString();
      fs.writeFileSync(PRIORS_URL, JSON.stringify(doc, null, 2));
      m.priorsMtime = 0; // force re-evaluation
      const r = m.applyBenchPriors();
      expect(r.reloaded).toBe(true);
      expect(r.reseeded).not.toContain(p);
      expect(m.elo.get(p)).toBe(prior); // protected: restored, not re-seeded
    } finally {
      fs.writeFileSync(PRIORS_URL, backup);
    }
    m.health.conn.close();
  });

  test("subprocess restart: values survive a real process exit", () => {
    const db = tmpDb();
    const modPath = new URL("../router_matrix.ts", import.meta.url).pathname;
    const writer = `
      process.env.ESTATE_DB = ${JSON.stringify(db)};
      const { Matrix } = await import(${JSON.stringify(modPath)});
      const m = new Matrix();
      for (let i = 0; i < 4; i++) m.record("subproc-model", "nvidia", 200, 0.5);
      console.log("wrote:" + m.elo.get("nvidia"));
    `;
    const r1 = Bun.spawnSync([process.execPath, "-e", writer], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r1.exitCode !== 0)
      console.log("writer stderr:", r1.stderr.toString().slice(-2000));
    expect(r1.exitCode).toBe(0);
    // The writer's exact value is derived from the live bench prior; the
    // property under test is that the READER restores that same value.
    const wrote = r1.stdout.toString().match(/wrote:(\d+)/);
    expect(wrote).not.toBeNull();
    const wroteVal = wrote[1];
    // First process is fully gone; a new process must restore from the DB.
    const reader = `
      process.env.ESTATE_DB = ${JSON.stringify(db)};
      const { Matrix } = await import(${JSON.stringify(modPath)});
      const m = new Matrix();
      console.log("read:" + m.elo.get("nvidia"));
    `;
    const r2 = Bun.spawnSync([process.execPath, "-e", reader], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r2.exitCode !== 0)
      console.log("reader stderr:", r2.stderr.toString().slice(-2000));
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.toString()).toContain(`read:${wroteVal}`);
  });

  test("corrupt DB fails open: Matrix constructs, routing on priors", () => {
    const db = tmpDb();
    fs.writeFileSync(db, "this is not a database");
    const m = new Matrix(db); // must not throw
    const priors = readPriors();
    for (const p of PROVS) {
      expect(m.elo.get(p)).toBe(priors[p] ?? 1000);
    }
    // Live updates still work in memory.
    m.record("elo-test-model", "groq", 200, 0.5);
    expect(m.elo.get("groq")).toBe((priors["groq"] ?? 1000) + 16);
    m.health.conn.close();
  });
});
