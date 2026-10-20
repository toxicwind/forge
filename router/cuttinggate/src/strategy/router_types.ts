export type ChatBody = Record<string, unknown> & {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
};

export type RouteResult = {
  ok: boolean;
  status: number;
  provider?: string;
  model?: string;
  lat?: number;
  data?: Uint8Array | string;
  stream?: ReadableStream<Uint8Array> | null;
  err?: string;
  winner?: number;
  // Per-hop timings (HFT: measure every hop) — populated by callOne.
  timings?: { connect_ms: number; ttft_ms: number | null; total_ms: number };
};
