import { sampleBeta } from "../model_disabler.ts";

export interface VariantConfig {
  name: string;
  hedgeK: number;
  loserObsWeight: number;
  decayRate: number;
  alwaysBestArm: boolean;
  randomScores: boolean;
  strictContract: boolean;
  chaosRate: number;
}

export const VARIANTS: Record<string, VariantConfig> = {
  champion_k3: { name: "champion_k3", hedgeK: 3, loserObsWeight: 0.6, decayRate: 0.995, alwaysBestArm: false, randomScores: false, strictContract: false, chaosRate: 0.0 },
  monk:        { name: "monk",        hedgeK: 1, loserObsWeight: 0.0, decayRate: 1.0,   alwaysBestArm: true,  randomScores: false, strictContract: false, chaosRate: 0.0 },
  gaslight:    { name: "gaslight",    hedgeK: 3, loserObsWeight: 0.0, decayRate: 1.0,   alwaysBestArm: false, randomScores: true,  strictContract: false, chaosRate: 0.0 },
  paranoid:    { name: "paranoid",    hedgeK: 3, loserObsWeight: 0.6, decayRate: 0.995, alwaysBestArm: false, randomScores: false, strictContract: true,  chaosRate: 0.0 },
  chaos:       { name: "chaos",       hedgeK: 3, loserObsWeight: 0.6, decayRate: 0.995, alwaysBestArm: false, randomScores: false, strictContract: false, chaosRate: 0.2 },
  oracle:      { name: "oracle",      hedgeK: 1, loserObsWeight: 0.0, decayRate: 1.0,   alwaysBestArm: false, randomScores: false, strictContract: false, chaosRate: 0.0 },
  allin:       { name: "allin",       hedgeK: 12, loserObsWeight: 0.6, decayRate: 0.995, alwaysBestArm: false, randomScores: false, strictContract: false, chaosRate: 0.0 },
  luddite:     { name: "luddite",     hedgeK: 1, loserObsWeight: 0.0, decayRate: 1.0,   alwaysBestArm: false, randomScores: false, strictContract: false, chaosRate: 0.0 },
};

interface ProviderArm {
  id: string;
  baseLat: number;
  jitter: number;
  failProb: number;
}

const BENCHMARK_ARMS: ProviderArm[] = [
  { id: "herd/exaone", baseLat: 45, jitter: 15, failProb: 0.05 },
  { id: "groq/allam", baseLat: 35, jitter: 10, failProb: 0.02 },
  { id: "zen/ling", baseLat: 110, jitter: 30, failProb: 0.08 },
  { id: "nvidia/nemotron", baseLat: 85, jitter: 20, failProb: 0.04 },
  { id: "cerebras/qwen", baseLat: 60, jitter: 25, failProb: 0.15 },
];

function simulateArm(arm: ProviderArm): { ok: boolean; lat: number } {
  const ok = Math.random() >= arm.failProb;
  const lat = Math.max(1, arm.baseLat + (Math.random() - 0.5) * arm.jitter * 2);
  return { ok, lat };
}

export function evaluateVariant(v: VariantConfig, rounds = 100) {
  const latencies: number[] = [];
  const armState = BENCHMARK_ARMS.map((a) => ({ arm: a, s: 1, f: 1, eLat: a.baseLat }));
  let qualityPasses = 0;
  let rrIndex = 0;

  for (let r = 0; r < rounds; r++) {
    let chosenArms = [...armState];

    if (v.name === "oracle") {
      // Cheats: routes to fastest arm
      const fastest = [...BENCHMARK_ARMS].sort((a, b) => a.baseLat - b.baseLat)[0];
      chosenArms = [armState.find((x) => x.arm.id === fastest.id)!];
    } else if (v.name === "monk") {
      chosenArms = [armState[1]]; // Fixed best
    } else if (v.name === "luddite") {
      chosenArms = [armState[rrIndex % armState.length]];
      rrIndex++;
    } else if (v.randomScores) {
      chosenArms = [...armState].sort(() => 0.5 - Math.random()).slice(0, v.hedgeK);
    } else {
      // Thompson sampling
      const scored = armState.map((a) => {
        const p = sampleBeta(a.s, a.f);
        return { a, score: p / Math.max(1, a.eLat) };
      });
      scored.sort((x, y) => y.score - x.score);
      chosenArms = scored.slice(0, v.hedgeK).map((x) => x.a);
      if (v.chaosRate > 0 && Math.random() < v.chaosRate) {
        chosenArms = [scored[scored.length - 1].a];
      }
    }

    const trials = chosenArms.map((a) => ({ a, res: simulateArm(a.arm) }));
    const successes = trials.filter((t) => t.res.ok);
    const winner = successes.length
      ? successes.sort((x, y) => x.res.lat - y.res.lat)[0]
      : trials[0];

    latencies.push(winner.res.lat);
    if (winner.res.ok) qualityPasses++;

    // Posterior update
    if (v.loserObsWeight > 0 || !v.alwaysBestArm) {
      if (winner.res.ok) {
        winner.a.s += 1;
        winner.a.eLat = 0.3 * winner.res.lat + 0.7 * winner.a.eLat;
      } else {
        winner.a.f += 1;
      }

      if (v.loserObsWeight > 0) {
        for (const t of trials) {
          if (t.a === winner.a) continue;
          if (t.res.ok) {
            t.a.s += v.loserObsWeight;
            t.a.eLat = 0.15 * t.res.lat + 0.85 * t.a.eLat;
          } else {
            t.a.f += v.loserObsWeight;
          }
        }
      }
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(0.5 * sorted.length)];
  const p99 = sorted[Math.floor(0.99 * sorted.length)];
  const min = sorted[0];

  return {
    variant: v.name,
    min: +min.toFixed(1),
    p50: +p50.toFixed(1),
    p99: +p99.toFixed(1),
    quality: +(qualityPasses / rounds).toFixed(3),
    convergenceRound: latencies.findIndex((_, i) => latencies.slice(i, i + 5).every((x) => x < 50)),
  };
}
