import type { SeedPrompt } from "./corpus-v2.ts";

const NEEDLE = "SECRET_PIN_4920";

function makeHaystack(targetTokens: number): string {
  const filler = "The quick brown fox jumps over the lazy dog. Contextual filler stream verification sentence. ";
  const reps = Math.max(10, Math.floor((targetTokens * 4) / filler.length));
  const before = filler.repeat(Math.floor(reps / 2));
  const after = filler.repeat(Math.floor(reps / 2));
  return `${before}\nThe special pin is ${NEEDLE}.\n${after}\n\nWhat is the special pin mentioned in the text?`;
}

export const LONGCTX_SCENARIOS: SeedPrompt[] = [
  {
    id: "longctx-8k",
    capability: "longctx_8k",
    taskClass: "longctx/8k",
    band: "L",
    text: makeHaystack(8000),
    maxTokens: 32,
    suitableFor: (m) => !/vision|guard|embed|rerank|clip|2b/i.test(m) || /exaone|ling/i.test(m),
    expect: (r) => r.content.includes(NEEDLE),
  },
];
