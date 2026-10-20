# estate-mcp-gateway

*The trust boundary in front of upstream MCP servers: per-upstream circuit breakers quarantine poisoned servers while agents see one provenance-namespaced tool union.*

![ranch](https://img.shields.io/badge/toxicwind-ranch-blue?style=for-the-badge) ![mesh](https://img.shields.io/badge/mesh-mcp--gateway-purple?style=for-the-badge) ![bun](https://img.shields.io/badge/bun-black?style=for-the-badge)

## Why this exists

Agents call tools; tools come from upstream MCP servers; upstream servers can be poisoned. This gateway sits between: it quarantines misbehaving upstreams, pins sticky sessions on `notifications/initialized`, and serves `tools/list` as a provenance-namespaced union (`<upstream>__<tool>`) with 502 failover. The routing theory (ReAct 2210.03629 / Reflexion 2303.11366) is documented in `gateway-core.ts`.

## Status

**Not live.** The code defaults to `:25120`, but that port is canonically estate-chat's per `estate/pitchfork.toml` — do not start the gateway on `:25120` without resolving the collision. No pitchfork stanza, nothing listening. Preserved for reference; MCP federation on the estate is gatehouse's domain (`barn/gatehouse`, `:25127`).

## Layout

```text
gateway.ts          HTTP entry — thin Bun.serve wrapper (MCP_GATEWAY_PORT, default 25120)
gateway-core.ts     the testable core: circuits, sticky sessions, upstream selection,
                    provenance-namespaced tools/list union, health snapshots
gateway-core.test.ts  bun test suite
```

## Dev / contributing

Changes land as commits in the [toxicwind/ranch](https://github.com/toxicwind/ranch) repo (`mesh/router/estate-mcp-gateway/`). `bun test` before pushing.