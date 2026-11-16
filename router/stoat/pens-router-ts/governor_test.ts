// Deterministic tests for the model-pressure governor port
// (flock proxy/src/governor.rs -> router_matrix.ts Governor).
// Run: bun governor_test.ts

// Must be set before the router modules are imported (DB_PATH and the
// catalog state path are read once at import). A static import would hoist
// above this assignment, so the values come in via dynamic import; the
// type-only import is erased at runtime and stays static.
process.env.ESTATE_DB = "/tmp/estate_router_governor_test.db";
process.env.ESTATE_CATALOG_STATE =
  `/tmp/estate_router_governor_test.catalog.${process.pid}.json`;

import type { ModelPermit } from "./router_matrix.ts";
const { Governor, isWorkerExhausted } = await import("./router_matrix.ts");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let passed = 0;
function ok(cond: boolean, name: string): void {
  if (!cond) {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok - ${name}`);
}
function gov(): Governor {
  return new Governor(null);
}
function admitN(
  g: Governor,
  key: string,
  n: number,
  nowS: number,
): ModelPermit[] {
  const out: ModelPermit[] = [];
  for (let i = 0; i < n; i++) {
    const p = g.admit(key, nowS);
    if (!p) {
      console.error(`FAIL admitN: admission ${i} of ${n} refused`);
      process.exit(1);
    }
    out.push(p);
  }
  return out;
}
function releaseAll(ps: ModelPermit[]): void {
  for (const p of ps) p.release();
}

const T0 = 1_700_000_000;

// 1. exhaustion signature detection
ok(
  isWorkerExhausted(
    '{"detail":"ResourceExhausted: Worker local total request limit reached (32/32)"}',
  ),
  "detects worker-exhaustion signature",
);
ok(!isWorkerExhausted('{"error":"rate limited"}'), "rejects other errors");
ok(!isWorkerExhausted(""), "rejects empty body");

// 2. ungoverned model admits without bound
{
  const g = gov();
  const ps = admitN(g, "m", 500, T0);
  ok(ps.length === 500, "ungoverned model admits without bound");
  releaseAll(ps);
}

// 3. exhaustion engages at half the observed in-flight count
{
  const g = gov();
  const ps = admitN(g, "m", 6, T0);
  g.noteExhausted("m", T0); // limit 3; all 6 permits still held
  const later = T0 + Governor.EXHAUST_BACKOFF_S;
  ok(
    g.admit("m", later) === null,
    "at cap: nothing admitted while inflight exceeds cap",
  );
  for (let i = 0; i < 4; i++) ps[i].release(); // inflight 2
  const p1 = g.admit("m", later);
  ok(p1 !== null, "draining below cap re-opens admission");
  ok(g.admit("m", later) === null, "cap of 3 reached again");
  if (p1) p1.release();
  releaseAll(ps.slice(4));
}

// 4. single in-flight: floor of 1, not 0
{
  const g = gov();
  const ps = admitN(g, "m", 1, T0);
  g.noteExhausted("m", T0); // floor(1/2)=0 -> max(1,0)=1
  releaseAll(ps);
  const later = T0 + Governor.EXHAUST_BACKOFF_S;
  const p = g.admit("m", later);
  ok(p !== null, "single-inflight engages at 1: first admitted");
  ok(g.admit("m", later) === null, "single-inflight engages at 1: second refused");
  if (p) p.release();
}

// 5. 2-second drain gap
{
  const g = gov();
  const ps = admitN(g, "m", 1, T0);
  g.noteExhausted("m", T0);
  releaseAll(ps);
  ok(g.admit("m", T0 + 0.5) === null, "drain gap blocks admissions briefly");
  const p = g.admit("m", T0 + Governor.EXHAUST_BACKOFF_S);
  ok(p !== null, "admission re-opens after drain gap");
  if (p) p.release();
}

// 6. +1 concurrency per stable minute
{
  const g = gov();
  const ps = admitN(g, "m", 4, T0);
  g.noteExhausted("m", T0); // limit 2
  releaseAll(ps);
  const t1 = T0 + Governor.EXHAUST_BACKOFF_S;
  const q = admitN(g, "m", 2, t1);
  ok(g.admit("m", t1) === null, "at the engaged cap of 2");
  const t2 = T0 + Governor.GROW_INTERVAL_S;
  const r = g.admit("m", t2);
  ok(r !== null, "cap grows to 3 after a stable minute");
  ok(g.admit("m", t2) === null, "cap 3 reached");
  if (r) r.release();
  releaseAll(q);
}

// 7. dissolves after 30 clean minutes
{
  const g = gov();
  const ps = admitN(g, "m", 2, T0);
  g.noteExhausted("m", T0); // limit 1
  releaseAll(ps);
  const clean = T0 + Governor.DISSOLVE_AFTER_S;
  const q = admitN(g, "m", 100, clean);
  ok(q.length === 100, "dissolves after a long clean period");
  releaseAll(q);
}

// 8. operator override pins the cap and skips adaptation
{
  const g = gov();
  g.overrides.set("m", 2);
  const a = g.admit("m", T0);
  const b = g.admit("m", T0);
  ok(a !== null && b !== null, "pinned cap admits up to 2");
  ok(g.admit("m", T0) === null, "pinned cap of 2 enforced");
  g.noteExhausted("m", T0); // drain gap only, no cap change
  if (a) a.release();
  ok(g.admit("m", T0) === null, "drain gap still blocks pinned model");
  const later = T0 + Governor.EXHAUST_BACKOFF_S;
  const c = g.admit("m", later);
  ok(c !== null, "pinned cap unchanged after gap");
  const muchLater = T0 + Governor.GROW_INTERVAL_S * 5;
  ok(g.admit("m", muchLater) === null, "no growth for pinned model");
  if (b) b.release();
  if (c) c.release();
}

// 9. models are independent
{
  const g = gov();
  const hot = admitN(g, "hot", 2, T0);
  g.noteExhausted("hot", T0);
  const cold = admitN(g, "cold", 50, T0);
  ok(cold.length === 50, "models are independent");
  releaseAll(hot);
  releaseAll(cold);
}

// 10. permit release is idempotent and frees the slot
{
  const g = gov();
  const p = g.admit("m", T0);
  if (!p) {
    console.error("FAIL permit release: admission refused");
    process.exit(1);
  }
  p.release();
  p.release(); // idempotent — no double-decrement
  const q = admitN(g, "m", 3, T0);
  ok(q.length === 3, "release is idempotent and frees the slot");
  releaseAll(q);
}

// 11. snapshot/restore round-trip
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-test-"));
  const p = path.join(dir, "governor.json");
  const g = new Governor(p);
  const ps = admitN(g, "m", 6, T0);
  g.noteExhausted("m", T0);
  g.save();
  const g2 = new Governor(p);
  const ent = g2.entries().find(([k]) => k === "m");
  ok(!!ent && ent[1].limit === 3, "snapshot/restore round-trips the engaged cap");
  ok(ent![1].inflight === 0, "inflight restarts at 0 after restore");
  ok(
    ent![1].exhaustedTotal === 1,
    "exhaustion counter survives restore",
  );
  releaseAll(ps);
  fs.rmSync(dir, { recursive: true });
}

console.log(`\n${passed} governor tests passed`);
