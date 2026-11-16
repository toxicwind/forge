import { test, expect } from "bun:test";
import { sigmaStalenessDays, sigmaNeedsRefresh, sigmaCatalogInfo } from "../sigma-enrich.ts";

test("sigma catalog info reports rows and snapshot", () => {
  const info = sigmaCatalogInfo();
  expect(info.rows).toBeGreaterThan(100);
  expect(info.snapshot).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("sigma staleness days is a finite number", () => {
  const days = sigmaStalenessDays();
  expect(typeof days).toBe("number");
  expect(days).toBeGreaterThanOrEqual(0);
});

test("sigmaNeedsRefresh returns boolean", () => {
  expect(typeof sigmaNeedsRefresh()).toBe("boolean");
});
