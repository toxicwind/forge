/**
 * tool-retrieve.ts — bge-m3 pre-tool-call tool-retrieval hook.
 *
 * Directive (2026-11-04): before EVERY tool call, embed the incoming message
 * with bge-m3 and retrieve the likely-relevant tools from the tool corpus by
 * cosine similarity. This is a semantic tool-selection hook for BOTH tau and
 * kappa — the gateway's BM25 retrieve is the lexical fallback; this is the
 * embedding lane.
 *
 * Usage:
 *   const retriever = new ToolRetriever(tools)   // tools: {name, description}[]
 *   await retriever.warm()                        // embed all tool descriptions once
 *   const hits = await retriever.retrieve(message, 5)  // top-5 likely tools
 */
import { embedMany, cosine } from "./hf.ts";

export interface ToolSpec {
  name: string;
  description: string;
}

export interface ToolHit {
  name: string;
  score: number;
}

const MIN_SCORE = 0.18; // below this, treat as "no strong match" (bge-m3 default threshold)

/**
 * Semantic tool retriever. Embeds the tool corpus once (warm), then embeds
 * each incoming message and cosine-ranks against the corpus.
 */
export class ToolRetriever {
  private corpus: Array<{ name: string; vec: number[] }> = [];
  private warmed = false;
  private readonly tools: ToolSpec[];

  constructor(tools: ToolSpec[]) {
    this.tools = tools;
  }

  /** Embed every tool description once. Call before retrieve(). */
  async warm(): Promise<void> {
    if (this.warmed) return;
    const vecs = await embedMany(this.tools.map((t) => `${t.name}: ${t.description}`));
    this.corpus = this.tools.map((t, i) => ({ name: t.name, vec: vecs[i] }));
    this.warmed = true;
  }

  /**
   * Embed the message and return the top-N likely-relevant tools by cosine.
   * Below MIN_SCORE the hit is dropped (no strong semantic match).
   */
  async retrieve(message: string, topN = 5): Promise<ToolHit[]> {
    await this.warm();
    const [msgVec] = await embedMany([message]);
    const scored = this.corpus
      .map((t) => ({ name: t.name, score: cosine(msgVec, t.vec) }))
      .filter((h) => h.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    return scored;
  }

  /** Pre-tool-call hook: given the incoming message, return the tools most likely to be needed. */
  async preToolCall(message: string, topN = 5): Promise<ToolHit[]> {
    return this.retrieve(message, topN);
  }
}

/**
 * Convenience: build a retriever from a tool list and run the pre-tool-call
 * hook in one call (warms on first use).
 */
export async function retrieveRelevantTools(
  tools: ToolSpec[],
  message: string,
  topN = 5,
): Promise<ToolHit[]> {
  const r = new ToolRetriever(tools);
  return r.preToolCall(message, topN);
}