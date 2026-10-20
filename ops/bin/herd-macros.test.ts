import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  findBlock,
  insertBlock,
  parseFlags,
  renderBlock,
  sectionNameFor,
} from "./herd-macros.ts";

const LLAMA_HELP = `
----- common params -----
-h,    --help, --usage                  print usage and exit
-c,    --ctx-size N                     size of the prompt context (default: 0)
--metrics                               enable prometheus metrics endpoint
--api-key KEY                           api key for authentication
----- example-specific params -----
--host HOST                             ip address to listen
`;

// ik_llama prints bare `general:` headings, indents every option, and exits 1.
const IK_HELP = `
usage: llama-server [options]

general:

  -h,    --help, --usage          print usage and exit
  -c,    --ctx-size N             size of the prompt context

sampling:

  --top-k N                        top-k sampling
`;

const fork = (label: string, help: string) => ({
  label,
  binary: `/bin/${label}/llama-server`,
  flags: parseFlags(help),
});

const HAND_CONFIG = [
  "macros:",
  "  MODEL_DIR: /home/toxic/models",
  '  REASONING_OFF: "--reasoning off"',
  "models:",
  "  m1:",
  "    cmd: ./llama-server",
  "",
].join("\n");

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "herd-macros-"));
  const config = join(dir, "herd.yaml");
  writeFileSync(config, HAND_CONFIG);
  return config;
}

describe("sectionNameFor", () => {
  test("normalizes llama.cpp headings", () => {
    expect(sectionNameFor("common params")).toBe("COMMON");
    expect(sectionNameFor("example-specific params")).toBe("EXAMPLE-SPECIFIC");
  });
});

describe("parseFlags", () => {
  test("captures name, arity and section", () => {
    const flags = parseFlags(LLAMA_HELP);
    expect(flags.get("ctx_size")).toEqual({
      raw: "ctx-size",
      name: "ctx_size",
      takesValue: true,
      section: "COMMON",
    });
    expect(flags.get("metrics")?.takesValue).toBe(false);
    expect(flags.get("host")?.section).toBe("EXAMPLE-SPECIFIC");
  });

  test("keeps the binary's real spelling separate from the macro key", () => {
    const flags = parseFlags(LLAMA_HELP);
    // Macro key is underscored; the emitted flag must keep its hyphens.
    expect(flags.has("api_key")).toBe(true);
    expect(flags.get("api_key")?.raw).toBe("api-key");
  });

  test("parses ik_llama's indented options and colon headings", () => {
    const flags = parseFlags(IK_HELP);
    expect(flags.get("ctx_size")?.takesValue).toBe(true);
    expect(flags.get("top_k")?.section).toBe("SAMPLING");
  });
});

describe("renderBlock", () => {
  test("emits a value placeholder for value-taking flags only", () => {
    const block = renderBlock([fork("a", LLAMA_HELP)]);
    expect(block).toContain('ARG_CTX_SIZE: "--ctx-size ${ARG_CTX_SIZE_VALUE}"');
    expect(block).toContain('ARG_METRICS: "--metrics"');
    expect(block).toContain('ARG_API_KEY: "--api-key ${ARG_API_KEY_VALUE}"');
  });

  test("marks flags a fork does not document", () => {
    const block = renderBlock([fork("a", LLAMA_HELP), fork("b", IK_HELP)]);
    expect(block).toContain("# only:");
  });

  test("is deterministic: the same forks render byte-identical text", () => {
    const forks = [fork("a", LLAMA_HELP), fork("b", IK_HELP)];
    expect(renderBlock(forks)).toBe(renderBlock(forks));
  });

  test("groups by help section, largest group first", () => {
    const block = renderBlock([fork("a", LLAMA_HELP)]);
    const groups = [...block.matchAll(/^ {2}# --- (\S+) \((\d+)\) ---$/gm)].map(
      (m) => ({ name: m[1], n: Number(m[2]) }),
    );
    expect(groups.length).toBeGreaterThan(1);
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1].n).toBeGreaterThanOrEqual(groups[i].n);
    }
  });
});

describe("insertBlock", () => {
  test("places macros inside the macros section, not after models", () => {
    const config = scratch();
    const before = parseYaml(readFileSync(config, "utf8")) as {
      macros: Record<string, string>;
    };
    const block = renderBlock([fork("a", LLAMA_HELP)]);

    // Same path main() takes: insert, then replace.
    const inserted = insertBlock(readFileSync(config, "utf8"), block);
    expect(inserted).not.toBeNull();
    writeFileSync(config, inserted!);
    const rewritten = insertBlock(readFileSync(config, "utf8"), block);
    expect(rewritten).not.toBeNull();
    writeFileSync(config, rewritten!);

    const after = parseYaml(readFileSync(config, "utf8")) as {
      macros: Record<string, string>;
    };
    // Hand-written macros survive verbatim.
    for (const [k, v] of Object.entries(before.macros)) {
      expect(after.macros[k]).toBe(v);
    }
    expect(after.macros.ARG_CTX_SIZE).toBe(
      "--ctx-size ${ARG_CTX_SIZE_VALUE}",
    );
  });

  test("is idempotent across repeated writes", () => {
    const config = scratch();
    const block = renderBlock([fork("a", LLAMA_HELP)]);
    const once = insertBlock(readFileSync(config, "utf8"), block)!;
    writeFileSync(config, once);
    const twice = insertBlock(readFileSync(config, "utf8"), block)!;
    expect(twice).toBe(once);
  });

  test("findBlock round-trips through insertBlock", () => {
    const config = scratch();
    const block = renderBlock([fork("a", LLAMA_HELP)]);
    const inserted = insertBlock(readFileSync(config, "utf8"), block)!;
    expect(findBlock(inserted)).toBe(block);
  });

  test("refuses a config with no models: section to anchor on", () => {
    expect(insertBlock("macros:\n  A: b\n", "BLOCK")).toBeNull();
  });
});