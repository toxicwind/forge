#!/usr/bin/env bun
// gitignore-sync — render estate/.gitignore from a pinned template library
// plus ordered estate-specific layers. The generated file is never hand-edited.
//
//   bun ops/bin/gitignore-sync.ts            render + write
//   bun ops/bin/gitignore-sync.ts --check    exit 1 if on-disk file has drifted
//   bun ops/bin/gitignore-sync.ts --print    render to stdout, write nothing
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolve the ops root directory (where manifest.json, layers/, templates/ live).
// Bun resolves import.meta.dir to the realpath (follows symlinks).
// We need the manifest/layers/templates relative to the script's location,
// which may be accessed via symlinks (estate/ops → pens/ranch/forge/ops).
// Strategy: try the resolved path first; if manifest not found there,
// fall back to using process.cwd() as base.
function resolveOpsRoot(): string {
  // Direct approach: realpath relative (e.g. pens/ranch/forge/ops/gitignore)
  const direct = join(resolve(import.meta.dir, "..", "gitignore"));
  if (existsSync(join(direct, "manifest.json"))) {
    return direct;
  }
  // Fallback: use cwd-relative path (works when invoked from estate/ or pens/ranch/forge/)
  const fromCwd = join(process.cwd(), "ops", "gitignore");
  if (existsSync(join(fromCwd, "manifest.json"))) {
    return fromCwd;
  }
  // Last resort: direct again
  return direct;
}

// OPS_ROOT is the directory containing manifest.json (ops/gitignore/)
export const OPS_ROOT: string = resolveOpsRoot();
const MANIFEST = join(OPS_ROOT, "manifest.json");
const TEMPLATES_DIR = join(OPS_ROOT, "templates");
const LAYERS_DIR = join(OPS_ROOT, "layers");

// ESTATE_ROOT defaults to the environment variable, otherwise falls back
// to the parent of ops/.
export const ESTATE_ROOT: string = process.env.ESTATE_ROOT ?? resolve(OPS_ROOT, "..");
const OUT = join(ESTATE_ROOT, ".gitignore");

type Manifest = {
  preLayers: string[];
  templates: string[];
  postLayers: string[];
  vendor: { repo: string; pinned: string; path: string; license: string };
};

type Section = {
  title: string;
  source: string;
  lines: number;
};

export function loadManifest(path: string = MANIFEST): Manifest {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`manifest not an object: ${path}`);
  }
  const rec = raw as Record<string, unknown>;
  for (const key of ["preLayers", "templates", "postLayers"] as const) {
    if (!Array.isArray(rec[key])) throw new Error(`manifest.${key} must be an array`);
  }
  return {
    preLayers: rec.preLayers as string[],
    templates: rec.templates as string[],
    postLayers: rec.postLayers as string[],
    vendor: rec.vendor as Manifest["vendor"],
  };
}

export function render(
  manifest: Manifest,
  templatesDir = TEMPLATES_DIR,
  layersDir = LAYERS_DIR,
): { content: string; sections: Section[] } {
  const chunks: string[] = [];
  const sections: Section[] = [];

  const { repo, pinned, license } = manifest.vendor;
  const pin = `# upstream: ${repo} @ ${pinned.slice(0, 12)} (${license})`;

  const emitLayer = (layer: string): void => {
    const path = join(layersDir, layer);
    if (!existsSync(path)) throw new Error(`missing layer: ${path}`);
    const body = readFileSync(path, "utf8").replace(/^\n+/, "").replace(/\s+$/, "");
    sections.push({ title: layer, source: `layers/${layer}`, lines: body.split("\n").length });
    chunks.push(body);
  };

  const emitTemplate = (template: string): void => {
    const path = join(templatesDir, template);
    if (!existsSync(path)) throw new Error(`missing template: ${path}`);
    const body = readFileSync(path, "utf8").replace(/^\n+/, "").replace(/\s+$/, "");
    const name = template.split("/").pop() ?? template;
    sections.push({
      title: template,
      source: `templates/${template}`,
      lines: body.split("\n").length,
    });
    // The header carries provenance so a drifted .gitignore can be traced
    // back to the template and pin it came from.
    chunks.push(
      `# ── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}\n${pin}\n${body}`,
    );
  };

  // Order is load-bearing. Estate-specific rules must be able to override the
  // upstream templates (Python.gitignore ships `.env`; the estate tracks it),
  // so postLayers render last.
  for (const layer of manifest.preLayers) emitLayer(layer);
  for (const template of manifest.templates) emitTemplate(template);
  for (const layer of manifest.postLayers) emitLayer(layer);

  return { content: `${chunks.join("\n\n")}\n`, sections };
}

function main(argv: string[]): void {
  const { content, sections } = render(loadManifest());

  if (argv.includes("--print")) {
    process.stdout.write(content);
    return;
  }

  if (argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current === content) {
      process.stdout.write(`gitignore: in sync (${sections.length} sections)\n`);
      return;
    }
    const want = content.split("\n").length;
    const have = current.split("\n").length;
    process.stderr.write(`gitignore DRIFT: ${have} lines on disk, ${want} rendered\n`);
    process.stderr.write(`fix: bun ${join("ops", "bin", "gitignore-sync.ts")}\n`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(OUT, content);
  process.stdout.write(
    `wrote ${OUT} (${content.split("\n").length} lines, ${sections.length} sections)\n`,
  );
}

if (import.meta.main) main(process.argv.slice(2));
