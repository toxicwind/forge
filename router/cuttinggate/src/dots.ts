/**
 * Estate Dots-3-Note coercion provider for cuttinggate (custom/dots).
 * Neutralizes: Ghost outputs, list:string mismatches, 22s latency, and replay crashes.
 */

export const DOTS_PROVIDER = "custom/dots";
export const DOTS_LEGACY_PROVIDER = "dots";
export const DOTS_MODEL = "dots-studio/dots-3-note-preview:free";
export const DOTS_MODELS: readonly string[] = [
  "custom/dots",
  "dots-studio/dots-3-note-preview:free",
  "openrouter/dots-studio/dots-3-note-preview:free",
];

export const DOTS_STOP_TOKENS: readonly string[] = [
  "</tool_call>",
  "</dots_function_call>",
  "<|endoftext|>",
  "```",
];

export interface DotsMessage {
  role: string;
  content: string | null;
  [key: string]: unknown;
}

export interface DotsTool {
  type?: string;
  function?: {
    name: string;
    description?: string;
    strict?: boolean;
    parameters?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function normalizeDotsMessages(messages: readonly DotsMessage[]): { role: string; content: string; [key: string]: unknown }[] {
  return messages.map((m) => {
    const msg = { ...m };
    if (msg.role === "assistant" && (msg.content === null || msg.content === undefined)) {
      msg.content = "";
    }
    return msg as { role: string; content: string; [key: string]: unknown };
  });
}

export function injectStrictTools(tools: readonly DotsTool[] | undefined): DotsTool[] | undefined {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => {
    const st = JSON.parse(JSON.stringify(t)) as DotsTool;
    if (st.function) {
      st.function.strict = true;
      if (st.function.parameters && typeof st.function.parameters === "object") {
        st.function.parameters.additionalProperties = false;
      }
    }
    return st;
  });
}

export interface DotsBodyOptions {
  sessionId?: string;
  tools?: readonly DotsTool[];
  tool_choice?: unknown;
  forced_tool?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  require_parameters?: boolean;
  reasoning?: Record<string, unknown>;
}

export function dotsBody(
  messages: readonly DotsMessage[],
  opts: DotsBodyOptions = {},
): Record<string, unknown> {
  const normalizedMessages = normalizeDotsMessages(messages);
  const strictTools = injectStrictTools(opts.tools);
  const toolChoice = opts.forced_tool
    ? { type: "function", function: { name: opts.forced_tool } }
    : opts.tool_choice !== undefined
      ? opts.tool_choice
      : strictTools
        ? "auto"
        : undefined;
  const requireParameters = opts.require_parameters ?? true;

  return {
    model: DOTS_MODEL,
    messages: normalizedMessages,
    ...(strictTools ? { tools: strictTools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(opts.stream !== undefined ? { stream: opts.stream } : {}),
    sessionId: opts.sessionId ?? "estate-dots-session",
    max_tokens: opts.max_tokens ?? 4096,
    temperature: opts.temperature ?? 0.1,
    reasoning: opts.reasoning ?? {
      max_tokens: 128,
      exclude: true,
    },
    // OpenRouter returns 404 "no endpoints found" when custom stop sequences
    // and provider.require_parameters:true are combined. Skip stop when requireParameters is true.
    ...(requireParameters ? {} : { stop: [...DOTS_STOP_TOKENS] }),
    provider: {
      require_parameters: requireParameters,
      allow_fallbacks: false,
    },
  };
}
