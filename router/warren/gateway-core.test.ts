import { describe, it, expect, beforeEach } from "bun:test";
import {
  createState,
  getBreaker,
  circuitOk,
  circuitMarkFail,
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

const UP: Upstream[] = [
  { name: "byte-vision", base: "http://127.0.0.1:25121" },
  { name: "other", base: "http://127.0.0.1:25122" },
];

function fresh(): GatewayState {
  return createState({ circuitOpenMs: 1000, halfProbeMs: 500, stickyTtlMs: 1000 });
}

describe("circuit breaker", () => {
  let s: GatewayState;
  beforeEach(() => (s = fresh()));

  it("starts closed and healthy", () => {
    expect(circuitOk(s, "byte-vision")).toBe(true);
    expect(getBreaker(s, "byte-vision").state).toBe("closed");
  });

  it("opens after 3 failures", () => {
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    expect(circuitOk(s, "x")).toBe(true);
    circuitMarkFail(s, "x");
    expect(getBreaker(s, "x").state).toBe("open");
    expect(circuitOk(s, "x")).toBe(false);
  });

  it("half-opens after open window elapses", () => {
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    const now = Date.now();
    // simulate window elapsed
    expect(circuitOk(s, "x", now + 2000)).toBe(true);
    expect(getBreaker(s, "x").state).toBe("half");
  });

  it("re-opens immediately from half on failure", () => {
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    circuitOk(s, "x", Date.now() + 2000); // -> half
    expect(getBreaker(s, "x").state).toBe("half");
    circuitMarkFail(s, "x");
    expect(getBreaker(s, "x").state).toBe("open");
  });

  it("resets on success", () => {
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    circuitMarkFail(s, "x");
    circuitMarkOk(s, "x");
    expect(getBreaker(s, "x").state).toBe("closed");
    expect(getBreaker(s, "x").fails).toBe(0);
  });
});

describe("sticky affinity", () => {
  let s: GatewayState;
  beforeEach(() => (s = fresh()));

  it("returns null when unset", () => {
    expect(stickyGet(s, "sid")).toBe(null);
  });

  it("pins and retrieves within TTL", () => {
    const now = 1000;
    stickySet(s, "sid", "byte-vision", now);
    expect(stickyGet(s, "sid", now + 500)).toBe("byte-vision");
  });

  it("expires after TTL", () => {
    stickySet(s, "sid", "byte-vision", 1000);
    expect(stickyGet(s, "sid", 1000 + 2000)).toBe(null);
  });
});

describe("sessionId", () => {
  it("prefers x-session-id header", () => {
    const req = new Request("http://x", { headers: { "x-session-id": "abc" } });
    expect(sessionId(req, {})).toBe("abc");
  });
  it("falls back to mcp-session-id header", () => {
    const req = new Request("http://x", { headers: { "mcp-session-id": "def" } });
    expect(sessionId(req, {})).toBe("def");
  });
  it("uses _meta.sessionId from body", () => {
    const req = new Request("http://x");
    expect(sessionId(req, { params: { _meta: { sessionId: "meta1" } } })).toBe("meta1");
  });
  it("uses clientInfo.name from body", () => {
    const req = new Request("http://x");
    expect(sessionId(req, { params: { clientInfo: { name: "cli" } } })).toBe("cli");
  });
  it("defaults to anon", () => {
    const req = new Request("http://x");
    expect(sessionId(req, {})).toBe("anon");
  });
});

describe("isNotification", () => {
  it("detects notification methods", () => {
    expect(isNotification("notifications/initialized")).toBe(true);
    expect(isNotification("tools/list")).toBe(false);
    expect(isNotification(undefined)).toBe(false);
  });
});

describe("selectUpstream (routing decision)", () => {
  let s: GatewayState;
  beforeEach(() => (s = fresh()));

  it("returns first healthy when nothing pinned", () => {
    expect(selectUpstream(s, UP, "sid")).toBe("byte-vision");
  });

  it("returns pinned healthy upstream", () => {
    stickySet(s, "sid", "other");
    expect(selectUpstream(s, UP, "sid")).toBe("other");
  });

  it("ignores pinned upstream that is open, fails over", () => {
    circuitMarkFail(s, "other");
    circuitMarkFail(s, "other");
    circuitMarkFail(s, "other");
    stickySet(s, "sid", "other");
    expect(selectUpstream(s, UP, "sid")).toBe("byte-vision");
  });

  it("returns null when all upstreams open", () => {
    circuitMarkFail(s, "byte-vision");
    circuitMarkFail(s, "byte-vision");
    circuitMarkFail(s, "byte-vision");
    circuitMarkFail(s, "other");
    circuitMarkFail(s, "other");
    circuitMarkFail(s, "other");
    expect(selectUpstream(s, UP, "sid")).toBe(null);
  });
});

describe("upstream info + discover/tools synthesis", () => {
  let s: GatewayState;
  beforeEach(() => {
    s = fresh();
    setUpstreamInfo(s, "byte-vision", {
      serverInfo: { name: "bv" },
      capabilities: { tools: { listChanged: false } },
      tools: [{ name: "generate_completion", upstream: "byte-vision", description: "gen" }],
    });
  });

  it("buildDiscover namespaces tools and merges caps", () => {
    const d = buildDiscover(s, UP);
    expect(d.result.server_info.name).toBe("estate-mcp-gateway");
    expect(d.result.tools[0].name).toBe("byte-vision__generate_completion");
    expect(d.result.tools[0].description).toBe("[byte-vision] gen");
    expect(d.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it("buildToolsList returns provenance-tagged union", () => {
    const t = buildToolsList(s, UP);
    expect(t.result.tools[0].name).toBe("byte-vision__generate_completion");
  });

  it("discover omits upstreams with no cached info", () => {
    const d = buildDiscover(s, UP);
    // only byte-vision has info; 'other' contributes nothing
    expect(d.result.tools.every((t: any) => t.name.startsWith("byte-vision__"))).toBe(true);
  });

  it("markUpstreamFail opens after 3", () => {
    markUpstreamFail(s, "byte-vision");
    markUpstreamFail(s, "byte-vision");
    markUpstreamFail(s, "byte-vision");
    expect(getBreaker(s, "byte-vision").state).toBe("open");
  });
});

describe("healthSnapshot", () => {
  it("reports circuit state, tool count, health", () => {
    const s = fresh();
    setUpstreamInfo(s, "byte-vision", {
      serverInfo: {},
      capabilities: {},
      tools: [{ name: "a", upstream: "byte-vision" }],
    });
    const h = healthSnapshot(s, UP);
    expect(h.upstreams["byte-vision"].healthy).toBe(true);
    expect(h.upstreams["byte-vision"].tools).toBe(1);
    expect(h.upstreams["byte-vision"].circuit).toBe("closed");
    expect(h.sticky_sessions).toBe(0);
  });
});
