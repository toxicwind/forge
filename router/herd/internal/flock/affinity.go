package flock

import (
	"sync"
	"time"
)

// SessionAffinity implements SAGA-inspired workflow-aware routing.
// AI agents execute tens-hundreds of chained LLM calls per task. Routing each
// call independently destroys KV-cache warmth and inflates latency 3-8x.
// This pins all calls in one agent workflow to the same provider/model.
//
// Usage: client sends X-Flock-Session: <agent-id or task-id> header.
// Router looks up the pinned provider for that session, routes there if healthy.
// Pin expires after sessionTTL of inactivity.

const (
	sessionTTL    = 30 * time.Minute
	sessionHeader = "X-Flock-Session"
	maxSessions   = 10000
)

type sessionPin struct {
	provider  string
	model     string
	lastUsed  time.Time
	callCount int
}

type SessionAffinity struct {
	mu       sync.RWMutex
	sessions map[string]*sessionPin
}

func NewSessionAffinity() *SessionAffinity {
	sa := &SessionAffinity{
		sessions: make(map[string]*sessionPin),
	}
	go sa.reaper()
	return sa
}

// Pin records that sessionID was served by provider/model.
func (sa *SessionAffinity) Pin(sessionID, provider, model string) {
	if sessionID == "" {
		return
	}
	sa.mu.Lock()
	defer sa.mu.Unlock()

	// Evict oldest if at capacity
	if len(sa.sessions) >= maxSessions {
		var oldest string
		var oldestTime time.Time
		for k, v := range sa.sessions {
			if oldest == "" || v.lastUsed.Before(oldestTime) {
				oldest, oldestTime = k, v.lastUsed
			}
		}
		delete(sa.sessions, oldest)
	}

	if pin, ok := sa.sessions[sessionID]; ok {
		pin.lastUsed = time.Now()
		pin.callCount++
		// Update pin if provider changed (failover)
		pin.provider, pin.model = provider, model
	} else {
		sa.sessions[sessionID] = &sessionPin{
			provider:  provider,
			model:     model,
			lastUsed:  time.Now(),
			callCount: 1,
		}
	}
}

// Lookup returns the pinned provider/model for a session, or "", "" if none.
func (sa *SessionAffinity) Lookup(sessionID string) (string, string) {
	if sessionID == "" {
		return "", ""
	}
	sa.mu.RLock()
	defer sa.mu.RUnlock()
	if pin, ok := sa.sessions[sessionID]; ok {
		if time.Since(pin.lastUsed) < sessionTTL {
			return pin.provider, pin.model
		}
	}
	return "", ""
}

// Unpin removes a session (e.g., on provider death, force re-route).
func (sa *SessionAffinity) Unpin(sessionID string) {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	delete(sa.sessions, sessionID)
}

// Stats returns session count and total calls for monitoring.
func (sa *SessionAffinity) Stats() (int, int) {
	sa.mu.RLock()
	defer sa.mu.RUnlock()
	total := 0
	for _, p := range sa.sessions {
		total += p.callCount
	}
	return len(sa.sessions), total
}

func (sa *SessionAffinity) reaper() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		sa.mu.Lock()
		now := time.Now()
		for k, v := range sa.sessions {
			if now.Sub(v.lastUsed) > sessionTTL {
				delete(sa.sessions, k)
			}
		}
		sa.mu.Unlock()
	}
}
