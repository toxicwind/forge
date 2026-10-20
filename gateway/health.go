package flock

import "sync"
import "time"

type HealthDB struct {
	mu      sync.RWMutex
	records map[string]*HealthRecord
	interval time.Duration
}

type HealthRecord struct {
	Successes   int
	Failures    int
	LastLatency time.Duration
	LastCheck   time.Time
}

func NewHealthDB(interval time.Duration) *HealthDB {
	return &HealthDB{records: make(map[string]*HealthRecord), interval: interval}
}

func (h *HealthDB) IsHealthy(name string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	r, ok := h.records[name]
	if !ok { return true }
	total := r.Successes + r.Failures
	if total == 0 { return true }
	return float64(r.Failures)/float64(total) < 0.5 && time.Since(r.LastCheck) < h.interval*3
}

func (h *HealthDB) Latency(name string) time.Duration {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if r, ok := h.records[name]; ok { return r.LastLatency }
	return time.Hour
}

func (h *HealthDB) Record(name string, success bool, latency time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.records[name]
	if !ok { r = &HealthRecord{}; h.records[name] = r }
	if success { r.Successes++ } else { r.Failures++ }
	r.LastLatency = latency
	r.LastCheck = time.Now()
}
