// gitignore-audit.ts — mechanical invariants over the rendered .gitignore.
// Born from the 2026-10-15 incident: 4 stacked template layers ship unanchored
// `*.log` / `var/` / `lib/` / `**/[Pp]ackages/*` rules that silently swallow
// estate source and SSOT files at any depth. These invariants must hold forever.
//
// Run: bun ops/bin/gitignore-audit.ts        (exit 1 on any violation)
//      bun test ops/bin/gitignore-audit.test.ts
import { render, ESTATE_ROOT } from "./gitignore-sync";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

function gitCheckIgnore(rel: string): "ignored" | "eligible" {
  try {
    execSync(`git check-ignore -q ${JSON.stringify(rel)}`, { cwd: ESTATE_ROOT, stdio: "pipe" });
    return "ignored";
  } catch {
    return "eligible"; // nonzero exit = not ignored
  }
}

function renderEqualsDisk(): boolean {
  try {
    const { loadManifest } = require("./gitignore-sync") as typeof import("./gitignore-sync");
    const { content } = render(loadManifest());
    return content === readFileSync(join(ESTATE_ROOT, ".gitignore"), "utf8");
  } catch {
    return false;
  }
}

type Verdict = { name: string; ok: boolean; detail?: string };

// files whose clone-reproducibility depends on being tracked
const SSOT_TRACKED = [
  ".env",
  "config/ports.env",
  "config/hodos-ssot/route.env",
  "config/tau/agent/config.yml",
  "pitchfork.toml",
];

// credential classes that must be ignored at any depth
const SECRETS_IGNORED = [
  ".secrets",
  ".secrets.json",
  "config/tau/.env",
  "config/tau/agent/auth.json",
  "x/test.pem",
  "x/id_rsa",
  "x/id_ed25519",
  "x/doorbell.foo.key",
  "x/auth.json",
  "x/creds.token",
];

// estate source dirs that template layers must not swallow
const SOURCE_NOT_SWALLOWED = [
  "skills/tau-session-audit/helper/x.ts",
  "skills/tau-session-audit/reports/probe.log",
  "ops/bin/x.ts",
  "ops/gitignore/layers/x.gitignore",
  "config/tau/extensions/nemotron/lib/x.ts",
  "packages/Estate-utils/x.ts",
  "packages/metaharness/x.ts",
  "tools/stash-guard/x.py",
  "docs/x.md",
];

export function audit(): Verdict[] {
  const v: Verdict[] = [];
  for (const f of SSOT_TRACKED) {
    const ignored = gitCheckIgnore(f) === "ignored";
    v.push({ name: `ssot tracked: ${f}`, ok: !ignored, detail: ignored ? "ignored — clone unreproducible" : undefined });
  }
  for (const f of SECRETS_IGNORED) {
    const ignored = gitCheckIgnore(f) === "ignored";
    v.push({ name: `secret ignored: ${f}`, ok: ignored, detail: ignored ? undefined : "NOT ignored — credential leak risk" });
  }
  for (const f of SOURCE_NOT_SWALLOWED) {
    const ignored = gitCheckIgnore(f) === "ignored";
    v.push({ name: `source eligible: ${f}`, ok: !ignored, detail: ignored ? "swallowed by a template-layer rule" : undefined });
  }
  const inSync = renderEqualsDisk();
  v.push({ name: "rendered .gitignore in sync with layers", ok: inSync, detail: inSync ? undefined : "run: bun ops/bin/gitignore-sync.ts" });
  return v;
}

if (import.meta.main) {
  const results = audit();
  let bad = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` -- ${r.detail}` : ""}`);
    if (!r.ok) bad++;
  }
  console.log(`\n${results.length - bad}/${results.length} invariants hold`);
  process.exit(bad ? 1 : 0);
}
