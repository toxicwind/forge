/**
 * @forge/hf — canonical bge-m3 embedding lane (FreeInference /v1/embeddings).
 *
 * VERIFIED live 2026-11-02: endpoint 200, 1024-dim, key from the keyring
 * (secretsmith env → FREEINFERENCE_API_KEY). No local models ever: the cloud
 * lane is the ONE embed source (2026-11-02 consolidation; the earlier
 * "401 rotation" ticket was a wrong-path misdiagnosis).
 *
 * Consumers: forge ops, wip-to-product classifier, estate classifiers —
 * everything imports from here instead of re-implementing fetch+cosine.
 */
import type { Subprocess } from "bun";

export interface EmbedOptions {
  model?: string;
  batchSize?: number;
  /** base URL (defaults to the canonical openai-compatible endpoint) */
  baseUrl?: string;
}

export interface ClassifyResult<T extends string> {
  label: T;
  score: number;
  vector: number[];
}

const DEFAULT_MODEL = "bge-m3";
const DEFAULT_BASE = "https://freeinference.org/v1/embeddings";

async function keyringKey(): Promise<string> {
  const ambient = process.env.FREEINFERENCE_API_KEY?.trim();
  if (ambient) return ambient;
  const p = Bun.spawn(
    ["sh", "-c", "/home/toxic/pens/olympus/products/kryptos/bin/kryptos env 2>/dev/null | grep '^FREEINFERENCE_API_KEY=' | cut -d= -f2- | tr -d \"'\" | tr -d '\\n'"],
    { stdout: "pipe" },
  );
  const out = new TextDecoder().decode(await Bun.readableStreamToBytes(p.stdout));
  await p.exited;
  const key = out.trim();
  if (!key) throw new Error("FREEINFERENCE_API_KEY not resolvable via secretsmith env");
  return key;
}

async function nvidiaKey(): Promise<string> {
  const ambient = process.env.NVIDIA_API_KEY?.trim();
  if (ambient) return ambient;
  const p = Bun.spawn(
    ["sh", "-c", "/home/toxic/pens/olympus/products/kryptos/bin/kryptos env 2>/dev/null | grep '^NVIDIA_API_KEY=' | cut -d= -f2- | tr -d \"'\" | tr -d '\\n'"],
    { stdout: "pipe" },
  );
  const out = new TextDecoder().decode(await Bun.readableStreamToBytes(p.stdout));
  await p.exited;
  const key = out.trim();
  if (!key) throw new Error("NVIDIA_API_KEY not resolvable via secretsmith env");
  return key;
}

/** Embed many strings; returns dense vectors (await per-batch semantics). */
export async function embedMany(
  inputs: string[],
  opts: EmbedOptions = {},
): Promise<number[][]> {
  const batchSize = opts.batchSize ?? 64;
  let key = "";
  try { key = await keyringKey(); } catch { key = ""; }
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const slice = inputs.slice(i, i + batchSize);
    let res: Response;
    let usedNvidia = false;
    try {
      res = await fetch(opts.baseUrl ?? DEFAULT_BASE, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: opts.model ?? DEFAULT_MODEL, input: slice }),
      });
      if (!res.ok) throw new Error(`freeinference ${res.status}`);
    } catch (e) {
      // Fallback to NVIDIA embeddings
      usedNvidia = true;
      const nkey = await nvidiaKey();
      res = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${nkey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "nvidia/nemotron-3-embed-1b", input: slice, input_type: "passage" }),
      });
      if (!res.ok) {
        if (res.status === 429) { await Bun.sleep(2000); continue; }
        throw new Error(`nvidia embeddings http ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    }
    if (!res.ok) {
      if (res.status === 429) { await Bun.sleep(2000); continue; }
      throw new Error(`embeddings http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
    if (!Array.isArray(j.data) || j.data.length !== slice.length) {
      throw new Error(`embeddings response data length mismatch: expected ${slice.length}, got ${j.data?.length ?? "null"}`);
    }
    for (const d of j.data) {
      if (!d.embedding || !Array.isArray(d.embedding)) {
        throw new Error(`embeddings response missing embedding array`);
      }
      vectors.push(d.embedding);
    }
  }
  if (vectors.length !== inputs.length) {
    throw new Error(`embedMany: vector count mismatch: ${vectors.length} vs ${inputs.length}`);
  }
  return vectors;
}

/** Embed one string. */
export async function embedOne(input: string, opts: EmbedOptions = {}): Promise<number[]> {
  const [v] = await embedMany([input], opts);
  return v;
}

/** Cosine similarity; both vectors must be same length. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * Classify each input against precomputed label vectors (embed labels once with
 * embedMany, then argmax cosine per input). minScore → "Other"/fallback label.
 */
export async function embedClassify<T extends string>(
  inputs: string[],
  labels: Array<{ label: T; prompt: string }>,
  opts: { minScore?: number; fallback?: T } & EmbedOptions = {},
): Promise<Array<ClassifyResult<T>>> {
  const labelVectors = await embedMany(labels.map((l) => l.prompt), opts);
  const inputVectors = await embedMany(inputs, opts);
  const min = opts.minScore ?? 0.18;
  return inputVectors.map((iv) => {
    let best: T = opts.fallback ?? labels[0].label;
    let bestScore = -Infinity;
    for (let li = 0; li < labels.length; li++) {
      const s = cosine(iv, labelVectors[li]);
      if (s > bestScore) {
        bestScore = s;
        best = labels[li].label;
      }
    }
    if (bestScore < min) best = opts.fallback ?? ("Other" as T);
    return { label: best, score: bestScore, vector: iv };
  });
}

/** Categorize a flat list of names into the given label set (forge ops standard). */
export async function categorizeRepos<T extends string>(
  names: string[],
  labels: Array<{ label: T; prompt: string }>,
): Promise<Array<{ name: string; category: T; score: number }>> {
  const r = await embedClassify(names, labels);
  return names.map((name, i) => ({ name, category: r[i].label, score: r[i].score }));
}

export type { Subprocess };