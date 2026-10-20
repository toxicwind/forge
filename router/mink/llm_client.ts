// llm_client.ts — Bun port of llm_client/llm_client.py
export class C {
  base: string;
  key: string;
  constructor(base = "https://openrouter.ai/api/v1", key = Bun.env.OPENROUTER_API_KEY ?? "") {
    this.base = base;
    this.key = key;
  }
  q(messages: any[], model = "hy3"): Promise<Response> {
    return fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ messages, model }),
    });
  }
  async complete(messages: any[], model = "hy3"): Promise<string> {
    const r = await this.q(messages, model);
    const j = await r.json();
    return j?.choices?.[0]?.message?.content ?? "";
  }
}
export const c = new C();
