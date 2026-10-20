import { mkdirSync, writeFileSync } from "node:fs";
import { VARIANTS, evaluateVariant } from "./benchmark.ts";

console.log("=========================================================================");
console.log("           THE OBELISK EVOLUTIONARY RACE - ROUND 1");
console.log("=========================================================================\n");

const results = [];
for (const [name, cfg] of Object.entries(VARIANTS)) {
  const res = evaluateVariant(cfg, 100);
  results.push(res);
}

results.sort((a, b) => a.p50 - b.p50 || b.quality - a.quality);

console.log("| Rank | Variant      | Min Lat | p50 Lat | p99 Lat | Quality | Convergence |");
console.log("|------|--------------|---------|---------|---------|---------|-------------|");
results.forEach((r, idx) => {
  const conv = r.convergenceRound === -1 ? ">100" : `${r.convergenceRound} rds`;
  const rank = String(idx + 1).padEnd(4);
  const v = r.variant.padEnd(12);
  const min = (r.min + "ms").padStart(7);
  const p50 = (r.p50 + "ms").padStart(7);
  const p99 = (r.p99 + "ms").padStart(7);
  const q = String(r.quality).padStart(7);
  const c = conv.padStart(11);
  console.log(`| ${rank} | ${v} | ${min} | ${p50} | ${p99} | ${q} | ${c} |`);
});

mkdirSync("race/round1", { recursive: true });
writeFileSync("race/round1/results.json", JSON.stringify(results, null, 2), "utf8");
console.log("\nResults written to race/round1/results.json");
