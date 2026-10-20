/**
 * flock/ts/strategy/governor — model-pressure governor (AIMD).
 *
 * Ported from estate-scripts-router's router_matrix.ts Governor. Per
 * provider/model admission control: refused fast with 429 when the model
 * is at its worker cap or draining.
 *
 * Ownership note: the Rust proxy's governor.rs owns the hot path. This
 * module is the portable TS equivalent for standalone TS serving layers,
 * bench tooling, and tests — same admission semantics, write-behind JSON
 * snapshot persistence, operator-pinned overrides.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface GovernorModelState {
  limit: number; // 0 = ungoverned
  inflight: number;
  blockedUntil: number; // epoch seconds; 0 = not blocked
  lastExhausted: number; // epoch seconds; 0 = never
  lastAdjusted: number; // epoch seconds; 0 = never
  exhaustedTotal: number; // lifetime counter (metrics)
}

interface GovernorSnapshotFile {
  models: Record<
    string,
    {
      limit: number;
      lastExhausted: number;
      lastAdjusted: number;
      blockedUntil: number;
      exhaustedTotal: number;
    }
  >;
}

/// A held admission: the request is (about to be) in flight on this model.
/// Call release() on every exit path (try/finally) — it is idempotent.
export class ModelPermit {
  private released = false;
  constructor(
    private gov: Governor,
    readonly key: string,
  ) {}
  release(): void {
    if (!this.released) {
      this.released = true;
      this.gov.release(this.key);
    }
  }
}

export class Governor {
  static readonly EXHAUST_BACKOFF_S = 2;
  static readonly GROW_INTERVAL_S = 60;
  static readonly DISSOLVE_AFTER_S = 30 * 60;
  private static readonly SAVE_DEBOUNCE_S = 5;

  private models = new Map<string, GovernorModelState>();
  /** Operator-pinned caps (key -> limit); pinned models skip adaptation. */
  overrides = new Map<string, number>();
  private persistPath: string | null;
  private lastSave = 0;
  private dirty = false;

  constructor(persistPath: string | null = null) {
    this.persistPath = persistPath;
    this.restore();
  }

  private st(key: string): GovernorModelState {
    let s = this.models.get(key);
    if (!s) {
      s = {
        limit: 0,
        inflight: 0,
        blockedUntil: 0,
        lastExhausted: 0,
        lastAdjusted: 0,
        exhaustedTotal: 0,
      };
      this.models.set(key, s);
    }
    return s;
  }

  /** Try to admit a request on `key`; null when at cap / in drain gap. */
  admit(key: string, nowS = Date.now() / 1000): ModelPermit | null {
    const s = this.st(key);
    // Adaptive lifecycle (skipped for operator-pinned models): dissolve
    // after a long clean period, else grow one per stable minute. Lazy —
    // evaluated under demand, which is the only time the cap matters.
    if (!this.overrides.has(key) && s.limit > 0) {
      if (
        s.lastExhausted > 0 &&
        nowS - s.lastExhausted >= Governor.DISSOLVE_AFTER_S
      ) {
        s.limit = 0;
        s.lastAdjusted = nowS;
        this.markDirty();
      } else if (
        s.lastAdjusted > 0 &&
        nowS - s.lastAdjusted >= Governor.GROW_INTERVAL_S
      ) {
        s.limit += 1;
        s.lastAdjusted = nowS;
        this.markDirty();
      }
    }
    if (s.blockedUntil > nowS) return null;
    const limit = this.overrides.get(key) ?? s.limit;
    if (limit > 0 && s.inflight >= limit) return null;
    s.inflight += 1;
    return new ModelPermit(this, key);
  }

  release(key: string): void {
    const s = this.models.get(key);
    if (s) s.inflight = Math.max(0, s.inflight - 1);
  }

  /**
   * Record a worker-exhaustion error on `key`. Call while the failing
   * request's permit is still held, so the observed in-flight count
   * includes it. Engages (or tightens) the cap at half that count and
   * opens a short drain gap; operator-pinned models only get the gap.
   */
  noteExhausted(key: string, nowS = Date.now() / 1000): void {
    const s = this.st(key);
    s.exhaustedTotal += 1;
    s.blockedUntil = nowS + Governor.EXHAUST_BACKOFF_S;
    s.lastExhausted = nowS;
    if (!this.overrides.has(key)) {
      s.limit = Math.max(1, Math.floor(s.inflight / 2));
      s.lastAdjusted = nowS;
    }
    this.markDirty();
  }

  /** Governed-model entries for metrics: [key, state]. */
  entries(): [string, GovernorModelState][] {
    return [...this.models.entries()];
  }

  // -- persistence: write-behind JSON, wall-clock seconds ------------------
  private markDirty(): void {
    this.dirty = true;
    if (Date.now() / 1000 - this.lastSave >= Governor.SAVE_DEBOUNCE_S)
      this.save();
  }

  /** Flush a pending snapshot now (also used by tests). */
  save(): void {
    if (!this.persistPath || !this.dirty) return;
    try {
      const models: GovernorSnapshotFile["models"] = {};
      for (const [k, s] of this.models) {
        if (s.limit <= 0 && s.exhaustedTotal <= 0) continue;
        models[k] = {
          limit: s.limit,
          lastExhausted: s.lastExhausted,
          lastAdjusted: s.lastAdjusted,
          blockedUntil: s.blockedUntil,
          exhaustedTotal: s.exhaustedTotal,
        };
      }
      writeFileSync(this.persistPath, JSON.stringify({ models }, null, 1));
      this.lastSave = Date.now() / 1000;
      this.dirty = false;
    } catch {
      /* persistence is best-effort; admission semantics are untouched */
    }
  }

  private restore(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const snap = JSON.parse(raw) as GovernorSnapshotFile;
      const nowS = Date.now() / 1000;
      for (const [k, m] of Object.entries(snap.models || {})) {
        if (!m || m.limit <= 0) continue;
        const s = this.st(k);
        s.limit = m.limit;
        s.lastExhausted = m.lastExhausted || 0;
        s.lastAdjusted = m.lastAdjusted || 0;
        // Elapsed drain gaps are not resurrected; pacing is, so the AIMD
        // lifecycle continues where it left off.
        s.blockedUntil = m.blockedUntil > nowS ? m.blockedUntil : 0;
        s.exhaustedTotal = m.exhaustedTotal || 0;
        // inflight restarts at 0 — in-flight requests didn't survive reboot.
      }
    } catch {
      /* no snapshot yet — start clean */
    }
  }
}

/** Worker-exhaustion signature detector (router_matrix isWorkerExhausted). */
export function isWorkerExhausted(body: string): boolean {
  return body.includes("Worker local total request limit");
}
