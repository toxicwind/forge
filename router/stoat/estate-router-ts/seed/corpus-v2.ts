export interface SeedPrompt {
  id: string;
  capability: string;
  taskClass: string;
  band: "S" | "M" | "L";
  text: string;
  tools?: unknown[];
  maxTokens: number;
  suitableFor?: (model: string) => boolean;
  expect: (r: {
    status: number;
    content: string;
    reasoning: string;
    toolCalls: unknown[];
    finishReason: string;
    tokens: number;
    latencyMs: number;
  }) => boolean;
}

export const CORPUS_V2: SeedPrompt[] = [
  {
    id: "general-qa",
    capability: "general",
    taskClass: "chat/general",
    band: "S",
    text: "What is the capital of France? Answer in one word.",
    maxTokens: 16,
    suitableFor: (m) => !/guard|embed|rerank|clip|tts|asr/i.test(m),
    expect: (r) => /paris/i.test(r.content),
  },
  {
    id: "code-palindrome",
    capability: "code",
    taskClass: "code/general",
    band: "S",
    text: "Write a short Python function `is_pal(s)` returning a boolean for palindrome check.",
    maxTokens: 64,
    suitableFor: (m) => !/vision|guard|embed|rerank|clip/i.test(m),
    expect: (r) => /def is_pal/i.test(r.content) && /==/i.test(r.content),
  },
  {
    id: "json-structured",
    capability: "json_schema",
    taskClass: "code/json",
    band: "S",
    text: "Output a JSON object with keys 'status' (string 'ok') and 'count' (number 42). Do not include any other text.",
    maxTokens: 48,
    suitableFor: (m) => !/vision|guard|embed|rerank|clip/i.test(m),
    expect: (r) => {
      try {
        const j = JSON.parse(r.content.replace(/```json|```/g, "").trim());
        return j.status === "ok" && j.count === 42;
      } catch {
        return false;
      }
    },
  },
  {
    id: "reasoning-puzzle",
    capability: "reasoning_depth",
    taskClass: "reasoning/general",
    band: "M",
    text: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost in cents?",
    maxTokens: 128,
    suitableFor: (m) => !/vision|guard|embed|rerank|clip|mini|tiny/i.test(m),
    expect: (r) => /5\s*(cents?|¢)/i.test(r.content) || /0\.05/i.test(r.content) || /0\.05/i.test(r.reasoning),
  },
  {
    id: "security-code-audit",
    capability: "vulnerability_analysis",
    taskClass: "code/security",
    band: "M",
    text: "Review this C snippet: `void alloc(unsigned int n) { char *buf = malloc(n + 1); }`. Identify the flaw and provide the remediated code using safe arithmetic.",
    maxTokens: 256,
    suitableFor: (m) => !/vision|guard|embed|rerank|clip/i.test(m),
    expect: (r) =>
      /integer\s+overflow|wraparound/i.test(r.content) &&
      /remediation|fix|check/i.test(r.content),
  },
  {
    id: "multilingual-roundtrip",
    capability: "multilingual",
    taskClass: "chat/i18n",
    band: "S",
    text: "Translate 'Good morning, friend' into Spanish.",
    maxTokens: 32,
    suitableFor: (m) => !/guard|embed|rerank|clip/i.test(m),
    expect: (r) => /buenos\s*d[ií]as/i.test(r.content),
  },
];
