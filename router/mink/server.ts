// Bun.serve entry: FIFO-gated /v1/chat/completions + model/health routes
import { race, CODING } from "./race.ts";
import { sessionId } from "./session.ts";

const PORT = Number(Bun.env.AST_ROUTER_PORT ?? 25104);
const HOST = Bun.env.AST_ROUTER_HOST ?? "0.0.0.0";
const FIFO_MAX = 64;
const fifo: number[] = [];

async function handleChatCompletions(
  req: Request,
  sid: string,
): Promise<Response> {
  if (fifo.length >= FIFO_MAX) {
    return new Response(JSON.stringify({ error: "fifo full" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  fifo.push(1);
  try {
    const body = await req.json();
    const r = await race(body, sid);
    if (r?.ok) {
      return new Response(r.data, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Routed-Via": `${r.provider}/${r.model}`,
          "X-Latency": String(r.lat ?? 0),
        },
      });
    }
    return new Response(
      JSON.stringify({ error: r?.err ?? "exhausted", status: r?.status }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  } finally {
    fifo.pop();
  }
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req: Request) {
    const path = new URL(req.url).pathname;
    const sid = req.headers.get("X-Session-Id") ?? (await sessionId(req));
    if (req.method === "GET") {
      if (path === "/v1/models" || path === "/models") {
        const ms = [...Object.keys(CODING), "auto", "fcm"].map((k) => ({
          id: k,
          object: "model",
        }));
        return Response.json({ object: "list", data: ms });
      }
      if (path === "/health") {
        return new Response(
          '{"status":"ok","router":"estate-ast","parallel":4}',
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    }
    if (req.method === "POST" && path.includes("/chat/completions")) {
      return handleChatCompletions(req, sid);
    }
    return new Response(null, { status: 404 });
  },
});
