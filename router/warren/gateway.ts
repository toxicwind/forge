/**
 * Estate MCP Gateway — HTTP entry point.
 *
 * Thin Bun.serve wrapper around the testable core in ./gateway-core.ts.
 * The gateway is the agent's trust boundary + resource allocator in front of
 * upstream MCP servers (configured via MCP_UPSTREAMS env). See gateway-core.ts
 * for the routing theory (ReAct 2210.03629 / Reflexion 2303.11366).
 */

import {
  createState,
  circuitOk,
  circuitMarkOk,
  stickyGet,
  stickySet,
  sessionId,
  isNotification,
  selectUpstream,
  setUpstreamInfo,
  markUpstreamFail,
  buildDiscover,
  buildToolsList,
  healthSnapshot,
  type GatewayState,
  type Upstream,
} from "./gateway-core.ts";

const PORT = Number(Bun.env.MCP_GATEWAY_PORT || 25120);
const HOST = Bun.env.MCP_GATEWAY_HOST || "0.0.0.0";

// Upstreams: name -> base URL. The gateway load-balances/failovers across these.
// Default: no upstreams — the gateway acts as a standalone MCP proxy.
// Add upstreams via MCP_UPSTREAMS env: "name=http://host:port,name2=http://host:port"
const UPSTREAMS: Upstream[] = (Bun.env.MCP_UPSTREAMS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf("=");
    if (i < 0) return { name: s, base: s };
    return { name: s.slice(0, i), base: s.slice(i + 1) };
  });

const UPSTREAM_PATH = Bun.env.MCP_UPSTREAM_PATH || "/mcp";

const state: GatewayState = createState({
  circuitOpenMs: Number(Bun.env.MCP_CIRCUIT_OPEN_MS || 30_000),
  halfProbeMs: Number(Bun.env.MCP_HALF_PROBE_MS || 5_000),
  stickyTtlMs: Number(Bun.env.MCP_STICKY_TTL_MS || 30 * 60_000),
  upstreamPath: UPSTREAM_PATH,
});

// Forward a JSON-RPC message to one upstream; returns the upstream response.
async function forward(
  upstream: Upstream,
  path: string,
  method: string,
  headers: Headers,
  body: Uint8Array,
): Promise<Response> {
  const url = upstream.base.replace(/\/$/, "") + path;
  const fwd = new Headers();
  headers.forEach((v, k) => {
    if (k.toLowerCase() !== "host") fwd.set(k, v);
  });
  fwd.set("x-session-id", headers.get("x-session-id") || "");
  const resp = await fetch(url, {
    method,
    headers: fwd,
    body: method === "GET" ? undefined : (body as BodyInit),
  });
  if (resp.ok) circuitMarkOk(state, upstream.name);
  else if (resp.status >= 500) markUpstreamFail(state, upstream.name);
  return resp;
}

// Probe an upstream's tools/list (cached) so we can build the union for discover.
async function refreshUpstreamTools(upstream: Upstream) {
  try {
    const init = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "estate-gateway", version: "1" },
      },
    };
    const r1 = await fetch(upstream.base.replace(/\/$/, "") + UPSTREAM_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init),
    });
    const info = (await r1.json().catch(() => null)) as any;
    const toolsResp = await fetch(
      upstream.base.replace(/\/$/, "") + UPSTREAM_PATH,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      },
    );
    const toolsJson = (await toolsResp.json().catch(() => null)) as any;
    const tools = (toolsJson?.result?.tools || []).map((t: any) => ({
      name: t.name,
      upstream: upstream.name,
      description: t.description,
    }));
    setUpstreamInfo(state, upstream.name, {
      serverInfo: info?.result?.serverInfo || { name: upstream.name },
      capabilities: info?.result?.capabilities || {},
      tools,
    });
  } catch {
    markUpstreamFail(state, upstream.name);
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Gateway self-endpoints ────────────────────────────────────────────────
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return Response.json({
        status: "ok",
        router: "estate-mcp-gateway",
        version: "v1",
        ...healthSnapshot(state, UPSTREAMS),
      });
    }

    if (req.method === "GET" && path === "/ui") {
      return new Response(GATEWAY_UI_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ── MCP proxy path ─────────────────────────────────────────────────────────
    if (!path.startsWith(UPSTREAM_PATH)) {
      return new Response("Not Found", { status: 404 });
    }

    const raw = await req.arrayBuffer();
    const bodyBytes = new Uint8Array(raw);
    let msg: any = null;
    try {
      msg = JSON.parse(new TextDecoder().decode(bodyBytes));
    } catch {
      return new Response("invalid json-rpc", { status: 400 });
    }

    const method: string | undefined = msg?.method;
    const sid = sessionId(req, msg);

    // server/discover answered locally from cached upstream handshakes.
    if (method === "server/discover") {
      return Response.json(buildDiscover(state, UPSTREAMS));
    }

    // notifications/initialized: session anchor. Pin to a healthy upstream.
    if (isNotification(method)) {
      const pinned =
        stickyGet(state, sid) ||
        UPSTREAMS.find((u) => circuitOk(state, u.name))?.name;
      if (pinned && circuitOk(state, pinned)) stickySet(state, sid, pinned);
      // Per spec: notifications get NO response. 202 Accepted.
      return new Response(null, { status: 202 });
    }

    // Choose upstream via the routing decision (sticky → healthy → failover).
    const target = selectUpstream(state, UPSTREAMS, sid);
    if (!target) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: msg?.id ?? null,
          error: { code: -32000, message: "no healthy upstream" },
        },
        { status: 502 },
      );
    }
    const upstream = UPSTREAMS.find((u) => u.name === target)!;

    // initialize: proxy upstream, cache capabilities, answer normally.
    if (method === "initialize") {
      const resp = await forward(
        upstream,
        UPSTREAM_PATH,
        req.method,
        req.headers,
        bodyBytes,
      );
      const txt = await resp.text();
      try {
        const j = JSON.parse(txt);
        if (j?.result) {
          setUpstreamInfo(state, upstream.name, {
            serverInfo: j.result.serverInfo || { name: upstream.name },
            capabilities: j.result.capabilities || {},
            tools: state.upstreamInfo.get(upstream.name)?.tools || [],
          });
        }
      } catch {}
      return new Response(txt, {
        status: resp.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // tools/list: answer from cache if we have it (provenance-tagged union).
    if (method === "tools/list") {
      const all = UPSTREAMS.flatMap(
        (u) => state.upstreamInfo.get(u.name)?.tools || [],
      );
      if (all.length) return Response.json(buildToolsList(state, UPSTREAMS));
    }

    // Everything else: proxy to the chosen upstream.
    const resp = await forward(
      upstream,
      UPSTREAM_PATH,
      req.method,
      req.headers,
      bodyBytes,
    );
    const buf = await resp.arrayBuffer();
    return new Response(buf, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "application/json",
      },
    });
  },
});

// Refresh upstream tool caches on boot + periodically.
for (const u of UPSTREAMS) refreshUpstreamTools(u);
setInterval(() => {
  for (const u of UPSTREAMS)
    if (circuitOk(state, u.name)) refreshUpstreamTools(u);
}, 60_000).unref();

console.log(
  `[estate-mcp-gateway] listening on ${HOST}:${PORT} upstreams=${UPSTREAMS.map((u) => u.name).join(",")}`,
);

const GATEWAY_UI_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Estate MCP Gateway</title>
<style>
:root{--bg:#0b0e14;--panel:#121826;--panel2:#0f1420;--ink:#e6edf3;--muted:#8b98a9;--acc:#5ad1c4;--free:#7ee787;--warn:#f0883e;--bad:#ff6b6b;--line:#1f2937}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-monospace,Menlo,monospace;background:var(--bg);color:var(--ink)}
header{padding:18px 22px;border-bottom:1px solid var(--line)}header h1{font-size:18px;margin:0}
.wrap{padding:18px 22px;display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.panel h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--acc)}
.up{display:flex;justify-content:space-between;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:var(--panel2)}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.chip.ok{color:var(--free);border-color:#234d2b}.chip.open{color:var(--bad);border-color:#4d2326}.chip.half{color:var(--warn);border-color:#4d3a23}
.tag{font-size:11px;padding:2px 7px;border-radius:6px;background:#0c111b;border:1px solid var(--line);color:var(--muted)}
.meta{color:var(--muted);font-size:12px}
</style></head>
<body><header><h1>Estate MCP Gateway</h1><span class="meta">trust boundary + circuit breaker + sticky affinity in front of upstream MCP servers</span></header>
<div class="wrap"><div class="panel"><h2>Upstreams</h2><div id="ups"><span class="meta">loading</span></div></div>
<div class="panel"><h2>Topology</h2><div class="meta">agent → gateway (:25120) → circuit/failover → upstreams</div>
<pre>client
  │  JSON-RPC (notifications/initialized = session anchor)
  ▼
estate-mcp-gateway  :25120
  ├─ circuit breaker / sticky affinity
  ├─ tools/list union (provenance-tagged)
  └─ server/discover (synthesized)
  ▼
upstreams: (configured via MCP_UPSTREAMS env)</pre></div></div>
<script>
fetch('/health').then(r=>r.json()).then(h=>{
 const el=document.getElementById('ups');el.innerHTML='';
 for(const [name,u] of Object.entries(h.upstreams||{})){
  const cc=u.circuit==='closed'?'ok':(u.circuit==='open'?'open':'half');
  const d=document.createElement('div');d.className='up';
  d.innerHTML='<div class="name">'+name+'</div><div style="text-align:right"><div class="chip '+cc+'">'+u.circuit+'</div><br><div class="meta">'+u.tools+' tools · '+(u.healthy?'healthy':'down')+'</div></div>';
  el.appendChild(d);
 }
}).catch(e=>document.getElementById('ups').innerHTML='<span class="meta">'+e+'</span>');
</script></body></html>`;
