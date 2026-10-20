/**
 * Prometheus metrics gaps — port of flock-proxy's metrics surface
 * (proxy.rs label helpers + api.rs exposition).
 *
 * Adds what the TS /metrics endpoint lacked vs Rust:
 * - per-request counters with sanitized, cardinality-bounded labels
 *   (model labels capped at 256 distinct values, then "other")
 * - TTFT / upstream-seconds / queue-wait histograms
 * - shed (429 overloaded), unauthorized, and deadline-exceeded counters
 * - coalescing leader/follower counters
 *
 * Label hygiene mirrors Rust: sanitize_label keeps a conservative charset
 * (model ids' charset), drops quotes/braces/newlines/control/ANSI — the
 * injection vectors for Prometheus exposition — and caps length.
 */
const MODEL_LABEL_CAP = 256;
const LABEL_MAX_LEN = 64;

const seenModels = new Set<string>();

/** Reduce a client-supplied string to a safe metric-label / log value. */
export function sanitizeLabel(raw: string): string {
  let out = "";
  for (const c of raw) {
    if (out.length >= LABEL_MAX_LEN) break;
    if (/[A-Za-z0-9._\-/:]/.test(c)) out += c;
  }
  return out || "none";
}

/**
 * Sanitize a model id and bound its cardinality: once MODEL_LABEL_CAP
 * distinct values have been seen, further new ones collapse to "other".
 */
export function boundedModelLabel(raw: string): string {
  const s = sanitizeLabel(raw);
  if (seenModels.has(s)) return s;
  if (seenModels.size < MODEL_LABEL_CAP) {
    seenModels.add(s);
    return s;
  }
  return "other";
}

/** Bound the `path` label to the known OpenAI endpoints; anything else a
 *  client can hit under /v1/ becomes "other". */
export function labelPath(path: string): string {
  switch (path) {
    case "/v1/chat/completions":
    case "/v1/completions":
    case "/v1/embeddings":
    case "/v1/models":
    case "/v1/rankings":
      return path;
    default:
      return "other";
  }
}

interface Histogram {
  sum: number;
  count: number;
  buckets: number[];
  counts: number[];
}

function newHistogram(buckets: number[]): Histogram {
  return { sum: 0, count: 0, buckets, counts: buckets.map(() => 0) };
}

function observe(h: Histogram, v: number): void {
  h.sum += v;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    if (v <= h.buckets[i]!) h.counts[i]! += 1;
  }
}

function renderHistogram(name: string, help: string, h: Histogram): string[] {
  const L: string[] = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} histogram`,
  ];
  let cumulative = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    cumulative += h.counts[i]!;
    L.push(`${name}_bucket{le="${h.buckets[i]}"} ${cumulative}`);
  }
  L.push(`${name}_bucket{le="+Inf"} ${h.count}`);
  L.push(`${name}_sum ${h.sum}`);
  L.push(`${name}_count ${h.count}`);
  return L;
}

class FlockMetrics {
  /** Per-request counter key: provider\0model\0path\0status. */
  private requests = new Map<string, number>();
  private ttft = newHistogram([0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
  private upstream = newHistogram([0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]);
  private queueWait = newHistogram([0.01, 0.05, 0.1, 0.5, 1, 5, 30]);
  shed = 0;
  unauthorized = 0;
  deadlineExceeded = 0;
  coalescedLeader = 0;
  coalescedFollower = 0;
  dispatchTimeout = 0;

  recordRequest(provider: string, model: string, path: string, status: number): void {
    const key = `${sanitizeLabel(provider)}\0${boundedModelLabel(model)}\0${labelPath(path)}\0${status}`;
    this.requests.set(key, (this.requests.get(key) || 0) + 1);
  }

  recordTtft(sec: number): void {
    observe(this.ttft, sec);
  }

  recordUpstream(sec: number): void {
    observe(this.upstream, sec);
  }

  recordQueueWait(sec: number): void {
    observe(this.queueWait, sec);
  }

  render(): string[] {
    const L: string[] = [
      "# HELP estate_flock_requests_total Per-request counter (flock parity)",
      "# TYPE estate_flock_requests_total counter",
    ];
    for (const [k, v] of this.requests) {
      const [provider, model, path, status] = k.split("\0");
      L.push(
        `estate_flock_requests_total{provider="${provider}",model="${model}",path="${path}",status="${status}"} ${v}`,
      );
    }
    L.push(
      "# HELP estate_flock_shed_total Requests rejected 429 past the in-flight cap",
      "# TYPE estate_flock_shed_total counter",
      `estate_flock_shed_total ${this.shed}`,
      "# HELP estate_flock_unauthorized_total Client-key auth failures",
      "# TYPE estate_flock_unauthorized_total counter",
      `estate_flock_unauthorized_total ${this.unauthorized}`,
      "# HELP estate_flock_deadline_exceeded_total Requests killed by x-flock-deadline-ms",
      "# TYPE estate_flock_deadline_exceeded_total counter",
      `estate_flock_deadline_exceeded_total ${this.deadlineExceeded}`,
      "# HELP estate_flock_coalesced_total Coalesced requests by role",
      "# TYPE estate_flock_coalesced_total counter",
      `estate_flock_coalesced_total{role="leader"} ${this.coalescedLeader}`,
      `estate_flock_coalesced_total{role="follower"} ${this.coalescedFollower}`,
      "# HELP estate_flock_dispatch_timeout_total Dispatch slot waits that hit the deadline",
      "# TYPE estate_flock_dispatch_timeout_total counter",
      `estate_flock_dispatch_timeout_total ${this.dispatchTimeout}`,
    );
    L.push(...renderHistogram("estate_flock_ttft_seconds", "Time to first token (streaming)", this.ttft));
    L.push(...renderHistogram("estate_flock_upstream_seconds", "Upstream attempt latency", this.upstream));
    L.push(...renderHistogram("estate_flock_queue_wait_seconds", "FIFO dispatch queue wait", this.queueWait));
    return L;
  }
}

export const flockMetrics = new FlockMetrics();
