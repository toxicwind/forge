import { describe, expect, it, mock } from "bun:test";
import { cosine, embedClassify, categorizeRepos } from "./hf.ts";

describe("cosine", () => {
  it("identical vectors → 1", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
  it("orthogonal → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("opposite → -1", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  it("dim mismatch throws", () => {
    expect(() => cosine([1], [1, 2])).toThrow(/dim mismatch/);
  });
});

// Mock the network: deterministic 2-dim vectors per SEMANTIC CONTENT so cosine
// is exact. Sports-content → [1,0], movie-content → [0,1], kids → [0.5,0.5].
const vecOf = (s: string): number[] => {
  const t = s.toLowerCase();
  if (t.includes("sport") || t.includes("footbal") || t.includes("world cup")) return [1, 0];
  if (t.includes("movie") || t.includes("harry") || t.includes("film")) return [0, 1];
  if (t.includes("kid") || t.includes("cartoon") || t.includes("toon")) return [0.5, 0.5];
  return [0.1, 0.1];
};

describe("embedClassify (network mocked)", () => {
  it("argmax labels by proximity, below minScore → fallback", async () => {
    mock.module("bun", () => ({}) as object);
    // Stub global fetch to return per-input vectors.
    const calls: string[][] = [];
    // @ts-expect-error — test-only global override
    globalThis.fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body.input);
      return new Response(
        JSON.stringify({
          data: (body.input as string[]).map((s) => ({ embedding: vecOf(s) })),
        }),
        { status: 200 },
      );
    };

    const labels = [
      { label: "Sports", prompt: "sports channel" },
      { label: "Movies", prompt: "movie channel" },
      { label: "Kids", prompt: "kids channel" },
    ] as const;
    const results = await embedClassify(
      ["live footbal", "old cartoon"],
      labels,
      { minScore: 0.9, fallback: "Other" },
    );
    // sports-ish [1,0] vs sports [1,0] → 1; vs movie [0,1] → 0 → argmax sports
    expect(results[0].label).toBe("Sports");
    // cartoon [0.5,0.5] = the Kids centroid itself → cosine 1.0 → Kids
    expect(results[1].label).toBe("Kids");
    expect(calls.length).toBe(2); // one batch of labels, one batch of inputs
  });

  it("categorizeRepos maps name→category", async () => {
    // @ts-expect-error — test-only global override
    globalThis.fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          data: (body.input as string[]).map((s) => ({ embedding: vecOf(s) })),
        }),
        { status: 200 },
      );
    };
    const out = await categorizeRepos(
      ["world cup", "harry potter"],
      [
        { label: "Sports", prompt: "sports repo" },
        { label: "Movies", prompt: "movie repo" },
      ],
    );
    expect(out[0].category).toBe("Sports");
    expect(out[1].category).toBe("Movies");
  });
});