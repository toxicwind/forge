/**
 * The winner ledger.
 *
 * A router that treats every candidate equally is a router that pays for a slow
 * provider forever. The ledger remembers which provider actually returns valid
 * content for a given model, and `order()` puts the proven winner first.
 *
 * Persistence is an append-only JSONL file of CUMULATIVE snapshots, so load is
 * last-write-wins. (The previous build summed snapshots on load, inflating
 * every counter on every restart.) Writes are batched (1s) and the file is
 * compacted on boot when it has grown well past the live key count.
 * Call `flush()` on shutdown.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerEntry = { model: string; provider: string; wins: number; total: number; lastLatencyMs: number };

const DEFAULT_PATH = "/home/toxic/pens/estate/var/cuttinggate/ledger.jsonl";
const FLUSH_MS = 1_000;
const SEP = "\u001f";

const keyOf = (model: string, provider: string): string => `${provider}${SEP}${model}`;

function isEntry(v: unknown): v is LedgerEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.model === "string" &&
    typeof e.provider === "string" &&
    typeof e.wins === "number" && Number.isFinite(e.wins) &&
    typeof e.total === "number" && Number.isFinite(e.total) && e.total > 0 &&
    typeof e.lastLatencyMs === "number" && Number.isFinite(e.lastLatencyMs)
  );
}

export class Ledger {
  private entries = new Map<string, LedgerEntry>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private path: string = process.env.CUTTINGGATE_LEDGER ?? DEFAULT_PATH) {
    this.load();
  }

  private load(): void {
    let lines = 0;
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        lines += 1;
        try {
          const e: unknown = JSON.parse(line);
          if (isEntry(e)) this.entries.set(keyOf(e.model, e.provider), { ...e });
        } catch {
          // A torn final line is expected on an unclean kill; skip it.
        }
      }
    } catch {
      return; // No ledger yet is the normal first-boot state.
    }
    if (lines > this.entries.size * 2 + 64) this.compact();
  }

  private compact(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, [...this.entries.values()].map((e) => JSON.stringify(e)).join("\n") + "\n");
      renameSync(tmp, this.path);
    } catch {
      // Compaction is an optimisation; the append-only file stays valid.
    }
  }

  /** Write every dirty entry now. Safe to call repeatedly; call on shutdown. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty.size) return;
    const lines: string[] = [];
    for (const key of this.dirty) {
      const e = this.entries.get(key);
      if (e) lines.push(JSON.stringify(e));
    }
    this.dirty.clear();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, lines.join("\n") + "\n");
    } catch {
      // A ledger that cannot persist must not break serving.
    }
  }

  record(model: string, provider: string, latencyMs: number, valid: boolean): void {
    const key = keyOf(model, provider);
    const prev = this.entries.get(key);
    this.entries.set(key, {
      model,
      provider,
      wins: (prev?.wins ?? 0) + (valid ? 1 : 0),
      total: (prev?.total ?? 0) + 1,
      lastLatencyMs: latencyMs,
    });
    this.dirty.add(key);
    if (!this.timer) {
      const t = setTimeout(() => this.flush(), FLUSH_MS);
      t.unref?.();
      this.timer = t;
    }
  }

  /** Providers ordered by proven win rate, then by most recent latency. */
  order(model: string, candidates: readonly string[]): string[] {
    const scored = candidates.map((p) => {
      const e = this.entries.get(keyOf(model, p));
      return { p, rate: e ? e.wins / e.total : 0, seen: e ? e.total : 0, ms: e?.lastLatencyMs ?? Number.POSITIVE_INFINITY };
    });
    // An unproven provider sorts after proven winners but keeps its original
    // position among equals (Array.prototype.sort is stable).
    scored.sort((a, b) => {
      if (a.seen > 0 && b.seen > 0) return b.rate - a.rate || a.ms - b.ms;
      if (a.seen > 0) return -1;
      if (b.seen > 0) return 1;
      return 0;
    });
    return scored.map((s) => s.p);
  }

  top(n: number): LedgerEntry[] {
    return [...this.entries.values()].sort((a, b) => b.wins / b.total - a.wins / a.total).slice(0, n);
  }

  models(): Set<string> {
    return new Set([...this.entries.values()].map((e) => e.model));
  }

  total(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.total;
    return n;
  }
}
