/**
 * Estate MCP Gateway — testable core logic.
 *
 * Extracted from gateway.ts so the routing/circuit/sticky/discover logic can be
 * unit-tested without binding a socket. gateway.ts is a thin Bun.serve entry
 * point that imports this module and wires it to HTTP.
 *
 * Theory (see AGENTS.md §Agentic Loop): the gateway is the agent's *verification
 * boundary* over untrusted downstream tools. Circuit-breaking + sticky affinity
 * are the "act → observe → reflect" control loop (ReAct 2210.03629 / Reflexion
 * 2303.11366) applied to tool routing.
 */

export type BreakerState = "closed" | "half" | "open";

export interface Breaker {
  state: BreakerState;
  until: number; // when open/half expires (ms epoch)
  fails: number;
}

export interface Upstream {
  name: string;
  base: string;
}

export interface UpstreamInfo {
  serverInfo: unknown;
  capabilities: unknown;
  tools: { name: string; upstream: string; description?: string }[];
  cachedAt: number;
}

export interface GatewayState {
  breakers: Map<string, Breaker>;
  sticky: Map<string, { upstream: string; until: number }>;
  upstreamInfo: Map<string, UpstreamInfo>;
  circuitOpenMs: number;
  halfProbeMs: number;
  stickyTtlMs: number;
  upstreamPath: string;
}

export function createState(opts?: {
  circuitOpenMs?: number;
  halfProbeMs?: number;
  stickyTtlMs?: number;
  upstreamPath?: string;
}): GatewayState {
  return {
    breakers: new Map(),
    sticky: new Map(),
    upstreamInfo: new Map(),
    circuitOpenMs: opts?.circuitOpenMs ?? 30_000,
    halfProbeMs: opts?.halfProbeMs ?? 5_000,
    stickyTtlMs: opts?.stickyTtlMs ?? 30 * 60_000,
    upstreamPath: opts?.upstreamPath ?? "/mcp-completion",
  };
}

// ── Circuit breaker ───────────────────────────────────────────────────────────
export function getBreaker(s: GatewayState, name: string): Breaker {
  let b = s.breakers.get(name);
  if (!b) {
    b = { state: "closed", until: 0, fails: 0 };
    s.breakers.set(name, b);
  }
  return b;
}

export function circuitOk(
  s: GatewayState,
  name: string,
  now = Date.now(),
): boolean {
  const b = getBreaker(s, name);
  if (b.state === "open" && now >= b.until) {
    b.state = "half";
    b.until = now + s.halfProbeMs;
  }
  return b.state !== "open";
}

export function circuitMarkFail(
  s: GatewayState,
  name: string,
  now = Date.now(),
) {
  const b = getBreaker(s, name);
  b.fails++;
  if (b.state === "half") {
    b.state = "open";
    b.until = now + s.circuitOpenMs;
  } else if (b.fails >= 3) {
    b.state = "open";
    b.until = now + s.circuitOpenMs;
  }
}

export function circuitMarkOk(s: GatewayState, name: string) {
  const b = getBreaker(s, name);
  b.state = "closed";
  b.fails = 0;
  b.until = 0;
}

// ── Sticky session affinity ───────────────────────────────────────────────────
export function stickyGet(
  s: GatewayState,
  sid: string,
  now = Date.now(),
): string | null {
  const v = s.sticky.get(sid);
  if (!v) return null;
  if (now >= v.until) {
    s.sticky.delete(sid);
    return null;
  }
  return v.upstream;
}

export function stickySet(
  s: GatewayState,
  sid: string,
  upstream: string,
  now = Date.now(),
) {
  s.sticky.set(sid, { upstream, until: now + s.stickyTtlMs });
}

// ── Session identity ──────────────────────────────────────────────────────────
export function sessionId(req: Request, body: any): string {
  const h =
    req.headers.get("x-session-id") || req.headers.get("mcp-session-id");
  if (h) return h;
  const id =
    (body && body.params && body.params._meta && body.params._meta.sessionId) ||
    (body &&
      body.params &&
      body.params.clientInfo &&
      body.params.clientInfo.name) ||
    "anon";
  return String(id);
}

export function isNotification(method: string | undefined): boolean {
  return !!method && method.startsWith("notifications/");
}

// ── Upstream selection (the routing decision) ─────────────────────────────────
// ReAct-style act step: pick the upstream for this message.
//   1. sticky pin if set & healthy (commitment / affinity)
//   2. else first healthy upstream (failover)
//   3. else null → caller returns 502 "no healthy upstream"
export function selectUpstream(
  s: GatewayState,
  upstreams: Upstream[],
  sid: string,
  now = Date.now(),
): string | null {
  const pinned = stickyGet(s, sid, now);
  if (pinned && circuitOk(s, pinned, now)) return pinned;
  const healthy = upstreams.filter((u) => circuitOk(s, u.name, now));
  if (!healthy.length) return null;
  stickySet(s, sid, healthy[0].name, now);
  return healthy[0].name;
}

// ── Cached upstream info setters ──────────────────────────────────────────────
export function setUpstreamInfo(
  s: GatewayState,
  name: string,
  info: Omit<UpstreamInfo, "cachedAt">,
  now = Date.now(),
) {
  s.upstreamInfo.set(name, { ...info, cachedAt: now });
  circuitMarkOk(s, name);
}

export function markUpstreamFail(
  s: GatewayState,
  name: string,
  now = Date.now(),
) {
  circuitMarkFail(s, name, now);
}

// ── Discover / tools/list synthesis ───────────────────────────────────────────
// Build a synthetic server/discover from cached upstream handshakes. Tools are
// namespaced `<upstream>__<tool>` so the agent can reason about provenance.
export function buildDiscover(s: GatewayState, upstreams: Upstream[]): any {
  const tools: any[] = [];
  const caps: Record<string, unknown> = {};
  for (const u of upstreams) {
    const info = s.upstreamInfo.get(u.name);
    if (!info) continue;
    for (const t of info.tools) {
      tools.push({
        name: `${u.name}__${t.name}`,
        description: `[${u.name}] ${t.description || ""}`,
        inputSchema: { type: "object" },
      });
    }
    Object.assign(caps, info.capabilities as object);
  }
  return {
    jsonrpc: "2.0",
    id: null,
    result: {
      supported_versions: ["2024-11-05"],
      capabilities: caps,
      server_info: { name: "estate-mcp-gateway", version: "v1" },
      instructions:
        "Tools are namespaced as <upstream>__<tool>. The gateway load-balances and circuit-breaks across upstreams.",
      tools,
    },
  };
}

// Build a provenance-tagged tools/list union from cache (no upstream call).
export function buildToolsList(s: GatewayState, upstreams: Upstream[]): any {
  const all = upstreams.flatMap((u) => s.upstreamInfo.get(u.name)?.tools || []);
  return {
    jsonrpc: "2.0",
    id: null,
    result: {
      tools: all.map((t) => ({
        name: `${t.upstream}__${t.name}`,
        description: `[${t.upstream}] ${t.description || ""}`,
        inputSchema: { type: "object" },
      })),
    },
  };
}

// ── Health snapshot (for /health) ─────────────────────────────────────────────
export function healthSnapshot(
  s: GatewayState,
  upstreams: Upstream[],
  now = Date.now(),
) {
  const ups: Record<string, unknown> = {};
  for (const u of upstreams) {
    ups[u.name] = {
      circuit: getBreaker(s, u.name).state,
      tools: s.upstreamInfo.get(u.name)?.tools.length || 0,
      healthy: circuitOk(s, u.name, now),
    };
  }
  return { upstreams: ups, sticky_sessions: s.sticky.size };
}
