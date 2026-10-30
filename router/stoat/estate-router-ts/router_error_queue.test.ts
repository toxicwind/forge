/**
 * router_error_queue.test.ts — the dynamic error router contract.
 *
 * All timing is injected and CONTROLLABLE (deferred budget timer — no real
 * timers): the zero-transport guarantee, FIFO wake semantics, and the
 * wait-vs-reroute matrix are asserted deterministically.
 */
import { describe, expect, test } from "bun:test";
import {
  GlobalErrorQueue,
  DEFAULT_WAIT_MS,
  _resetErrorQueueForTests,
} from "./router_error_queue.ts";

/** Queue whose budget timer never fires until flushBudgets() is called. */
function makeQueue() {
  const q = new GlobalErrorQueue();
  let t = 0;
  const pending: Array<() => void> = [];
  q.now = () => t;
  q.sleep = (ms: number) =>
    new Promise<void>((res) => {
      pending.push(() => {
        t += ms;
        res();
      });
    });
  return {
    q,
    flushBudgets: () => {
      for (const f of pending.splice(0)) f();
    },
    get pendingBudgets() {
      return pending.length;
    },
  };
}

describe("dynamic error router", () => {
  test("non-429 statuses dispatch untouched (zero wait)", async () => {
    const { q } = makeQueue();
    const d = await q.decide("p", 500, "boom", {});
    expect(d.action).toBe("dispatch");
    expect(d.waitedMs).toBe(0);
    expect(d.signal).toBeUndefined();
  });

  test("spend-cap family reroutes immediately with zero wait", async () => {
    const { q } = makeQueue();
    q.setConcurrency("freeinference", 2);
    q.begin("freeinference");
    q.begin("freeinference");
    const d = await q.decide("freeinference", 429, "quota exceeded: insufficient balance", {});
    expect(d.action).toBe("reroute");
    expect(d.waitedMs).toBe(0);
    expect(d.signal?.family).toBe("spend_cap");
    expect(d.signal?.scope).toBe("account");
  });

  test("7-day budget reroutes immediately", async () => {
    const { q } = makeQueue();
    q.setConcurrency("x", 1);
    q.begin("x");
    const d = await q.decide("x", 429, "rolling 7 day budget exceeded", {});
    expect(d.action).toBe("reroute");
    expect(d.signal?.family).toBe("seven_day");
  });

  test("saturated concurrency-family 429 waits; slot wake dispatches before budget", async () => {
    const { q, flushBudgets, pendingBudgets } = makeQueue();
    q.setConcurrency("freeinference", 2);
    q.begin("freeinference");
    q.begin("freeinference");
    const decisionP = q.decide("freeinference", 429, "too many concurrent requests", {});
    await Promise.resolve(); // let decide() register the waiter + arm budget
    // Slot opens mid-wait (another request finally): FIFO head wakes FIRST.
    q.end("freeinference");
    // Budget fires afterwards — must be a no-op (done flag).
    flushBudgets();
    const d = await decisionP;
    expect(d.action).toBe("dispatch");
    expect(d.signal?.family).toBe("concurrency");
  });

  test("budget exhausted on a still-saturated lane reroutes", async () => {
    const { q, flushBudgets } = makeQueue();
    q.setConcurrency("freeinference", 1);
    q.begin("freeinference");
    const decisionP = q.decide("freeinference", 429, "too many concurrent requests", {}, { budgetMs: 2000 });
    await Promise.resolve();
    flushBudgets(); // budget fires, nobody releases the slot
    const d = await decisionP;
    expect(d.action).toBe("reroute");
    expect(d.signal?.family).toBe("concurrency");
  });

  test("lane with unknown concurrency never queue-gates", async () => {
    const { q } = makeQueue();
    const d = await q.decide("nolane", 429, "too many concurrent requests", {});
    expect(d.action).toBe("dispatch");
  });

  test("end() wakes exactly one FIFO waiter per released slot", async () => {
    const { q, flushBudgets } = makeQueue();
    q.setConcurrency("p", 1);
    q.begin("p");
    let opened = 0;
    const w1 = q.waitForSlot("p", 1000).then((v) => (opened += v ? 1 : 0));
    const w2 = q.waitForSlot("p", 1000).then((v) => (opened += v ? 1 : 0));
    q.end("p"); // one slot released -> exactly one wake
    await w1;   // w1 was FIFO head
    expect(opened).toBe(1);
    flushBudgets(); // w2 only ever resolves false via budget (not a wake)
    await w2;
    expect(opened).toBe(1); // w2 was a budget reroute, not a slot wake
  });

  test("wait budget default is the 2s global (architect)", () => {
    expect(DEFAULT_WAIT_MS).toBe(2000);
  });

  test("transient rpm 429 on an unsaturated lane dispatches", async () => {
    const { q } = makeQueue();
    const d = await q.decide("p", 429, "mystery", { "retry-after": "1" });
    expect(d.action).toBe("dispatch");
    expect(d.signal?.family).toBe("rpm");
  });

  _resetErrorQueueForTests();
});
