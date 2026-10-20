from __future__ import annotations
import os
import sqlite3
import time
from typing import Any




# ---------------------------------------------------------------------------
# HealthDB - persistent model health tracking with healing detection
# ---------------------------------------------------------------------------
class HealthDB:
    """SQLite WAL DB for model health, latency, rate-limit, and healing events."""

    def __init__(self, path: str) -> None:
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._migrate()

    def _migrate(self) -> None:
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS requests (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          REAL    NOT NULL,
                provider    TEXT    NOT NULL,
                model       TEXT    NOT NULL,
                status      INTEGER NOT NULL,
                latency_ms  REAL    NOT NULL,
                strategy    TEXT    NOT NULL DEFAULT '',
                winner      INTEGER NOT NULL DEFAULT 0,
                session_id  TEXT    NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_req_prov_model ON requests(provider, model);
            CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts);

            CREATE TABLE IF NOT EXISTS model_health (
                provider    TEXT    NOT NULL,
                model       TEXT    NOT NULL,
                window_start REAL   NOT NULL,
                successes   INTEGER NOT NULL DEFAULT 0,
                failures    INTEGER NOT NULL DEFAULT 0,
                rate_limited INTEGER NOT NULL DEFAULT 0,
                total_ms    REAL    NOT NULL DEFAULT 0,
                min_ms      REAL    NOT NULL DEFAULT 999999,
                max_ms      REAL    NOT NULL DEFAULT 0,
                PRIMARY KEY (provider, model, window_start)
            );

            CREATE TABLE IF NOT EXISTS healing_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          REAL    NOT NULL,
                provider    TEXT    NOT NULL,
                model       TEXT    NOT NULL,
                event       TEXT    NOT NULL,
                prev_status TEXT    NOT NULL DEFAULT '',
                new_status  TEXT    NOT NULL DEFAULT '',
                details     TEXT    NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_heal_prov ON healing_events(provider, ts);

            CREATE TABLE IF NOT EXISTS rate_limit_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          REAL    NOT NULL,
                provider    TEXT    NOT NULL,
                model       TEXT    NOT NULL,
                status_code INTEGER NOT NULL,
                retry_after REAL    DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rl_prov_ts ON rate_limit_events(provider, ts);

            CREATE TABLE IF NOT EXISTS session_affinity (
                session_id  TEXT PRIMARY KEY,
                provider    TEXT NOT NULL,
                model       TEXT NOT NULL,
                updated_at  REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_affinity_updated ON session_affinity(updated_at);
        """)
        self.conn.commit()

    def record_request(
        self,
        provider: str,
        model: str,
        status: int,
        latency_ms: float,
        strategy: str = "",
        winner: int = 0,
        session_id: str = "",
    ) -> None:
        now = time.time()
        window = now - (now % 300)
        self.conn.execute(
            "INSERT INTO requests"
            " (ts,provider,model,status,latency_ms,strategy,winner,session_id)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (now, provider, model, status, latency_ms, strategy, winner, session_id),
        )
        if status == 200:
            self.conn.execute(
                "INSERT INTO model_health"
                " (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms)"
                " VALUES (?,?,?,1,0,?,?,?)"
                " ON CONFLICT(provider,model,window_start) DO UPDATE SET"
                " successes=successes+1, total_ms=total_ms+excluded.total_ms,"
                " min_ms=min(min_ms,excluded.min_ms),"
                " max_ms=max(max_ms,excluded.max_ms)",
                (provider, model, window, latency_ms, latency_ms, latency_ms),
            )
        elif status == 429:
            self.conn.execute(
                "INSERT INTO model_health"
                " (provider,model,window_start,successes,failures,rate_limited,total_ms,min_ms,max_ms)"
                " VALUES (?,?,?,0,0,1,?,?,?)"
                " ON CONFLICT(provider,model,window_start) DO UPDATE SET"
                " rate_limited=rate_limited+1",
                (provider, model, window, latency_ms, latency_ms, latency_ms),
            )
        else:
            self.conn.execute(
                "INSERT INTO model_health"
                " (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms)"
                " VALUES (?,?,?,0,1,?,?,?)"
                " ON CONFLICT(provider,model,window_start) DO UPDATE SET"
                " failures=failures+1, total_ms=total_ms+excluded.total_ms,"
                " min_ms=min(min_ms,excluded.min_ms),"
                " max_ms=max(max_ms,excluded.max_ms)",
                (provider, model, window, latency_ms, latency_ms, latency_ms),
            )
        self.conn.commit()

    def record_rate_limit(
        self,
        provider: str,
        model: str,
        status_code: int,
        retry_after: float | None = None,
    ) -> None:
        self.conn.execute(
            "INSERT INTO rate_limit_events"
            " (ts,provider,model,status_code,retry_after)"
            " VALUES (?,?,?,?,?)",
            (time.time(), provider, model, status_code, retry_after),
        )
        self.conn.commit()

    def record_healing(
        self,
        provider: str,
        model: str,
        event: str,
        prev_status: str = "",
        new_status: str = "",
        details: str = "",
    ) -> None:
        self.conn.execute(
            "INSERT INTO healing_events"
            " (ts,provider,model,event,prev_status,new_status,details)"
            " VALUES (?,?,?,?,?,?,?)",
            (time.time(), provider, model, event, prev_status, new_status, details),
        )
        self.conn.commit()

    def get_health_score(
        self, provider: str, model: str, window_minutes: int = 30
    ) -> float:
        cutoff = time.time() - (window_minutes * 60)
        row = self.conn.execute(
            "SELECT SUM(successes), SUM(failures) FROM model_health"
            " WHERE provider=? AND model=? AND window_start>=?",
            (provider, model, cutoff),
        ).fetchone()
        if not row or (row[0] is None and row[1] is None):
            return 0.5
        s: int = row[0] or 0
        f: int = row[1] or 0
        total = s + f
        return s / total if total > 0 else 0.5

    def get_avg_latency(
        self, provider: str, model: str, window_minutes: int = 30
    ) -> float:
        cutoff = time.time() - (window_minutes * 60)
        row = self.conn.execute(
            "SELECT AVG(total_ms / (successes + failures)) FROM model_health"
            " WHERE provider=? AND model=? AND window_start>=?"
            " AND (successes + failures) > 0",
            (provider, model, cutoff),
        ).fetchone()
        return float(row[0]) if row and row[0] is not None else -1.0

    def get_recent_healing(
        self, provider: str, limit: int = 10
    ) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT ts,model,event,prev_status,new_status,details"
            " FROM healing_events WHERE provider=?"
            " ORDER BY ts DESC LIMIT ?",
            (provider, limit),
        ).fetchall()
        return [
            {
                "ts": r[0],
                "model": r[1],
                "event": r[2],
                "prev": r[3],
                "new": r[4],
                "details": r[5],
            }
            for r in rows
        ]

    def get_provider_summary(self) -> dict[str, dict[str, Any]]:
        cutoff = time.time() - 1800
        rows = self.conn.execute(
            "SELECT provider, SUM(successes), SUM(failures),"
            " AVG(total_ms / max(successes+failures,1)),"
            " SUM(rate_limited) FROM model_health"
            " WHERE window_start>=? GROUP BY provider",
            (cutoff,),
        ).fetchall()
        result: dict[str, dict[str, Any]] = {}
        for r in rows:
            prov: str = r[0]
            s: int = r[1] or 0
            f: int = r[2] or 0
            total = s + f
            result[prov] = {
                "successes": s,
                "failures": f,
                "success_rate": round(s / total, 3) if total > 0 else None,
                "avg_latency_ms": round(float(r[3]), 1) if r[3] is not None else None,
                "rate_limited": r[4] or 0,
            }
        return result

    def sticky_get(
        self, session_id: str, ttl: float = 1800
    ) -> tuple[str | None, str | None]:
        cutoff = time.time() - ttl
        row = self.conn.execute(
            "SELECT provider, model FROM session_affinity"
            " WHERE session_id=? AND updated_at>=?",
            (session_id, cutoff),
        ).fetchone()
        if row:
            return row[0], row[1]
        return None, None

    def sticky_set(self, session_id: str, provider: str, model: str) -> None:
        self.conn.execute(
            "INSERT INTO session_affinity(session_id, provider, model, updated_at)"
            " VALUES (?,?,?,?)"
            " ON CONFLICT(session_id) DO UPDATE SET"
            " provider=excluded.provider, model=excluded.model,"
            " updated_at=excluded.updated_at",
            (session_id, provider, model, time.time()),
        )
        self.conn.commit()

    def cleanup_old(self, days: int = 7) -> int:
        cutoff = time.time() - (days * 86400)
        c1 = self.conn.execute("DELETE FROM requests WHERE ts<?", (cutoff,)).rowcount
        c2 = self.conn.execute(
            "DELETE FROM model_health WHERE window_start<?", (cutoff,)
        ).rowcount
        c3 = self.conn.execute(
            "DELETE FROM healing_events WHERE ts<?", (cutoff,)
        ).rowcount
        c4 = self.conn.execute(
            "DELETE FROM rate_limit_events WHERE ts<?", (cutoff,)
        ).rowcount
        c5 = self.conn.execute(
            "DELETE FROM session_affinity WHERE updated_at<?",
            (time.time() - 86400,),
        ).rowcount
        self.conn.commit()
        return c1 + c2 + c3 + c4 + c5
