import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { STICKY_TTL } from "./router_config.ts";

// ---------------------------------------------------------------------------
// HealthDB (SQLite WAL) — same schema as Python
// ---------------------------------------------------------------------------
export class HealthDB {
  conn: Database;

  constructor(path: string) {
    const dir = dirname(path);
    try {
      Bun.spawnSync(["mkdir", "-p", dir]);
    } catch {
      /* ok */
    }
    this.conn = new Database(path);
    this.conn.exec("PRAGMA journal_mode=WAL");
    this.conn.exec("PRAGMA synchronous=NORMAL");
    this.migrate();
  }

  migrate(): void {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status INTEGER NOT NULL,
        latency_ms REAL NOT NULL,
        strategy TEXT NOT NULL DEFAULT '',
        winner INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_req_prov_model ON requests(provider, model);
      CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts);

      CREATE TABLE IF NOT EXISTS model_health (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        window_start REAL NOT NULL,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        rate_limited INTEGER NOT NULL DEFAULT 0,
        total_ms REAL NOT NULL DEFAULT 0,
        min_ms REAL NOT NULL DEFAULT 999999,
        max_ms REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (provider, model, window_start)
      );

      CREATE TABLE IF NOT EXISTS healing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        event TEXT NOT NULL,
        prev_status TEXT NOT NULL DEFAULT '',
        new_status TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        retry_after REAL DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS session_affinity (
        session_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS elo_state (
        provider TEXT PRIMARY KEY,
        elo REAL NOT NULL,
        updated_at REAL NOT NULL
      );
    `);
    // 1M-context pin (DECISION 12187): pinned rows carry est tokens.
    // Idempotent — ALTER fails on a live DB if the column already exists,
    // so gate on PRAGMA table_info.
    const cols = this.conn
      .query(`PRAGMA table_info(requests)`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === "est_tokens")) {
      this.conn.exec(
        `ALTER TABLE requests ADD COLUMN est_tokens REAL NOT NULL DEFAULT 0`,
      );
    }
  }

  recordRequest(
    provider: string,
    model: string,
    status: number,
    latencyMs: number,
    strategy = "",
    winner = 0,
    sessionId = "",
    estTokens = 0,
  ): void {
    const now = Date.now() / 1000;
    const window = now - (now % 300);
    this.conn
      .query(
        `INSERT INTO requests (ts,provider,model,status,latency_ms,strategy,winner,session_id,est_tokens)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        now,
        provider,
        model,
        status,
        latencyMs,
        strategy,
        winner,
        sessionId,
        estTokens,
      );

    if (status === 200) {
      this.conn
        .query(
          `INSERT INTO model_health
           (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms)
           VALUES (?,?,?,1,0,?,?,?)
           ON CONFLICT(provider,model,window_start) DO UPDATE SET
             successes=successes+1, total_ms=total_ms+excluded.total_ms,
             min_ms=min(min_ms,excluded.min_ms), max_ms=max(max_ms,excluded.max_ms)`,
        )
        .run(provider, model, window, latencyMs, latencyMs, latencyMs);
    } else if (status === 429) {
      this.conn
        .query(
          `INSERT INTO model_health
           (provider,model,window_start,successes,failures,rate_limited,total_ms,min_ms,max_ms)
           VALUES (?,?,?,0,0,1,?,?,?)
           ON CONFLICT(provider,model,window_start) DO UPDATE SET
             rate_limited=rate_limited+1`,
        )
        .run(provider, model, window, latencyMs, latencyMs, latencyMs);
    } else {
      this.conn
        .query(
          `INSERT INTO model_health
           (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms)
           VALUES (?,?,?,0,1,?,?,?)
           ON CONFLICT(provider,model,window_start) DO UPDATE SET
             failures=failures+1, total_ms=total_ms+excluded.total_ms,
             min_ms=min(min_ms,excluded.min_ms), max_ms=max(max_ms,excluded.max_ms)`,
        )
        .run(provider, model, window, latencyMs, latencyMs, latencyMs);
    }
  }

  recordRateLimit(provider: string, model: string, statusCode: number): void {
    this.conn
      .query(
        `INSERT INTO rate_limit_events (ts,provider,model,status_code,retry_after)
         VALUES (?,?,?,?,NULL)`,
      )
      .run(Date.now() / 1000, provider, model, statusCode);
  }

  recordHealing(
    provider: string,
    model: string,
    event: string,
    prevStatus = "",
    newStatus = "",
    details = "",
  ): void {
    this.conn
      .query(
        `INSERT INTO healing_events
         (ts,provider,model,event,prev_status,new_status,details)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now() / 1000,
        provider,
        model,
        event,
        prevStatus,
        newStatus,
        details,
      );
  }

  /**
   * Elo durability (2026-09-21): provider Elo is written through on every
   * update (Matrix.setElo) and restored on startup, so a daemon restart no
   * longer wipes live-learned values back to bench priors. bench-priors.json
   * remains the fallback when no stored row exists.
   */
  saveElo(provider: string, elo: number): void {
    this.conn
      .query(
        `INSERT INTO elo_state (provider, elo, updated_at)
         VALUES (?,?,?)
         ON CONFLICT(provider) DO UPDATE SET
           elo=excluded.elo, updated_at=excluded.updated_at`,
      )
      .run(provider, elo, Date.now() / 1000);
  }

  /** All persisted provider Elos; {} when nothing was ever stored. */
  loadElo(): Record<string, number> {
    const rows = this.conn.query(`SELECT provider, elo FROM elo_state`).all() as {
      provider: string;
      elo: number;
    }[];
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (typeof r.elo === "number" && Number.isFinite(r.elo)) {
        out[r.provider] = r.elo;
      }
    }
    return out;
  }

  getProviderSummary(): Record<
    string,
    {
      successes: number;
      failures: number;
      success_rate: number | null;
      avg_latency_ms: number | null;
      rate_limited: number;
    }
  > {
    const cutoff = Date.now() / 1000 - 1800;
    const rows = this.conn
      .query(
        `SELECT provider AS provider,
                SUM(successes) AS successes,
                SUM(failures) AS failures,
                AVG(total_ms / max(successes+failures,1)) AS avg_ms,
                SUM(rate_limited) AS rate_limited
         FROM model_health
         WHERE window_start>=? GROUP BY provider`,
      )
      .all(cutoff) as {
      provider: string;
      successes: number;
      failures: number;
      avg_ms: number | null;
      rate_limited: number;
    }[];
    const result: ReturnType<HealthDB["getProviderSummary"]> = {};
    for (const r of rows) {
      const s = r.successes || 0;
      const f = r.failures || 0;
      const total = s + f;
      result[r.provider] = {
        successes: s,
        failures: f,
        success_rate: total > 0 ? Math.round((s / total) * 1000) / 1000 : null,
        avg_latency_ms:
          r.avg_ms != null ? Math.round(Number(r.avg_ms) * 10) / 10 : null,
        rate_limited: r.rate_limited || 0,
      };
    }
    return result;
  }

  /** p50/p95 of successful request latency per provider, last 30 min. */
  getLatencyPercentiles(): Record<string, { p50_ms: number | null; p95_ms: number | null; n: number }> {
    const cutoff = Date.now() / 1000 - 1800;
    const out: Record<string, { p50_ms: number | null; p95_ms: number | null; n: number }> = {};
    const provs = this.conn
      .query(`SELECT DISTINCT provider FROM requests WHERE ts>=?`)
      .all(cutoff) as { provider: string }[];
    for (const { provider } of provs) {
      const rows = this.conn
        .query(
          `SELECT latency_ms FROM requests
           WHERE provider=? AND ts>=? AND status=200
           ORDER BY latency_ms`,
        )
        .all(provider, cutoff) as { latency_ms: number }[];
      if (!rows.length) {
        out[provider] = { p50_ms: null, p95_ms: null, n: 0 };
        continue;
      }
      const q = (p: number) => rows[Math.min(rows.length - 1, Math.floor(p * rows.length))].latency_ms;
      const r2 = (v: number) => Math.round(v * 10) / 10;
      out[provider] = { p50_ms: r2(q(0.5)), p95_ms: r2(q(0.95)), n: rows.length };
    }
    return out;
  }

  /** Pinned-path credit guard (DECISION 12187): requests logged under a
   *  strategy since UTC midnight. The pin counts EVERY attempt (ok or not)
   *  — every attempt burns key credits. */
  countStrategyToday(strategy: string): number {
    const row = this.conn
      .query(
        `SELECT COUNT(*) AS n FROM requests
         WHERE strategy=? AND ts >= strftime('%s','now','start of day')`,
      )
      .get(strategy) as { n: number } | null;
    return row?.n || 0;
  }

  stickyGet(
    sessionId: string,
    ttl = STICKY_TTL,
  ): [string | null, string | null] {
    const cutoff = Date.now() / 1000 - ttl;
    const row = this.conn
      .query(
        `SELECT provider, model FROM session_affinity
         WHERE session_id=? AND updated_at>=?`,
      )
      .get(sessionId, cutoff) as { provider: string; model: string } | null;
    return row ? [row.provider, row.model] : [null, null];
  }

  stickySet(sessionId: string, provider: string, model: string): void {
    this.conn
      .query(
        `INSERT INTO session_affinity (session_id, provider, model, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at`,
      )
      .run(sessionId, provider, model, Date.now() / 1000);
  }

  recentHealing(provider: string, limit = 10) {
    return this.conn
      .query(
        `SELECT ts,model,event,prev_status,new_status,details
         FROM healing_events WHERE provider=?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(provider, limit);
  }

  debugAgg() {
    return this.conn
      .query(
        `SELECT model, provider, status, count(*), avg(latency_ms)
         FROM requests GROUP BY model, provider, status
         ORDER BY count(*) DESC LIMIT 20`,
      )
      .all();
  }
}
