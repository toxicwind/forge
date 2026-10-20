package flock

import (
	"testing"
)

func TestNewRateLimiter_Empty(t *testing.T) {
	rl := NewRateLimiter(nil)
	if rl == nil {
		t.Fatal("NewRateLimiter returned nil for nil providers")
	}
	if rl.buckets == nil {
		t.Fatal("RateLimiter.buckets should be initialized even with nil providers")
	}
}

func TestNewRateLimiter_FreeTierGetsLowRate(t *testing.T) {
	rl := NewRateLimiter(map[string]ProviderCfg{
		"free": {FreeTier: true},
		"paid": {FreeTier: false},
	})
	if rl == nil {
		t.Fatal("NewRateLimiter returned nil")
	}
	if _, ok := rl.buckets["free"]; !ok {
		t.Fatal("free-tier provider should have a bucket")
	}
	if _, ok := rl.buckets["paid"]; !ok {
		t.Fatal("paid provider should have a bucket")
	}
}

func TestTokenBucket_Allow(t *testing.T) {
	tb := NewTokenBucket(5, 1)
	for i := 0; i < 5; i++ {
		if !tb.Allow() {
			t.Fatalf("expected Allow to return true on call %d", i)
		}
	}
	if tb.Allow() {
		t.Fatal("expected Allow to return false when tokens exhausted")
	}
}
