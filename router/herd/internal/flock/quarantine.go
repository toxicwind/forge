package flock

import (
	"sync"
	"time"
)

// ImmediateQuarantine implements the Dynamo-inspired failure detection:
// mark a provider dead on the FIRST in-path failure signal (timeout, 5xx,
// 429, connection refused) rather than waiting for the next 30s probe tick.
//
// This is the "Smart Router" pattern: bypass the slow health-check
// propagation, quarantine immediately, canary half-open for recovery.
//
// Key rule from the gateway audit: 4xx (except 429) must NOT trip the
// breaker — that's a caller bug, not provider health.

type QuarantineReason int

const (
	ReasonNone QuarantineReason = iota
	ReasonTimeout
	ReasonServerError // 5xx
	ReasonRateLimit   // 429
	ReasonConnRefused
)

type quarantineEntry struct {
	reason      QuarantineReason
	quarantined time.Time
	// canary state: allow 1 probe after canaryDelay
	canaryAt time.Time
}

type ImmediateQuarantine struct {
	mu          sync.RWMutex
	quarantined map[string]*quarantineEntry
	// how long before a quarantined provider gets a canary probe
	canaryDelay time.Duration
	// callback when provider is quarantined (for metrics/alerts)
	onQuarantine func(provider string, reason QuarantineReason)
}

func NewImmediateQuarantine(canaryDelay time.Duration) *ImmediateQuarantine {
	if canaryDelay <= 0 {
		canaryDelay = 10 * time.Second
	}
	return &ImmediateQuarantine{
		quarantined: make(map[string]*quarantineEntry),
		canaryDelay: canaryDelay,
	}
}

// Signal records an in-path failure. Returns true if this newly quarantined
// the provider (false if already quarantined or not a quarantine-worthy error).
//
// statusCode: HTTP status (0 = timeout/connection failure)
// Returns false for 4xx (except 429) — caller bugs don't quarantine.
func (iq *ImmediateQuarantine) Signal(provider string, statusCode int, timedOut bool) bool {
	reason := classifyFailure(statusCode, timedOut)
	if reason == ReasonNone {
		return false
	}

	iq.mu.Lock()
	defer iq.mu.Unlock()

	if _, ok := iq.quarantined[provider]; ok {
		return false // already quarantined
	}

	iq.quarantined[provider] = &quarantineEntry{
		reason:      reason,
		quarantined: time.Now(),
		canaryAt:    time.Now().Add(iq.canaryDelay),
	}

	if iq.onQuarantine != nil {
		// Call outside lock to avoid deadlock
		go iq.onQuarantine(provider, reason)
	}
	return true
}

// IsQuarantined returns true if provider is currently quarantined.
// A provider becomes canary-eligible after canaryDelay (single probe allowed).
func (iq *ImmediateQuarantine) IsQuarantined(provider string) bool {
	iq.mu.RLock()
	defer iq.mu.RUnlock()
	e, ok := iq.quarantined[provider]
	if !ok {
		return false
	}
	// If past canary time, allow one probe (caller should use AllowCanary)
	return time.Now().Before(e.canaryAt)
}

// AllowCanary returns true if this provider is due for a canary probe.
// Only one caller should get true (compare-and-swap on canaryAt).
func (iq *ImmediateQuarantine) AllowCanary(provider string) bool {
	iq.mu.Lock()
	defer iq.mu.Unlock()
	e, ok := iq.quarantined[provider]
	if !ok {
		return false
	}
	if time.Now().Before(e.canaryAt) {
		return false
	}
	// Grant canary: push next canary out to prevent thundering herd
	e.canaryAt = time.Now().Add(iq.canaryDelay)
	return true
}

// Clear removes quarantine (provider recovered via canary success).
func (iq *ImmediateQuarantine) Clear(provider string) {
	iq.mu.Lock()
	defer iq.mu.Unlock()
	delete(iq.quarantined, provider)
}

// QuarantinedList returns all currently quarantined providers.
func (iq *ImmediateQuarantine) QuarantinedList() map[string]QuarantineReason {
	iq.mu.RLock()
	defer iq.mu.RUnlock()
	out := make(map[string]QuarantineReason, len(iq.quarantined))
	for k, v := range iq.quarantined {
		out[k] = v.reason
	}
	return out
}

func classifyFailure(statusCode int, timedOut bool) QuarantineReason {
	if timedOut {
		return ReasonTimeout
	}
	if statusCode == 0 {
		return ReasonConnRefused
	}
	if statusCode == 429 {
		return ReasonRateLimit
	}
	if statusCode >= 500 {
		return ReasonServerError
	}
	// 4xx (except 429) = caller bug, not provider health. Don't quarantine.
	return ReasonNone
}

// ReasonString for logging/metrics.
func (r QuarantineReason) String() string {
	switch r {
	case ReasonTimeout:
		return "timeout"
	case ReasonServerError:
		return "5xx"
	case ReasonRateLimit:
		return "429"
	case ReasonConnRefused:
		return "conn_refused"
	default:
		return "none"
	}
}
