import { PROBES } from "./corpus.ts";

const ROUTER = "http://127.0.0.1:25104";

async function listModels(): Promise<string[]> {
  const r = await fetch(`${ROUTER}/v1/models`);
  const d = await r.json();
  return (d.data ?? []).map((m: any) => m.id);
}

async function probe(model: string, p: typeof PROBES[0]): Promise<{ score: number; ok: boolean; latency_ms: number }> {
  const t0 = performance.now();
  try {
    const body: any = {
      model,
      messages: [{ role: "user", content: p.text }],
      max_tokens: p.maxTokens,
      stream: false,
    };
    if (p.tools) { body.tools = p.tools; body.tool_choice = "auto"; }
    const r = await fetch(`${ROUTER}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    const content = d.choices?.[0]?.message?.content ?? "";
    const toolCalls = d.choices?.[0]?.message?.tool_calls ?? [];
    const score = p.score(content, toolCalls);
    // The router FAILS OVER on miss: HTTP 200 with a different model is a
    // miss, not a pass. Verify the served model matches the request.
    const served = String(d.model ?? "");
    const modelMatch = served === model || served.endsWith("/" + model);
    return { score, ok: r.ok && modelMatch, latency_ms: performance.now() - t0 };
  } catch {
    return { score: 0, ok: false, latency_ms: performance.now() - t0 };
  }
}

async function main() {
  const models = await listModels();
  console.log(`probing ${models.length} models × ${PROBES.length} probes = ${models.length * PROBES.length} requests`);
  console.log("model\tcapability\tscore\tmax\tok\tlatency_ms");
  for (const m of models) {
    for (const p of PROBES) {
      const r = await probe(m, p);
      const max = p.capability === "tooluse" ? 4 : 2;
      console.log(`${m}\t${p.capability}\t${r.score}\t${max}\t${r.ok}\t${r.latency_ms.toFixed(0)}`);
      await fetch(`${ROUTER}/probe-observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, capability: p.capability, score: r.score, max }),
      }).catch(() => {});
    }
  }
}

main();
