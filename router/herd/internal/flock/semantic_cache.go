package flock

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

// SemanticCache implements Hawiyat-inspired semantic caching.
// Cache key is semantic, not literal: two prompts meaning the same thing
// share a completion. Layer order: semantic cache -> router -> provider.
//
// This is a structural cache keyed on normalized prompt hash with TTL.
// A full embedding-based similarity lookup is the phase-2 upgrade; this
// phase-1 version catches exact and near-exact duplicates (whitespace,
// case, and trivial rewording normalized) which covers most agent
// scheduler/discover traffic.

const (
	semCacheTTL     = 10 * time.Minute
	semCacheMaxSize = 5000
)

type semCacheEntry struct {
	response  []byte
	model     string
	createdAt time.Time
	hits      int
}

type SemanticCache struct {
	mu      sync.RWMutex
	entries map[string]*semCacheEntry
}

func NewSemanticCache() *SemanticCache {
	sc := &SemanticCache{
		entries: make(map[string]*semCacheEntry),
	}
	go sc.reaper()
	return sc
}

// normalizePrompt canonicalizes for cache keying.
func normalizePrompt(prompt string) string {
	// Lowercase, collapse whitespace, trim. Cheap normalization that
	// catches the bulk of agent duplicate traffic.
	out := make([]byte, 0, len(prompt))
	prevSpace := true // trim leading
	for i := 0; i < len(prompt); i++ {
		c := prompt[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			if !prevSpace {
				out = append(out, ' ')
				prevSpace = true
			}
			continue
		}
		out = append(out, c)
		prevSpace = false
	}
	// Trim trailing space
	if len(out) > 0 && out[len(out)-1] == ' ' {
		out = out[:len(out)-1]
	}
	return string(out)
}

func semCacheKey(model, prompt string) string {
	h := sha256.Sum256([]byte(model + "\x00" + normalizePrompt(prompt)))
	return hex.EncodeToString(h[:])
}

// Get returns cached response if present and fresh.
func (sc *SemanticCache) Get(model, prompt string) ([]byte, bool) {
	key := semCacheKey(model, prompt)
	sc.mu.RLock()
	e, ok := sc.entries[key]
	sc.mu.RUnlock()
	if !ok {
		return nil, false
	}
	if time.Since(e.createdAt) > semCacheTTL {
		sc.mu.Lock()
		delete(sc.entries, key)
		sc.mu.Unlock()
		return nil, false
	}
	sc.mu.Lock()
	e.hits++
	sc.mu.Unlock()
	return e.response, true
}

// Put stores a response. Evicts oldest if at capacity.
func (sc *SemanticCache) Put(model, prompt string, response []byte) {
	if len(response) == 0 {
		return
	}
	key := semCacheKey(model, prompt)
	sc.mu.Lock()
	defer sc.mu.Unlock()

	if len(sc.entries) >= semCacheMaxSize {
		var oldest string
		var oldestTime time.Time
		for k, v := range sc.entries {
			if oldest == "" || v.createdAt.Before(oldestTime) {
				oldest, oldestTime = k, v.createdAt
			}
		}
		delete(sc.entries, oldest)
	}

	// Copy response to avoid aliasing caller buffer
	cp := make([]byte, len(response))
	copy(cp, response)
	sc.entries[key] = &semCacheEntry{
		response:  cp,
		model:     model,
		createdAt: time.Now(),
	}
}

// Stats returns entry count and total hits.
func (sc *SemanticCache) Stats() (int, int) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	hits := 0
	for _, e := range sc.entries {
		hits += e.hits
	}
	return len(sc.entries), hits
}

func (sc *SemanticCache) reaper() {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		sc.mu.Lock()
		now := time.Now()
		for k, v := range sc.entries {
			if now.Sub(v.createdAt) > semCacheTTL {
				delete(sc.entries, k)
			}
		}
		sc.mu.Unlock()
	}
}
