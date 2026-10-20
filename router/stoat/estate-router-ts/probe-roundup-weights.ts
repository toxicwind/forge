#!/usr/bin/env bun
/**
 * probe-roundup-weights.ts — live receipt that roundup sweep weights
 * steer the estate router's candidate order.
 * Run from the estate-scripts-router-ts dir on yote.
 */
import { getBenchPriors, benchModelBonus, benchProviderElo } from "./bench-priors.ts";

const t0 = Bun.nanoseconds();
const priors = getBenchPriors();
const t1 = Bun.nanoseconds();

console.log(`priors source : ${priors.source}`);
console.log(`priors mtime  : ${new Date(priors.mtime).toISOString()}`);
console.log(`load took    : ${((t1 - t0) / 1e6).toFixed(2)} ms`);
console.log("");

// Bonuses for the 8 roundup-swept models (all quality_mean=2 -> +10)
const swept: Array<[string, string]> = [
  ["llama-swap", "beellama/exaone-4-0-1-2b-iq4xs"],
  ["llama-swap", "beellama/exaone-4-0-1-2b-q4km"],
  ["llama-swap", "beellama/exaone-4-0-1-2b-q5km"],
  ["llama-swap", "beellama/exaone-4-0-1-2b-q6k"],
  ["sov", "beellama/exaone-4-0-1-2b-iq4xs"],
  ["sov", "beellama/exaone-4-0-1-2b-q4km"],
  ["sov", "beellama/exaone-4-0-1-2b-q5km"],
];
for (const [p, m] of swept) {
  console.log(`bonus ${p}/${m} = ${benchModelBonus(p, m)}`);
}
console.log(`bonus openrouter/inclusionai/ling-3.0-flash-fin:free = ${benchModelBonus("openrouter", "inclusionai/ling-3.0-flash-fin:free")} (unswept -> 0)`);
console.log("");
console.log(`providerElo llama-swap = ${benchProviderElo("llama-swap")} (roundup v2: 1080)`);
console.log(`providerElo sov        = ${benchProviderElo("sov")} (roundup v2: 1080)`);
console.log(`providerElo groq       = ${benchProviderElo("groq")} (legacy priors untouched)`);
console.log("");

// Demonstrate the tie-break sort from freeCandidates(): a swept model
// outranks an otherwise-identical unswept one.
const pool: Array<[string, string]> = [
  ["openrouter", "inclusionai/ling-3.0-flash-fin:free"],
  ["llama-swap", "beellama/exaone-4-0-1-2b-iq4xs"],
];
const ranked = [...pool].sort((a, b) => benchModelBonus(b[0], b[1]) - benchModelBonus(a[0], a[1]));
console.log("");
console.log("tie-break sort demo (same comparator as freeCandidates):");
for (const [p, m] of ranked) console.log(`  ${p}/${m}  (bonus ${benchModelBonus(p, m)})`);
