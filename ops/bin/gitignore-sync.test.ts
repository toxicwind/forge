// gitignore-sync.test.ts — permanent tests for the generated estate .gitignore.
// Run: bun test ops/bin/gitignore-sync.test.ts
// The contract under test is consumer-visible: what git actually ignores,
// and that drift is detected. Rendering is only meaningful insofar as git
// agrees and the exit code actually moves.
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render, loadManifest, ESTATE_ROOT } from "./gitignore-sync.ts";

/**
 * Ask git whether it would ignore a path, using a throwaway repo seeded with
 * the rendered .gitignore. Never consults the real estate index.
 */
function gitIgnores(rules: string, path: string) {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-probe-"));
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), rules);
  writeFileSync(join(dir, "nested", "probe.txt"), "x");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** A standalone estate root carrying only what the script needs. */
function fixtureEstate() {
  const root = mkdtempSync(join(tmpdir(), "gitignore-estate-"));
  mkdirSync(join(root, "ops", "bin"), { recursive: true });
  cpSync(join(ESTATE_ROOT, "ops", "gitignore"), join(root, "ops", "gitignore"), { recursive: true });
  cpSync(join(ESTATE_ROOT, "ops", "bin", "gitignore-sync.ts"), join(root, "ops", "bin"));
  return { root, script: join(root, "ops", "bin", "gitignore-sync.ts") };
}

function runSync(script: string, arg: string) {
  try {
    const out = execFileSync("bun", [script, arg], { stdio: "pipe" });
    return { code: 0, out: out.toString() };
  } catch (err) {
    const e = err as { status: number | null; stderr: Buffer };
    return { code: e.status ?? -1, out: e.stderr.toString() };
  }
}

test("render is deterministic across calls", () => {
  expect(render().content).toBe(render().content);
  expect(render().content.length).toBeGreaterThan(0);
});

test("every manifest entry is actually consumed", () => {
  const manifest = loadManifest();
  const { sections } = render(manifest);
  expect(sections).toHaveLength(manifest.templates.length + manifest.layers.length);
});

test("layout tiers are ignored: ranch/, vendored/, var/", () => {
  const rules = render().content;
  expect(gitIgnores(rules, "ranch/herd/src/main.rs")).toBe(true);
  expect(gitIgnores(rules, "vendored/Hyprland/README.md")).toBe(true);
  expect(gitIgnores(rules, "var/archives/backup.tgz")).toBe(true);
});

test("control-plane source is NOT ignored", () => {
  const rules = render().content;
  expect(gitIgnores(rules, "ops/bin/gitignore-sync.ts")).toBe(false);
  expect(gitIgnores(rules, "config/ports.env")).toBe(false);
  expect(gitIgnores(rules, "docs/estate-map.md")).toBe(false);
});

test("estate/.env is tracked while .env.local is ignored", () => {
  const rules = render().content;
  expect(gitIgnores(rules, ".env")).toBe(false);
  expect(gitIgnores(rules, ".env.local")).toBe(true);
});

test("vendored ecosystem templates are applied, not just the layers", () => {
  const rules = render().content;
  expect(gitIgnores(rules, "packages/x/node_modules/pkg/index.js")).toBe(true);
  expect(gitIgnores(rules, "svc/__pycache__/mod.cpython-312.pyc")).toBe(true);
  expect(gitIgnores(rules, "engine/target/debug/build")).toBe(true);
});

test("daemon-recreated root runtime dirs are ignored", () => {
  const rules = render().content;
  expect(gitIgnores(rules, "log/drift-audit/run.log")).toBe(true);
  expect(gitIgnores(rules, "data/keypool-health.json")).toBe(true);
});

test("--check exit code tracks drift: clean -> 0, drifted -> 1, repaired -> 0", () => {
  const { root, script } = fixtureEstate();
  const target = join(root, ".gitignore");

  // Nothing on disk yet: not a clean tree, must not pass.
  expect(runSync(script, "--check").code).toBe(1);

  // Render, then the generated file is by definition in sync.
  expect(runSync(script, "").code).toBe(0);
  expect(runSync(script, "--check").code).toBe(0);

  // Hand-edit it the way a well-meaning human would.
  writeFileSync(target, `${readFileSync(target, "utf8")}\n# hand-added rule\n`);
  const drifted = runSync(script, "--check");
  expect(drifted.code).toBe(1);
  expect(drifted.out).toContain("DRIFT");

  // Re-render repairs it and the check goes green again.
  expect(runSync(script, "").code).toBe(0);
  expect(runSync(script, "--check").code).toBe(0);
});

test("missing template fails loudly instead of rendering a short file", () => {
  const manifest = loadManifest();
  const broken = { ...manifest, templates: [...manifest.templates, "NotATemplate.gitignore"] };
  expect(() => render(broken)).toThrow(/missing template/);
});

test("missing layer fails loudly", () => {
  const manifest = loadManifest();
  const broken = { ...manifest, layers: [...manifest.layers, "99-not-a-layer.gitignore"] };
  expect(() => render(broken)).toThrow(/missing layer/);
});