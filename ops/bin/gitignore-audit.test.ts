// Invariants over the rendered .gitignore — see gitignore-audit.ts header.
import { describe, it, expect } from "bun:test";
import { audit } from "./gitignore-audit";

describe("gitignore-audit", () => {
  it("all invariants hold", () => {
    const results = audit();
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(25);
  });

  it("SSOT files are never ignored", () => {
    for (const r of audit()) {
      if (r.name.startsWith("ssot")) expect(r.ok).toBe(true);
    }
  });

  it("credential classes are always ignored", () => {
    for (const r of audit()) {
      if (r.name.startsWith("secret")) expect(r.ok).toBe(true);
    }
  });
});
