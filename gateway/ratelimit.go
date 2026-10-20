package flock

import (
	"math"
	"sync"
	"time"
)

type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	rps     float64
}

type tokenBucket struct {
	tokens     float64
	capacity   float64
	lastRefill time.Time
}

func NewRateLimiter(rps float64) *RateLimiter {
	return &RateLimiter{buckets: make(map[string]*tokenBucket), rps: rps}
}

func (rl *RateLimiter) Acquire(name string, tokens float64) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[name]
	if !ok {
		b = &tokenBucket{tokens: rl.rps, capacity: rl.rps, lastRefill: time.Now()}
		rl.buckets[name] = b
	}
	rl.refill(b)
	if b.tokens >= tokens {
		b.tokens -= tokens
		return true
	}
	return false
}

func (rl *RateLimiter) Release(name string, tokens float64) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if b, ok := rl.buckets[name]; ok {
		b.tokens = math.Min(b.capacity, b.tokens+tokens)
	}
}

func (rl *RateLimiter) RecordLatency(name string, latency time.Duration) {}

func (rl *RateLimiter) refill(b *tokenBucket) {
	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens = math.Min(b.capacity, b.tokens+elapsed*rl.rps)
	b.lastRefill = now
}
