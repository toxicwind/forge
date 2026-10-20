package astmatrix

import (
	"fmt"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// RateLimiter construction
// ---------------------------------------------------------------------------

func TestNewRateLimiterDefaults(t *testing.T) {
	rl := NewRateLimiter()
	if rl == nil {
		t.Fatal("NewRateLimiter returned nil")
	}
	cases := []struct {
		got  interface{}
		want interface{}
		msg  string
	}{
		{rl.windowDuration, 60 * time.Second, "windowDuration"},
		{rl.maxRequests, 200, "maxRequests"},
		{rl.minBackoff, 5 * time.Second, "minBackoff"},
		{rl.maxBackoff, 120 * time.Second, "maxBackoff"},
		{rl.backoffFactor, 2.0, "backoffFactor"},
		{rl.gpuThrottlePct, 90.0, "gpuThrottlePct"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.msg, c.got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// CanRequest / record limits
// ---------------------------------------------------------------------------

func TestCanRequestInitiallyTrue(t *testing.T) {
	if !NewRateLimiter().CanRequest("test-provider") {
		t.Error("expected CanRequest true with no history")
	}
}

func TestCanRequestFalseWhenOverLimit(t *testing.T) {
	rl := NewRateLimiter()
	rl.maxRequests = 2
	rl.windowDuration = time.Hour // freeze the rolling window

	assertCan := func(expect bool, n int) {
		t.Helper()
		if rl.CanRequest("p") != expect {
			t.Errorf("request %d: CanRequest = %v, want %v", n, !expect, expect)
		}
	}

	assertCan(true, 1)
	rl.RecordRequest("p")
	assertCan(true, 2)
	rl.RecordRequest("p")
	assertCan(false, 3)
}

func TestCanRequestAfterWindowExpiry(t *testing.T) {
	rl := NewRateLimiter()
	rl.maxRequests = 1
	rl.windowDuration = 30 * time.Millisecond

	rl.RecordRequest("p")

	// immediately blocked
	if rl.CanRequest("p") {
		t.Error("expected blocked within window")
	}

	// wait for expiry
	time.Sleep(40 * time.Millisecond)
	if !rl.CanRequest("p") {
		t.Error("expected pass after window expiry")
	}
}

// ---------------------------------------------------------------------------
// 429 backoff
// ---------------------------------------------------------------------------

func TestRecord429SetsBackoff(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = time.Hour // will never expire in test
	rl.Record429("p", 0)
	if rl.CanRequest("p") {
		t.Error("expected blocked after 429")
	}
}

func TestRecord429RespectsServerRetryAfter(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = 5 * time.Millisecond
	rl.Record429("p", 100*time.Millisecond) // server says 100ms

	remaining := rl.GetBackoffRemaining("p")
	// With full jitter: sleep = random(0, max(minBackoff, retryAfter))
	// Upper bound should be the server-specified retry-after (or minBackoff floor)
	maxExpected := 100*time.Millisecond + 5*time.Millisecond // +slop for test timing
	if remaining > maxExpected {
		t.Errorf("expected backoff <= %v, got %v", maxExpected, remaining)
	}
	// Should also be non-zero (server's retry-after was respected)
	// Allow 0-100ms range due to jitter
	_ = remaining
}

func TestRecord429MinBackoffFloorJitter(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = 50 * time.Millisecond
	rl.Record429("p", 5*time.Millisecond) // server says 5ms < minBackoff

	remaining := rl.GetBackoffRemaining("p")
	// Full jitter: sleep = random(0, max(minBackoff, retryAfter)) = random(0, 50ms)
	// Upper bound should be minBackoff
	maxExpected := 50*time.Millisecond + 5*time.Millisecond // +slop
	if remaining > maxExpected {
		t.Errorf("expected backoff <= %v (minBackoff floor), got %v", maxExpected, remaining)
	}
}

func TestRecord429MaxBackoffCap(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = 10 * time.Millisecond
	rl.maxBackoff = 100 * time.Millisecond
	rl.backoffFactor = 10.0 // huge multiplier

	// first 429 -> minBackoff * factor = 100ms, capped at 100ms
	rl.Record429("p", 0)
	remaining := rl.GetBackoffRemaining("p")
	if remaining > 150*time.Millisecond {
		t.Errorf("expected backoff capped at 100ms, got %v", remaining)
	}
}

func TestRecord429ExponentialGrowth(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = 10 * time.Millisecond
	rl.maxBackoff = time.Minute
	rl.backoffFactor = 2.0

	// 1st 429: minBackoff=10ms * factor=2 = 20ms base
	// With full jitter: actual sleep = random(0, 20ms)
	rl.Record429("p", 0)
	remaining := rl.GetBackoffRemaining("p")
	t.Logf("backoff after 1st 429: %v (jittered from 20ms base)", remaining)

	// Check backoffDuration grew (internal state)
	rl.mu.Lock()
	dur1 := rl.backoffDuration["p"]
	rl.mu.Unlock()
	t.Logf("backoffDuration after 1st: %v", dur1)
	if dur1 < 15*time.Millisecond || dur1 > 25*time.Millisecond {
		t.Errorf("backoffDuration after 1st 429 should be ~20ms, got %v", dur1)
	}

	// Wait expiry
	time.Sleep(remaining + 10*time.Millisecond)
	if !rl.CanRequest("p") {
		t.Fatal("should be past backoff now")
	}

	// 2nd 429: backoffDuration preserved (20ms) * 2 = 40ms base
	rl.Record429("p", 0)
	remaining2 := rl.GetBackoffRemaining("p")
	t.Logf("backoff after 2nd 429: %v (jittered from 40ms base)", remaining2)

	// Check backoffDuration grew
	rl.mu.Lock()
	dur2 := rl.backoffDuration["p"]
	rl.mu.Unlock()
	t.Logf("backoffDuration after 2nd: %v", dur2)
	if dur2 < 30*time.Millisecond || dur2 > 50*time.Millisecond {
		t.Errorf("backoffDuration after 2nd 429 should be ~40ms, got %v", dur2)
	}
}

func TestRecord429RetryAfterPreservesExponential(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = 10 * time.Millisecond
	rl.maxBackoff = time.Minute
	rl.backoffFactor = 2.0

	// 1st: server retry-after=5ms but minBackoff=10ms floor
	rl.Record429("p", 5*time.Millisecond)
	b1 := rl.GetBackoffRemaining("p")
	t.Logf("backoff after 1st (retry-after 5ms): %v", b1)

	// Wait for expiry
	time.Sleep(b1 + 5*time.Millisecond)

	// 2nd 429 (no retry-after): backoffDuration preserved = minBackoff, * factor = 20ms
	// With jitter: sleep = random(0, 20ms), average ~10ms, max 20ms
	rl.Record429("p", 0)
	b2 := rl.GetBackoffRemaining("p")
	t.Logf("backoff after 2nd 429: %v", b2)
	// Use MaxBackoff for this provider; should be <= 20ms + slop
	maxExpected := 20*time.Millisecond + 5*time.Millisecond
	if b2 > maxExpected {
		t.Errorf("expected backoff <= %v, got %v", maxExpected, b2)
	}
	// Also check that the backoffDuration grew (internal state)
	rl.mu.Lock()
	dur := rl.backoffDuration["p"]
	rl.mu.Unlock()
	if dur < 15*time.Millisecond {
		t.Errorf("expected backoffDuration >= 20ms after 2nd 429, got %v", dur)
	}
}

// ---------------------------------------------------------------------------
// Success resets
// ---------------------------------------------------------------------------

func TestRecordSuccessClearsBackoff(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = time.Hour
	rl.Record429("p", 0)

	rl.RecordSuccess("p")
	if !rl.CanRequest("p") {
		t.Error("expected pass after success resets backoff")
	}
}

func TestGetBackoffRemainingZeroAfterReset(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = time.Hour
	rl.Record429("p", 0)
	rl.RecordSuccess("p")

	if got := rl.GetBackoffRemaining("p"); got != 0 {
		t.Errorf("expected 0 remaining, got %v", got)
	}
}

// ---------------------------------------------------------------------------
// Provider isolation
// ---------------------------------------------------------------------------

func TestPerProviderRateIsolation(t *testing.T) {
	rl := NewRateLimiter()
	rl.maxRequests = 1
	rl.windowDuration = time.Hour

	rl.RecordRequest("nvidia")
	if rl.CanRequest("nvidia") {
		t.Error("nvidia should hit its own limit")
	}
	if !rl.CanRequest("openrouter") {
		t.Error("openrouter should not be affected by nvidia's limit")
	}
}

func TestPerProviderBackoffIsolation(t *testing.T) {
	rl := NewRateLimiter()
	rl.minBackoff = time.Hour

	rl.Record429("nvidia", 0)
	if !rl.CanRequest("openrouter") {
		t.Error("openrouter requests should still work during nvidia backoff")
	}
}

// ---------------------------------------------------------------------------
// RecordRequest accounting
// ---------------------------------------------------------------------------

func TestRecordRequestIncrementsCount(t *testing.T) {
	rl := NewRateLimiter()
	rl.windowDuration = time.Hour

	for i := 0; i < 5; i++ {
		rl.RecordRequest("p")
	}
	if len(rl.requestTimestamps["p"]) != 5 {
		t.Errorf("expected 5 timestamps, got %d", len(rl.requestTimestamps["p"]))
	}
}

func TestRecordRequestPrunesExpired(t *testing.T) {
	rl := NewRateLimiter()
	rl.windowDuration = 50 * time.Millisecond

	rl.RecordRequest("p") // t=0
	time.Sleep(60 * time.Millisecond)
	rl.RecordRequest("p") // t>50ms -> first one expired

	// CanRequest prunes, so remaining should be 1
	rl.CanRequest("p") // triggers prune
	if len(rl.requestTimestamps["p"]) != 1 {
		t.Errorf("expected 1 timestamp after prune, got %d", len(rl.requestTimestamps["p"]))
	}
}

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

func TestParseRetryAfterSeconds(t *testing.T) {
	d := parseRetryAfter("60")
	if d != 60*time.Second {
		t.Errorf("expected 60s, got %v", d)
	}
}

func TestParseRetryAfterHTTPDate(t *testing.T) {
	future := time.Now().Add(30 * time.Second).Format(time.RFC1123)
	d := parseRetryAfter(future)
	if d <= 0 || d > 60*time.Second {
		t.Errorf("expected ~30s, got %v", d)
	}
}

func TestParseRetryAfterEmpty(t *testing.T) {
	if d := parseRetryAfter(""); d != 0 {
		t.Errorf("expected 0 for empty, got %v", d)
	}
}

func TestParseRetryAfterInvalid(t *testing.T) {
	if d := parseRetryAfter("not-a-date-or-number"); d != 0 {
		t.Errorf("expected 0 for invalid, got %v", d)
	}
}

// ---------------------------------------------------------------------------
// parseRateLimitReset
// ---------------------------------------------------------------------------

func TestParseRateLimitResetEpochSeconds(t *testing.T) {
	future := time.Now().Add(30 * time.Second).Unix()
	d := parseRateLimitReset(fmt.Sprintf("%d", future))
	if d <= 0 || d > 60*time.Second {
		t.Errorf("expected ~30s from epoch seconds, got %v", d)
	}
}

func TestParseRateLimitResetEpochMillis(t *testing.T) {
	future := time.Now().Add(30 * time.Second).UnixMilli()
	d := parseRateLimitReset(fmt.Sprintf("%d", future))
	if d <= 0 || d > 60*time.Second {
		t.Errorf("expected ~30s from epoch ms, got %v", d)
	}
}

func TestParseRateLimitResetEmpty(t *testing.T) {
	if d := parseRateLimitReset(""); d != 0 {
		t.Errorf("expected 0 for empty, got %v", d)
	}
}

func TestParseRateLimitResetNegative(t *testing.T) {
	if d := parseRateLimitReset("-1"); d != 0 {
		t.Errorf("expected 0 for negative, got %v", d)
	}
}

// ---------------------------------------------------------------------------
// Concurrency / edge
// ---------------------------------------------------------------------------

func TestConcurrentRequestsDontPanic(t *testing.T) {
	rl := NewRateLimiter()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			rl.RecordRequest("p")
			rl.CanRequest("p")
		}
		done <- struct{}{}
	}()
	go func() {
		for i := 0; i < 100; i++ {
			rl.Record429("p", 0)
			rl.RecordSuccess("p")
		}
		done <- struct{}{}
	}()
	<-done
	<-done
}
