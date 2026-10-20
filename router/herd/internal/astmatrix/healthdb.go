package astmatrix

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// HealthDB tracks provider health in SQLite WAL mode.
type HealthDB struct {
	db *sql.DB
}

// NewHealthDB opens or creates the health database.
func NewHealthDB(path string) (*HealthDB, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("healthdb mkdir: %w", err)
	}
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=5000", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("healthdb open: %w", err)
	}
	h := &HealthDB{db: db}
	if err := h.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("healthdb migrate: %w", err)
	}
	return h, nil
}

func (h *HealthDB) migrate() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS requests (
 		id INTEGER PRIMARY KEY AUTOINCREMENT,
 		ts REAL NOT NULL,
 		provider TEXT NOT NULL,
 		model TEXT NOT NULL,
 		status INTEGER NOT NULL,
 		latency_ms REAL NOT NULL,
 		strategy TEXT NOT NULL DEFAULT '',
 		winner INTEGER NOT NULL DEFAULT 0,
 		session_id TEXT NOT NULL DEFAULT ''
 	)`,
		`CREATE INDEX IF NOT EXISTS idx_req_prov_model ON requests(provider, model)`,
		`CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts)`,

		`CREATE TABLE IF NOT EXISTS model_health (
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
 	)`,

		`CREATE TABLE IF NOT EXISTS healing_events (
 		id INTEGER PRIMARY KEY AUTOINCREMENT,
 		ts REAL NOT NULL,
 		provider TEXT NOT NULL,
 		model TEXT NOT NULL,
 		event TEXT NOT NULL,
 		prev_status TEXT NOT NULL DEFAULT '',
 		new_status TEXT NOT NULL DEFAULT '',
 		details TEXT NOT NULL DEFAULT ''
 	)`,

		`CREATE TABLE IF NOT EXISTS rate_limit_events (
 		id INTEGER PRIMARY KEY AUTOINCREMENT,
 		ts REAL NOT NULL,
 		provider TEXT NOT NULL,
 		model TEXT NOT NULL,
 		status_code INTEGER NOT NULL,
 		retry_after REAL DEFAULT NULL
 	)`,

		`CREATE TABLE IF NOT EXISTS session_affinity (
 		session_id TEXT PRIMARY KEY,
 		provider TEXT NOT NULL,
 		model TEXT NOT NULL,
 		updated_at REAL NOT NULL
 	)`,
	}
	for _, stmt := range statements {
		if _, err := h.db.Exec(stmt); err != nil {
			return fmt.Errorf("migrate exec: %w", err)
		}
	}
	return nil
}

func (h *HealthDB) Close() error {
	return h.db.Close()
}

// RecordRequest inserts a request record and updates model_health.
func (h *HealthDB) RecordRequest(provider, model string, status int, latencyMs float64, strategy string, winner int, sessionID string) {
	now := float64(time.Now().UnixMilli()) / 1000.0
	window := now - float64(int64(now)%300)

	// Insert request
	h.db.Exec(`INSERT INTO requests (ts,provider,model,status,latency_ms,strategy,winner,session_id) VALUES (?,?,?,?,?,?,?,?)`,
		now, provider, model, status, latencyMs, strategy, winner, sessionID)

	if status == 200 {
		h.db.Exec(`INSERT INTO model_health (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms) VALUES (?,?,?,1,0,?,?,?) ON CONFLICT(provider,model,window_start) DO UPDATE SET successes=successes+1,total_ms=total_ms+excluded.total_ms,min_ms=min(min_ms,excluded.min_ms),max_ms=max(max_ms,excluded.max_ms)`,
			provider, model, window, latencyMs, latencyMs, latencyMs)
	} else if status == 429 {
		h.db.Exec(`INSERT INTO model_health (provider,model,window_start,successes,failures,rate_limited,total_ms,min_ms,max_ms) VALUES (?,?,?,0,0,1,?,?,?) ON CONFLICT(provider,model,window_start) DO UPDATE SET rate_limited=rate_limited+1`,
			provider, model, window, latencyMs, latencyMs, latencyMs)
	} else {
		h.db.Exec(`INSERT INTO model_health (provider,model,window_start,successes,failures,total_ms,min_ms,max_ms) VALUES (?,?,?,0,1,?,?,?) ON CONFLICT(provider,model,window_start) DO UPDATE SET failures=failures+1,total_ms=total_ms+excluded.total_ms,min_ms=min(min_ms,excluded.min_ms),max_ms=max(max_ms,excluded.max_ms)`,
			provider, model, window, latencyMs, latencyMs, latencyMs)
	}
}

// RecordRateLimit logs a rate-limit event.
func (h *HealthDB) RecordRateLimit(provider, model string, statusCode int) {
	now := float64(time.Now().UnixMilli()) / 1000.0
	h.db.Exec(`INSERT INTO rate_limit_events (ts,provider,model,status_code,retry_after) VALUES (?,?,?,?,NULL)`, now, provider, model, statusCode)
}

// RecordHealing logs a circuit-breaker healing event.
func (h *HealthDB) RecordHealing(provider, model, event, prevStatus, newStatus, details string) {
	now := float64(time.Now().UnixMilli()) / 1000.0
	h.db.Exec(`INSERT INTO healing_events (ts,provider,model,event,prev_status,new_status,details) VALUES (?,?,?,?,?,?,?)`,
		now, provider, model, event, prevStatus, newStatus, details)
}

// ProviderSummary returns aggregated health stats for the last 30 minutes.
type ProviderHealth struct {
	Successes   int
	Failures    int
	SuccessRate float64
	AvgLatency  float64
	RateLimited int
}

func (h *HealthDB) ProviderSummary() map[string]ProviderHealth {
	cutoff := float64(time.Now().UnixMilli())/1000.0 - 1800.0
	rows, err := h.db.Query(`
		SELECT provider,
		       SUM(successes) AS successes,
		       SUM(failures) AS failures,
		       AVG(total_ms / max(successes+failures,1)) AS avg_ms,
		       SUM(rate_limited) AS rate_limited
		FROM model_health WHERE window_start>=? GROUP BY provider`, cutoff)
	if err != nil {
		return nil
	}
	defer rows.Close()
	result := make(map[string]ProviderHealth)
	for rows.Next() {
		var p string
		var successes, failures, rateLimited int
		var avgMs sql.NullFloat64
		if err := rows.Scan(&p, &successes, &failures, &avgMs, &rateLimited); err != nil {
			continue
		}
		total := successes + failures
		h := ProviderHealth{
			Successes:   successes,
			Failures:    failures,
			RateLimited: rateLimited,
		}
		if total > 0 {
			h.SuccessRate = float64(successes) / float64(total)
		}
		if avgMs.Valid {
			h.AvgLatency = avgMs.Float64
		}
		result[p] = h
	}
	return result
}

// StickyGet retrieves session affinity, returning (provider, model) or empty.
func (h *HealthDB) StickyGet(sessionID string, ttl int) (string, string) {
	cutoff := float64(time.Now().UnixMilli())/1000.0 - float64(ttl)
	var provider, model string
	err := h.db.QueryRow(`SELECT provider, model FROM session_affinity WHERE session_id=? AND updated_at>=?`, sessionID, cutoff).Scan(&provider, &model)
	if err != nil {
		return "", ""
	}
	return provider, model
}

// StickySet upserts session affinity.
func (h *HealthDB) StickySet(sessionID, provider, model string) {
	now := float64(time.Now().UnixMilli()) / 1000.0
	h.db.Exec(`INSERT INTO session_affinity (session_id,provider,model,updated_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,model=excluded.model,updated_at=excluded.updated_at`,
		sessionID, provider, model, now)
}

// DebugAgg returns raw aggregation rows for debugging.
func (h *HealthDB) DebugAgg() []map[string]interface{} {
	rows, err := h.db.Query(`SELECT model, provider, status, count(*) as cnt, avg(latency_ms) as avg_ms FROM requests GROUP BY model, provider, status ORDER BY cnt DESC LIMIT 20`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var result []map[string]interface{}
	for rows.Next() {
		var model, provider string
		var status, cnt int
		var avgMs float64
		if err := rows.Scan(&model, &provider, &status, &cnt, &avgMs); err != nil {
			continue
		}
		result = append(result, map[string]interface{}{
			"model": model, "provider": provider, "status": status, "count": cnt, "avg_ms": avgMs,
		})
	}
	return result
}
