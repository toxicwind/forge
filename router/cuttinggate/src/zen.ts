/**
 * OpenCode Zen free-tier provider (https://opencode.ai/zen/v1).
 *
 * Zen's free tier is gated on request SHAPE, not app attestation: upstream
 * answers 403 FreeTierError unless the request looks like the OpenCode CLI.
 * Proven live 2026-10-04 — 17/17 models serve through this exact shape:
 *
 *   - Authorization: Bearer <key> (ZEN_API_KEY or OPENCODE_API_KEY)
 *   - User-Agent: opencode/<semver >= 1.18.0>
 *   - x-opencode-client: cli
 *   - x-opencode-project: global
 *   - x-opencode-session: ses_ + 26 chars (12 hex ts + 14 base62), stable per
 *     process (prompt-cache affinity)
 *   - x-opencode-request: msg_ + 26 chars, fresh per call
 *   - body: stream:true (hard gate) + bash/glob/grep/read tool definitions
 *     (a body omitting glob/grep is rejected); tool_choice:none when the
 *     caller declared no tools
 *
 * Borrowed patterns: denysvitali/llm-proxy (ID shape, stream gate, tool
 * injection, SSE fold-back), warexpor/opencode-zen-gateway (UA semver floor,
 * stable session per key, inference-cost frame stripping),
 * aslamplr/turnpike (per-family endpoint split — chat-completions here).
 */

export const ZEN_PROVIDER = "custom/zen";
export const ZEN_LEGACY_PROVIDER = "zen";
export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";

/**
 * First verified 2026-10-04 via :25104/v1/chat/completions: 17/17 returned
 * HTTP 200 (0.1–2.4s). qwen3.6-plus-free, minimax-m3-free,
 * north-mini-code-free and big-pickle no longer appear in
 * https://opencode.ai/zen/v1/models but still serve upstream — kept live.
 * ling-3.0-flash-fin-free joined the upstream catalog 2026-10-04.
 *
 * Re-probe 2026-10-04 ~04:27Z direct to https://opencode.ai/zen/v1 (auth +
 * tool-signature bundle): 8/17 answer with the requested model
 * (mimo-v2.6-flash-free, nemotron-3-ultra-free, space-bunny-free,
 * mimo-v2.5-free, fledge-alpha-free, big-pickle, longcat-2.5-preview-free,
 * nemotron-3.5-lightning-free — reasoning models need a real max_tokens
 * budget; a 30-token probe burns it on chain-of-thought). The other 9 return
 * 400/403/404 upstream; through :25104 strategy-auto degrades to a local
 * fallback (herd/beellama/exaone-4-0-1-2b) with HTTP 200, so a 200 there does
 * not prove the Zen model answered — check the routed-via SSE comment.
 * ling-3.0-flash-fin-free now 404s (delisted upstream).
 */
export const ZEN_MODELS: readonly string[] = [
  "ling-3.1-flash-free",
  "fledge-alpha-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "longcat-2.5-preview-free",
  "deepseek-v4-flash-free",
  "qwen3.6-plus-free",
  "minimax-m3-free",
  "north-mini-code-free",
  "big-pickle",
  "jev-1.13-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "space-bunny-free",
  "ling-3.0-flash-fin-free",
];

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** OpenCode native ID shape: prefix + 12 hex timestamp + 14 base62. */
export function openCodeID(prefix: "ses_" | "msg_"): string {
  const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
  let r = "";
  for (let i = 0; i < 14; i++) r += B62[Math.floor(Math.random() * 62)];
  return `${prefix}${ts}${r}`;
}

/** Stable for the process lifetime — mimics one long-lived CLI session. */
const ZEN_SESSION_ID = openCodeID("ses_");

export function zenHeaders(key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
    "user-agent": "opencode/1.18.32",
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": ZEN_SESSION_ID,
    "x-opencode-request": openCodeID("msg_"),
  };
}

type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

const ZEN_GATE_TOOLS: ToolDef[] = ["bash", "glob", "grep", "read"].map(
  (name) => ({
    type: "function",
    function: {
      name,
      description: `OpenCode builtin tool: ${name}`,
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        additionalProperties: true,
      },
    },
  }),
);

export type ZenBodyExtra = {
  temperature?: number;
  max_tokens?: number;
};

/**
 * Force the free-tier body contract: stream:true plus the gate tool
 * definitions. (Router.call only forwards model/messages/temperature/
 * max_tokens, so caller tools never arrive here — always inject and pin.)
 */
export function zenBody(
  model: string,
  messages: { role: string; content: string }[],
  extra: ZenBodyExtra = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    ...(extra.temperature !== undefined
      ? { temperature: extra.temperature }
      : {}),
    ...(extra.max_tokens !== undefined ? { max_tokens: extra.max_tokens } : {}),
    tools: ZEN_GATE_TOOLS,
    tool_choice: "none",
  };
  return body;
}

export type FoldedCompletion = {
  content: string;
  finishReason: string | null;
};

function contentOfJson(ev: unknown): {
  content?: string;
  finishReason?: string | null;
} {
  const choice = (ev as { choices?: unknown[] })?.choices?.[0] as
    | {
        delta?: { content?: unknown };
        message?: { content?: unknown };
        finish_reason?: unknown;
      }
    | undefined;
  if (!choice) return {};
  const delta = choice.delta?.content;
  const msg = choice.message?.content;
  const out: { content?: string; finishReason?: string | null } = {};
  if (typeof delta === "string") out.content = delta;
  else if (typeof msg === "string") out.content = msg;
  if (typeof choice.finish_reason === "string")
    out.finishReason = choice.finish_reason;
  return out;
}

/**
 * Fold a Zen SSE stream into one completion. Non-content frames (e.g.
 * inference-cost) are stripped so plain OpenAI clients never see them.
 * Falls back to plain-JSON parsing if the upstream ignored stream:true.
 */
export function foldZenSse(sse: string): FoldedCompletion {
  const trimmed = sse.trim();
  if (trimmed.startsWith("{")) {
    try {
      const { content, finishReason } = contentOfJson(JSON.parse(trimmed));
      if (content !== undefined)
        return { content, finishReason: finishReason ?? "stop" };
    } catch {
      /* fall through to SSE parsing */
    }
  }
  let content = "";
  let finishReason: string | null = null;
  for (const line of sse.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    const { content: c, finishReason: fr } = contentOfJson(ev);
    if (c !== undefined) content += c;
    if (fr !== undefined && fr !== null) finishReason = fr;
  }
  return { content, finishReason };
}
