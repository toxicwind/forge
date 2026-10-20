import type { SeedPrompt } from "./corpus-v2.ts";

export const TOOL_SCENARIOS: SeedPrompt[] = [
  {
    id: "tools-weather",
    capability: "tools",
    taskClass: "code/tools",
    band: "S",
    text: "What is the weather in Tokyo right now? Use the get_weather tool.",
    suitableFor: (m) => /mistral|codestral|gpt|claude|qwen|nemotron-3-super/i.test(m),
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
    maxTokens: 128,
    expect: (r) => {
      if (!r.toolCalls || !r.toolCalls.length) return false;
      const tc = r.toolCalls[0] as any;
      if (tc.function?.name !== "get_weather") return false;
      try {
        const args = JSON.parse(tc.function.arguments);
        return /tokyo/i.test(args.city);
      } catch {
        return false;
      }
    },
  },
  {
    id: "tools-no-tool-needed",
    capability: "tools",
    taskClass: "code/tools",
    band: "S",
    text: "What is 2 + 2? Do not use any tools. Just answer with the number.",
    suitableFor: (m) => /mistral|codestral|gpt|claude|qwen|nemotron-3-super|exaone/i.test(m),
    tools: [
      {
        type: "function",
        function: {
          name: "calculator",
          description: "Calculate math expressions",
          parameters: {
            type: "object",
            properties: { expr: { type: "string" } },
            required: ["expr"],
          },
        },
      },
    ],
    maxTokens: 32,
    expect: (r) => (r.toolCalls.length === 0 || !r.toolCalls) && /4/.test(r.content),
  },
];
