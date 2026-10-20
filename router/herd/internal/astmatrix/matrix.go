package astmatrix

import (
	"fmt"
	"math"
	"math/rand"
	"os"
	"sync"
	"time"
)

// Matrix holds the runtime state for all providers: ELO scores, circuit
// breakers, fail counters, and the health database.
type Matrix struct {
	mu               sync.RWMutex
	providers        map[string]*provider
	live             *LiveCatalogReader // TS-exported live serving sets (data, not logic)
	fail             map[string]int     // consecutive failures per provider
	lastFail         map[string]float64 // last failure timestamp
	elo              map[string]float64
	circuit          map[string]string // "closed" | "open" | "half"
	circuitOpenUntil map[string]float64
	fifoDepth        int
	health           *HealthDB
	rateLimiter      *PerProviderRateLimiter
	config           *AstMatrixConfig
}

// NewMatrix creates a Matrix from config, loading secrets from env.
func NewMatrix(cfg *AstMatrixConfig) (*Matrix, error) {
	cfg.Defaults()

	providers := defaultProviders()

	// Provider→models membership comes from the TS package brain. Providers
	// start on their generated cold-start seeds; the live serving sets are
	// overlaid from the TS-exported live catalog file when present. This is
	// a synchronous file read — no discovery, no network, no goroutine, no
	// race. When the TS side quarantines or re-admits a model it rewrites
	// the file and the next read picks it up.
	live := NewLiveCatalogReader("")
	live.SyncProviderModels(providers)

	// Override provider configs from YAML if provided
	for name, pcfg := range cfg.Providers {
		if p, ok := providers[name]; ok {
			if pcfg.BaseURL != "" {
				p.base = pcfg.BaseURL
			}
			if pcfg.KeyEnv != "" {
				p.keyEnv = pcfg.KeyEnv
			}
			if pcfg.KeyEnvAlt != "" {
				p.keyEnvAlt = pcfg.KeyEnvAlt
			}
			if pcfg.NoAuth {
				p.noAuth = true
			}
		} else {
			providers[name] = &provider{
				base:      pcfg.BaseURL,
				keyEnv:    pcfg.KeyEnv,
				keyEnvAlt: pcfg.KeyEnvAlt,
				noAuth:    pcfg.NoAuth,
			}
		}
	}

	health, err := NewHealthDB(cfg.DbPath)
	if err != nil {
		return nil, err
	}

	elo := make(map[string]float64)
	circuit := make(map[string]string)
	for name := range providers {
		elo[name] = 1000
		circuit[name] = "closed"
	}

	m := &Matrix{
		rateLimiter:      NewRateLimiter(),
		providers:        providers,
		live:             live,
		fail:             make(map[string]int),
		lastFail:         make(map[string]float64),
		elo:              elo,
		circuit:          circuit,
		circuitOpenUntil: make(map[string]float64),
		health:           health,
		config:           cfg,
	}
	return m, nil
}

// SyncLiveCatalog re-reads the TS-exported live catalog file and overlays
// the serving sets onto the live provider table. Call this from admin
// handlers or SIGHUP-style triggers — never on a timer. Discovery itself
// lives in the TS package; this only picks up the new answer.
func (m *Matrix) SyncLiveCatalog() {
	if m.live == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.live.SyncProviderModels(m.providers)
}

// LiveCatalog exposes the TS-exported live serving-set reader.
func (m *Matrix) LiveCatalog() *LiveCatalogReader {
	return m.live
}

// Record updates ELO scores and circuit breakers after a request completes.
func (m *Matrix) Record(model, prov string, status int, lat float64, winner int, strategy, session string) {
	latMs := lat * 1000
	m.health.RecordRequest(prov, model, status, latMs, strategy, winner, session)

	m.mu.Lock()
	defer m.mu.Unlock()

	now := float64(time.Now().UnixMilli()) / 1000.0
	if status == 200 {
		old := m.circuit[prov]
		m.elo[prov] += 16
		m.fail[prov] = 0
		m.lastFail[prov] = now
		m.circuit[prov] = "closed"
		if old != "closed" {
			m.health.RecordHealing(prov, model, "circuit_recovered", old, "closed", "")
		}
	} else if status == 429 {
		m.health.RecordRateLimit(prov, model, status)
		m.elo[prov] = math.Max(100, m.elo[prov]-8)
		m.fail[prov]++
		m.lastFail[prov] = now
	} else {
		m.fail[prov]++
		m.lastFail[prov] = now
		m.elo[prov] = math.Max(100, m.elo[prov]-32)
		if m.fail[prov] >= 3 {
			old := m.circuit[prov]
			m.circuit[prov] = "open"
			m.circuitOpenUntil[prov] = now + 60
			m.health.RecordHealing(prov, model, "circuit_opened", old, "open",
				fmt.Sprintf("%d consecutive failures", m.fail[prov]))
		}
	}
}

// StickyGet retrieves session affinity via HealthDB.
func (m *Matrix) StickyGet(sessionID string) (string, string) {
	return m.health.StickyGet(sessionID, m.config.StickyTTL)
}

// StickySet stores session affinity via HealthDB.
func (m *Matrix) StickySet(sessionID, provider, model string) {
	m.health.StickySet(sessionID, provider, model)
}

// CircuitOk reports whether the provider's circuit breaker allows requests.
func (m *Matrix) CircuitOk(p string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	st := m.circuit[p]
	if st == "closed" || st == "half" {
		return true
	}
	if st == "open" {
		now := float64(time.Now().UnixMilli()) / 1000.0
		if now > m.circuitOpenUntil[p] {
			m.circuit[p] = "half"
			return true
		}
		return false
	}
	return true
}

// ELO returns the current ELO score for a provider.
func (m *Matrix) ELO(p string) float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.elo[p]
}

// CircuitState returns the circuit breaker state for a provider.
func (m *Matrix) CircuitState(p string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.circuit[p]
}

// Providers returns the provider map (read-only snapshot).
func (m *Matrix) Providers() map[string]*provider {
	return m.providers
}

// Health returns the health database.
func (m *Matrix) Health() *HealthDB {
	return m.health
}

// Close closes the health database.
func (m *Matrix) Close() error {
	return m.health.Close()
}

// PickWeighted selects up to n providers weighted by ELO + jitter.
// The live catalog is synced first (request-triggered, not timer-polled):
// if the TS brain rewrote the serving sets, the next routing decision sees
// it. The sync is cheap when the file mtime is unchanged, and it runs
// before the read lock is taken so there is no lock-upgrade deadlock.
func (m *Matrix) PickWeighted(n int) [][2]string {
	m.SyncLiveCatalog()
	m.mu.RLock()
	defer m.mu.RUnlock()

	type scored struct {
		score float64
		name  string
		model string
	}
	var all []scored
	for name := range m.providers {
		if !m.keyOkLocked(name) || !m.circuitOkLocked(name) {
			continue
		}
		mid := firstModelFor(name)
		if mid == "" {
			continue
		}
		jitter := rand.Float64() * 10
		all = append(all, scored{m.elo[name] + jitter, name, mid})
	}
	// Sort descending by score
	for i := 0; i < len(all); i++ {
		for j := i + 1; j < len(all); j++ {
			if all[j].score > all[i].score {
				all[i], all[j] = all[j], all[i]
			}
		}
	}
	seen := make(map[string]bool)
	var result [][2]string
	for _, s := range all {
		if seen[s.name] {
			continue
		}
		seen[s.name] = true
		result = append(result, [2]string{s.name, s.model})
		if len(result) >= n {
			break
		}
	}
	return result
}

// keyOkLocked checks if the provider has a valid API key (caller holds lock).
func (m *Matrix) keyOkLocked(name string) bool {
	p, ok := m.providers[name]
	if !ok {
		return false
	}
	if p.noAuth {
		return true
	}
	if os.Getenv(p.keyEnv) != "" {
		return true
	}
	if p.keyEnvAlt != "" && os.Getenv(p.keyEnvAlt) != "" {
		return true
	}
	return false
}

// circuitOkLocked is the non-mutating version (caller holds lock).
func (m *Matrix) circuitOkLocked(p string) bool {
	st := m.circuit[p]
	if st == "closed" || st == "half" {
		return true
	}
	if st == "open" {
		now := float64(time.Now().UnixMilli()) / 1000.0
		return now > m.circuitOpenUntil[p]
	}
	return true
}

// firstModelFor returns the default model for a provider.
func firstModelFor(p string) string {
	if p == "herd" {
		return "local-quality"
	}
	providers := defaultProviders()
	if prov, ok := providers[p]; ok && len(prov.models) > 0 {
		return prov.models[0]
	}
	return ""
}

// KeyOk checks if a provider has a valid API key (public, no lock).
func (m *Matrix) KeyOk(name string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.keyOkLocked(name)
}

// GetKey returns the API key for a provider.
func (m *Matrix) GetKey(p string) string {
	prov, ok := m.providers[p]
	if !ok {
		return ""
	}
	if prov.noAuth {
		return "not-required-for-local"
	}
	if k := os.Getenv(prov.keyEnv); k != "" {
		return k
	}
	if prov.keyEnvAlt != "" {
		if k := os.Getenv(prov.keyEnvAlt); k != "" {
			return k
		}
	}
	return ""
}
