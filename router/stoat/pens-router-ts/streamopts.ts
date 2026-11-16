/**
 * G2 — `stream_options: { include_usage: true }` injection.
 *
 * Port of flock-proxy's usage injection (proxy.rs::handle): streamed
 * responses only report exact token usage when asked via stream_options, so
 * the router asks on the client's behalf for /v1/chat/completions with
 * stream:true when the body carries no stream_options.
 *
 * `fallback` keeps the untouched body for a one-shot retry: if the upstream
 * 400s the injected body, the model id is memoized in NO_INJECT and the
 * request is retried unmodified.
 */
import type { ChatBody } from "./router_types.ts";

/** Model ids that rejected the injection (upstream 400) — never inject again. */
export const NO_INJECT = new Set<string>();

export interface Injection {
  body: ChatBody;
  /** True when stream_options was injected (caller keeps the original for
   *  the unmodified retry). */
  injected: boolean;
  original: ChatBody;
}

/**
 * Inject `stream_options: {include_usage: true}` into a streaming chat
 * body unless the client already set stream_options or the model opted out.
 * Pure w.r.t. the input body (never mutates).
 */
export function injectStreamOptions(body: ChatBody, modelKey: string): Injection {
  const b = body as Record<string, unknown>;
  const injectable =
    b["stream"] === true &&
    typeof b === "object" &&
    b["stream_options"] === undefined &&
    !NO_INJECT.has(modelKey);
  if (!injectable) return { body, injected: false, original: body };
  return {
    body: { ...body, stream_options: { include_usage: true } } as ChatBody,
    injected: true,
    original: body,
  };
}

/** Memoize a model that 400'd the injected body; returns true on first insert. */
export function noteInjectRejected(modelKey: string): boolean {
  if (NO_INJECT.has(modelKey)) return false;
  NO_INJECT.add(modelKey);
  return true;
}
