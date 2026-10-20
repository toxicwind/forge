package freeproxy

import (
	"net/http"
	"sync"
	"time"
)

// Registry is the maximal modular free-provider router.
// It holds all providers, a shared rate limiter, and a shared cache.
type Registry struct {
	providers []Provider
	byModel   map[string]Provider
	mu        sync.RWMutex
	limiter   RateLimiter
	cache     Cache
}

func NewRegistry(limiter RateLimiter, cache Cache) *Registry {
	r := &Registry{
		byModel: make(map[string]Provider),
		limiter: limiter,
		cache:   cache,
	}
	// Order matters: Cloudflare gateway first (caching), then direct pollinations, then others
	r.providers = []Provider{
		NewCloudflareGatewayProvider(),
		NewPollinationsProvider(limiter, cache),
		NewOVHProvider(),
		NewOpenRouterProvider(),
	}
	for _, p := range r.providers {
		for _, m := range p.Models() {
			// First provider wins for a model ID; CF gateway shadows direct if enabled
			if _, exists := r.byModel[m]; !exists {
				r.byModel[m] = p
			}
		}
	}
	return r
}

func (r *Registry) Handles(model string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.byModel[model]
	return ok
}

func (r *Registry) ProviderFor(model string) (Provider, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.byModel[model]
	return p, ok
}

func (r *Registry) Models() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.byModel))
	for m := range r.byModel {
		out = append(out, m)
	}
	return out
}

func (r *Registry) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Extract model from request via shared.FetchContext or body — caller should have set context.
	// For maximal modularity, we try to extract model from JSON body if not in context.
	// This registry is called from server dispatch, so model is already known.
	// We just proxy via the provider for that model (set in request context by caller).
	// Caller must have validated Handles before calling.
	http.Error(w, "freeproxy registry: use ProviderFor", http.StatusInternalServerError)
}

// Simple in-memory RateLimiter and Cache for maximal but ponytail-style

type memoryLimiter struct {
	mu       sync.Mutex
	last     map[string]time.Time
	interval time.Duration
}

func NewMemoryLimiter(interval time.Duration) RateLimiter {
	return &memoryLimiter{last: make(map[string]time.Time), interval: interval}
}
func (m *memoryLimiter) Allow(provider string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, ok := m.last[provider]
	if !ok || time.Since(last) >= m.interval {
		m.last[provider] = time.Now()
		return true
	}
	return false
}
func (m *memoryLimiter) Wait(provider string) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, ok := m.last[provider]
	if !ok {
		return 0
	}
	elapsed := time.Since(last)
	if elapsed >= m.interval {
		return 0
	}
	return m.interval - elapsed
}

type memoryCache struct {
	mu   sync.Mutex
	data map[string]cacheEntry
}
type cacheEntry struct {
	value []byte
	exp   time.Time
}

func NewMemoryCache() Cache {
	return &memoryCache{data: make(map[string]cacheEntry)}
}
func (c *memoryCache) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.data[key]
	if !ok || time.Now().After(e.exp) {
		if ok {
			delete(c.data, key)
		}
		return nil, false
	}
	return e.value, true
}
func (c *memoryCache) Set(key string, value []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[key] = cacheEntry{value: value, exp: time.Now().Add(ttl)}
}
