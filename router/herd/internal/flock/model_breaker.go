package flock

import (
	"crypto/sha256"
	"encoding/binary"
	"sync"
	"time"
)

// ModelBreakerRegistry implements per-model circuit breakers.
// Borrowed from ENTERPILOT/GoModel (Go, 1193 stars).
//
// Flock breaks at the *provider* level — one bad model (e.g. a 404'd NIM
// model) poisons the whole provider. Per-model breakers isolate blast radius:
// a dead model trips only its own breaker, the provider stays healthy for
// its other models. This is the routing-layer fix for the phantom-model
// problem ("102 listed, 5 live").
//
// Design: breakers sharded by SHA-256 of model name, capped at 1024 entries,
// LRU-ish eviction of idle+closed breakers (10-min TTL). Active breakers
// are never evicted. Falls back to the shared provider breaker when the
// model scope doesn't apply.

const (
	maxModelBreakers    = 1024
	modelBreakerIdleTTL = 10 * time.Minute
)

type modelBreakerEntry struct {
	breaker  *CircuitBreaker
	lastUsed time.Time
}

type ModelBreakerRegistry struct {
	mu       sync.RWMutex
	breakers map[uint64]*modelBreakerEntry // shard key -> entry
	// fallback provider-level breakers (existing behavior)
	fallback func(provider string) *CircuitBreaker
}

func NewModelBreakerRegistry(fallback func(provider string) *CircuitBreaker) *ModelBreakerRegistry {
	mbr := &ModelBreakerRegistry{
		breakers: make(map[uint64]*modelBreakerEntry),
		fallback: fallback,
	}
	go mbr.reaper()
	return mbr
}

func modelShardKey(model string) uint64 {
	h := sha256.Sum256([]byte(model))
	return binary.BigEndian.Uint64(h[:8])
}

// ForModel returns the circuit breaker for a specific model.
// Creates one on demand (up to the cap). Falls back to provider breaker
// when model is empty or the registry is at capacity.
func (mbr *ModelBreakerRegistry) ForModel(provider, model string) *CircuitBreaker {
	if model == "" {
		return mbr.fallback(provider)
	}

	key := modelShardKey(model)

	// Fast path: read lock
	mbr.mu.RLock()
	if e, ok := mbr.breakers[key]; ok {
		mbr.mu.RUnlock()
		// Update lastUsed (write lock, but only on hit)
		mbr.mu.Lock()
		e.lastUsed = time.Now()
		mbr.mu.Unlock()
		return e.breaker
	}
	mbr.mu.RUnlock()

	// Slow path: create
	mbr.mu.Lock()
	defer mbr.mu.Unlock()

	// Double-check after acquiring write lock
	if e, ok := mbr.breakers[key]; ok {
		e.lastUsed = time.Now()
		return e.breaker
	}

	// At capacity: evict an idle+closed breaker, or fall back
	if len(mbr.breakers) >= maxModelBreakers {
		if !mbr.evictIdleLocked() {
			return mbr.fallback(provider)
		}
	}

	cb := NewCircuitBreaker(5, 30*time.Second)
	mbr.breakers[key] = &modelBreakerEntry{
		breaker:  cb,
		lastUsed: time.Now(),
	}
	return cb
}

// evictIdleLocked removes one idle+closed breaker. Returns true if evicted.
// Caller must hold write lock.
func (mbr *ModelBreakerRegistry) evictIdleLocked() bool {
	var oldestKey uint64
	var oldestTime time.Time
	found := false

	for k, e := range mbr.breakers {
		if e.breaker.State() != StateClosed {
			continue // never evict active breakers
		}
		if time.Since(e.lastUsed) < modelBreakerIdleTTL {
			continue
		}
		if !found || e.lastUsed.Before(oldestTime) {
			oldestKey, oldestTime, found = k, e.lastUsed, true
		}
	}

	if found {
		delete(mbr.breakers, oldestKey)
		return true
	}
	return false
}

// Size returns current breaker count (monitoring).
func (mbr *ModelBreakerRegistry) Size() int {
	mbr.mu.RLock()
	defer mbr.mu.RUnlock()
	return len(mbr.breakers)
}

func (mbr *ModelBreakerRegistry) reaper() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		mbr.mu.Lock()
		now := time.Now()
		for k, e := range mbr.breakers {
			if e.breaker.State() == StateClosed && now.Sub(e.lastUsed) > modelBreakerIdleTTL {
				delete(mbr.breakers, k)
			}
		}
		mbr.mu.Unlock()
	}
}
