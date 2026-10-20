#!/usr/bin/env bun
/**
 * fold-roundup-weights.ts — fold a roundup sweep's router-weights output
 * (schema_version 2) into bench-priors.json, the file the estate router
 * actually loads via bench-priors.ts.
 *
 * Background: the roundup lane's emit-router-weights.ts produces a schema-v2
 * side file, but the router's loader only reads bench-priors.json. Without
 * this fold step the sweep data never steers routing — that was the
 * roundup-integration gap (2026-10-03). Run this after every sweep.
 *
 * The loader (bench-priors.ts) is version-tolerant: legacy `priors` stays
 * untouched, v2 `provider_priors`/`model_priors` are added alongside it.
 * merge-provider-priors.ts rewrites the whole doc but preserves unknown
 * keys, so this fold survives provider-bench merges.
 *
 * Hot-reload: the router re-reads bench-priors.json on mtime change —
 * no restart needed.
 *
 * Usage: bun fold-roundup-weights.ts [--weights roundup-weights.json]
 *                                     [--priors bench-priors.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

function opt(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const weightsPath = opt("weights", "roundup-weights.json");
const priorsPath = opt("priors", "bench-priors.json");

const rw = JSON.parse(readFileSync(weightsPath, "utf8")) as Record<string, unknown>;
if (rw.schema_version !== 2) {
  console.error(`refusing: ${weightsPath} schema_version=${rw.schema_version}, expected 2`);
  process.exit(1);
}
const providerPriors = rw.provider_priors as Record<string, unknown>;
const modelPriors = rw.model_priors as unknown[];
if (!providerPriors || !Array.isArray(modelPriors)) {
  console.error(`refusing: ${weightsPath} missing provider_priors/model_priors`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(priorsPath, "utf8")) as Record<string, unknown>;
const legacyCount = Object.keys((doc.priors as Record<string, unknown>) || {}).length;

doc.provider_priors = providerPriors;
doc.model_priors = modelPriors;
const sources = (doc.sources as Record<string, unknown>) || {};
sources["roundup"] = {
  path: weightsPath,
  run_id: rw.run_id,
  generated_ts: rw.generated_ts,
  n_providers: Object.keys(providerPriors).length,
  n_models: modelPriors.length,
  instrument:
    "roundup estate sweep: deterministic instruction-following exact=2/contains=1/empty=0, latency p50, liveness-aware; provider elo 1000+(q-1)*80",
  folded_ts: new Date().toISOString(),
};
doc.sources = sources;
doc.generated_ts = new Date().toISOString();

writeFileSync(priorsPath, JSON.stringify(doc, null, 2) + "\n");
console.log(
  `folded ${weightsPath} -> ${priorsPath}: ` +
    `${Object.keys(providerPriors).length} provider priors, ` +
    `${modelPriors.length} model priors (legacy priors kept: ${legacyCount} providers)`,
);
