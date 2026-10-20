# flock TS router — port contract

Single authoritative interface for the merged router. Every module ported from
`proxy/src/*.rs` MUST conform to this file. Agents work in parallel; this file
is the only thing they all read. If your module needs a symbol that is not
declared here, declare it inside your own module and note it — do not edit
another module.

Runtime: **Bun 1.4.3+**. TypeScript, ESM, no build step. `bun run` directly.

## Layout

```
ts/src/
  http/         server.ts  routes.ts  sse.ts        <- from api.rs routes.rs proxy.rs
  router/       strategy.ts  decision.ts  governor.ts  <- from router.rs decision.rs governor.rs
  history/      store.ts  codec.ts  query.ts          <- from history.rs history/*.rs
  config/       schema.ts  load.ts  settings.ts       <- from config.rs settings.rs
  telemetry/    observe.ts  health.ts                 <- from observation.rs health.rs
  providers/    catalog.ts  pool.ts  circuit.ts  ratelimit.ts  roost.ts
                                                     <- from providers.rs pool.rs circuit.rs
                                                        ratelimit.rs roost_providers.rs
  auth/         tokens.ts  users.ts                   <- from auth.rs
  strategy/     (already present: estate-scripts-router's TS strategy layer, vendored)
  roost/        (already present: provider catalog SSOT)
  astmatrix/    (already present: Elo matrix)
```

## Shared primitives — import from `../shared.ts`

```ts
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Never throws. Ports Rust's Result<T, E> honestly instead of faking it. */
export function attempt<T>(label: string, fn: () => T | Promise<T>): Promise<Result<T>>;

/** Circuit breaker states. Do not invent new ones; the metrics name them. */
export type CircuitState = "closed" | "open" | "half";

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  latencyMs: number;
  provider: string;
  model: string;
}

/** Every provider call goes through here. Never call fetch() directly. */
export function callUpstream(req: UpstreamRequest, signal: AbortSignal): Promise<UpstreamResponse>;
```

## Module contracts

### `http/server.ts`
```ts
export const ROUTES: RouteTable;      // method -> path pattern -> handler
export function startServer(opts: ServerOptions): { port: number; stop(): Promise<void> };
```
`ServerOptions = { port: number; routes: RouteTable; onRequest?: (req: Request) => void }`.
Uses `Bun.serve`. `ROUTES` must cover every path the Rust `api.rs` exposes —
the parity test asserts the route sets are identical.

### `router/strategy.ts`
```ts
export function pickStrategy(body: ChatBody, ctx: StrategyContext): StrategyName;
export function raceCandidates(c: readonly Candidate[], opts: RaceOptions): Promise<RaceResult>;
```
`raceCandidates` is first-valid-wins with hedging. A candidate is **valid** when
it exits 0 AND its output is non-empty (`substantive()`). This is the
substance guard the NIM audit identified as a router defect — do not regress it.

### `history/store.ts`
Append-only, crash-safe, and readable while being written. The Rust version is
3,749 lines because it hand-rolls the index format; port the format, not the
line count. Compatibility is mandatory: existing on-disk history must still load.

### `providers/circuit.ts`
```ts
export function recordSuccess(name: string): void;
export function recordFailure(name: string, status: number, retryAfterMs: number | null): void;
export function circuitOf(name: string): CircuitSnapshot;
```
Honors `Retry-After`. Metric names are load-bearing: `flock_model_empty_strikes`
mirrors `estate_router_model_empty_strikes` for cross-stack correlation.

### `providers/roost.ts`
Wraps the existing `roost/` package. Auto-quarantine is the fix for serve-time
404s on stale model ids — a model that 404s or vanishes from the live listing
across 2 consecutive successful refreshes is quarantined and never served.

## Rules

1. **No `any`.** Use `unknown` + narrowing guards. The estate lints for it.
2. **No bare `fetch()` outside `shared.ts`.** Everything goes through
   `callUpstream` so circuit, ratelimit, and telemetry cannot be bypassed.
3. **Never lose an existing behavior.** The Rust is the spec. If you believe a
   behavior is wrong, port it anyway and note it in your report — do not
   silently "improve" it during the port.
4. **Port `Result`/`Option`/`match` as explicit branches**, not exceptions.
5. **Every module gets a `.test.ts` sibling** run with `bun test`.

## Definition of done for the whole port

- `bun test` green in `ts/`
- parity test proves the Rust route table and the TS route table are identical
- 25193 answers `/health`, `/v1/models`, and `/v1/chat/completions` from the TS
  server with the same response shape as the Rust one
- only then does `proxy/` get retired