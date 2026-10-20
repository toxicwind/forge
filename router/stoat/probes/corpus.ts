export interface Probe {
  id: string;
  capability: string;   // tooluse | json | math | multilingual | instruction | reasoning
  text: string;
  tools?: unknown[];
  maxTokens: number;
  score: (response: string, toolCalls: unknown[]) => number;
}

export const PROBES: Probe[] = [
  {
    id: "tooluse-book-flight",
    capability: "tooluse",
    text: "Book a flight Tokyo→Seoul on the 15th, window seat, and add a hotel for two nights near Gangnam.",
    tools: [
      { type: "function", function: { name: "search_flights", description: "search flights", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "book_flight", description: "book flight", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "search_hotels", description: "search hotels", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "book_hotel", description: "book hotel", parameters: { type: "object", properties: {} } } }
    ],
    maxTokens: 400,
    score: (r, tc) => {
      const names = (tc || []).map((t: any) => t.function?.name).filter(Boolean);
      let s = 0;
      if (names.includes("search_flights")) s++;
      if (names.includes("book_flight")) s++;
      if (names.includes("search_hotels")) s++;
      if (names.includes("book_hotel")) s++;
      return s;
    },
  },
  {
    id: "json-extract",
    capability: "json",
    text: 'Return JSON {people:[],orgs:[],dates:[]}: Dr. Kim of SNU published in Nature on 2026-03-15.',
    maxTokens: 300,
    score: (r) => {
      try { 
        const j = JSON.parse(r); 
        return (j.people?.length && j.orgs?.length && j.dates?.length) ? 2 : 1; 
      } catch { 
        return 0; 
      }
    },
  },
  {
    id: "math-bat-ball",
    capability: "math",
    text: "A bat and ball cost ₩1,100 together. The bat costs ₩1,000 more than the ball. How much does the ball cost? Show your work.",
    maxTokens: 400,
    score: (r) => {
      const correct = /\b(50|₩50|0\.?05|5\s*cents?)\b/.test(r);
      const wrong = /₩?100\b/.test(r);
      return correct && !wrong ? 2 : 0;
    },
  },
  {
    id: "multilingual-roundtrip",
    capability: "multilingual",
    text: "Translate to Korean, then back to English: 'The committee postponed the launch pending regulatory review.'",
    maxTokens: 500,
    score: (r) => {
      const preserves = /postpon|delay/i.test(r) && /launch/i.test(r) && /review|regulat/i.test(r);
      return preserves ? 2 : 0;
    },
  },
  {
    id: "instruction-multi",
    capability: "instruction",
    text: "Summarize this in one sentence. Capitalize every noun. End with DONE. Do not use the word 'the'.",
    maxTokens: 300,
    score: (r) => {
      let s = 0;
      if (/DONE\s*$/.test(r.trim())) s++;
      if (!/\bthe\b/i.test(r)) s++;
      if (/[A-Z][a-z]+/.test(r)) s++;
      return s;
    },
  },
  {
    id: "reasoning-budget",
    capability: "reasoning",
    text: "HMMT: find the smallest positive integer n such that n³ + 2n² + n divides 2026!.",
    maxTokens: 8192,
    score: (r) => /[0-9]+/.test(r) ? 2 : 0,
  },
];
