// gitignore-sync.test.ts — permanent tests for the generated estate .gitignore.
// Run: bun test ops/bin/gitignore-sync.test.ts
// The contract under test is consumer-visible: what git actually ignores,
// and that drift is detected. Rendering is only meaningful insofar as git
// agrees and the exit code actually moves.
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  cpSync,
  readlinkSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
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
  // The estate and forge repos share this script through a HARDLINK (same
  // inode, two paths), so cpSync with a FILE source + DIRECTORY dest trips
  // ENOTDIR against the existing ops/bin dir. Copy the contents to the exact
  // file path the fixture will run.
  const src = join(ESTATE_ROOT, "ops", "bin", "gitignore-sync.ts");
  const dest = join(root, "ops", "bin", "gitignore-sync.ts");
  copyFileSync(src, dest);
  return { root, script: dest };
}

function runSync(script: string, arg: string) {
  try {
    // cwd = the fixture root: the script resolves the repo it renders for
    // from the CWD (symlinked script paths are resolved by Bun before the
    // script sees them, so the path cannot carry that signal).
    const out = execFileSync("bun", [script, arg], {
      stdio: "pipe",
      cwd: dirname(script),
    });
    return { code: 0, out: out.toString() };
  } catch (err) {
    // Bun's execFileSync error carries stdout/stderr as strings (not Buffers)
    // and may omit them entirely, so read defensively.
    const e = err as {
      status?: number | null;
      code?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const text = (v: Buffer | string | undefined): string =>
      v === undefined ? "" : typeof v === "string" ? v : v.toString();
    return {
      code: e.status ?? e.code ?? -1,
      out: text(e.stdout) + text(e.stderr),
    };
  }
}

test("render is deterministic across calls", () => {
  expect(render().content).toBe(render().content);
  expect(render().content.length).toBeGreaterThan(0);
});

test("every manifest entry is actually consumed", () => {
  const manifest = loadManifest();
  const { sections } = render(manifest);
  expect(sections).toHaveLength(
    manifest.preLayers.length +
      manifest.templates.length +
      manifest.postLayers.length
  );
});

test("layout tiers are ignored: vendored/, var/", () => {
  const rules = render().content;
  // ranch/ is NOT an ignored tier any more: the estate moved its product
  // repos to pens/ (AGENTS.md "the bin contract"), so ranch/ is a real
  // source tree at the estate root and must stay tracked.
  expect(gitIgnores(rules, "vendored/Hyprland/README.md")).toBe(true);
  expect(gitIgnores(rules, "var/archives/backup.tgz")).toBe(true);
  expect(gitIgnores(rules, "ranch/herd/src/main.rs")).toBe(false);
});

test("control-plane source is NOT ignored", () => {
  const rules = render().content;
  expect(gitIgnores(rules, "ops/bin/gitignore-sync.ts")).toBe(false);
  expect(gitIgnores(rules, "config/ports.env")).toBe(false);
  expect(gitIgnores(rules, "docs/estate-map.md")).toBe(false);
});

test("estate/.env is ignored while .env.example stays tracked", () => {
  const rules = render().content;
  // The secrets layer (50) ignores .env and .env.* and re-admits only
  // .env.example -- it lands AFTER the upstream templates, so .env is
  // ignored. That is the current, intended contract.
  expect(gitIgnores(rules, ".env")).toBe(true);
  expect(gitIgnores(rules, ".env.local")).toBe(true);
  expect(gitIgnores(rules, ".env.example")).toBe(false);
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
  const broken = {
    ...manifest,
    postLayers: [...manifest.postLayers, "99-not-a-layer.gitignore"],
  };
  expect(() => render(broken)).toThrow(/missing layer/);
});