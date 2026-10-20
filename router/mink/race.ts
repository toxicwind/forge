// 4-way parallel race: first AST/code response wins (port of router.py race)
import { PROVIDERS, keyOk } from "./env.ts";
import { isAstCode } from "./session.ts";

export const CODING: Record<string, string> = {
  hy3: "https://openrouter.ai/api/v1",
  "laguna-m1": "https://openrouter.ai/api/v1",
  "qwen3-coder": "https://openrouter.ai/api/v1",
  "gemma4-31b": "https://openrouter.ai/api/v1",
  "nemotron-super": "https://openrouter.ai/api/v1",
};

export function stickyGet(sid: string): string | undefined {
  try { return Bun.env[`STICKY_${sid}`]; } catch { return undefined; }
}

function scoreProvider(p: string, body: any): number {
  let s = 1;
  if (keyOk(p)) s += 2;
  if (isAstCode(JSON.stringify(body?.messages ?? ""))) s += 3;
  return s;
}

async function callOne(p: string, model: string, body: any, sid: string): Promise<any> {
  const base = CODING[model] ?? "https://openrouter.ai/api/v1";
  const key =
    p === "openrouter" ? Bun.env.OPENROUTER_API_KEY :
    p === "groq" ? Bun.env.GROQ_API_KEY :
    p === "google" ? Bun.env.GOOGLE_API_KEY :
    p === "mistral" ? Bun.env.MISTRAL_API_KEY : "";
  if (!key) return { ok: false, err: "no_key", provider: p };
  const t = Date.now();
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Session-Id": sid },
    body: JSON.stringify({ ...body, model }),
  });
  const data = await r.arrayBuffer();
  return { ok: r.ok, provider: p, model, data, lat: (Date.now() - t) / 1000, status: r.status };
}

export async function race(body: any, sid: string): Promise<any> {
  const candidates = PROVIDERS.filter(keyOk);
  if (candidates.length === 0) return { ok: false, err: "no providers configured" };
  const scored = candidates.map((p) => ({ p, s: scoreProvider(p, body) }))
    .sort((a, b) => b.s - a.s).slice(0, 4);
  const results = await Promise.all(scored.map((c) => callOne(c.p, c.p === "groq" ? "groq/gemma-4-27b" : "hy3", body, sid)));
  const winner = results.find((r) => r.ok && isAstCode(new TextDecoder().decode(r.data)));
  return winner ?? results[0];
}
