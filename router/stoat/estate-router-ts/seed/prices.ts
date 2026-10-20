export const PRICES: Record<string, { in: number; out: number }> = {
  "groq/allam-2-7b": { in: 0.15 / 1e6, out: 0.20 / 1e6 },
  "mistral/codestral-2508": { in: 0.30 / 1e6, out: 0.90 / 1e6 },
  "herd/beellama/exaone-4-0-1-2b-iq4xs": { in: 0, out: 0 },
  "zen/ling-3.1-flash-free": { in: 0, out: 0 },
  "nim-local/meta/llama-3.2-11b-vision-instruct": { in: 0, out: 0 },
  "nim-local/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": { in: 0, out: 0 },
  "openrouter/inclusionai/ling-3.1-flash": { in: 0.10 / 1e6, out: 0.20 / 1e6 },
};
