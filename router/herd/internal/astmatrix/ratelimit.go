package astmatrix

import (
	"math/rand"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PerProviderRateLimiter tracks request rates per provider and implements
// exponential backoff when 429s are received from upstream APIs (notably
// NVIDIA NIM which returns 429 with no body when rate-limited).
type PerProviderRateLimiter struct {
	mu sync.Mutex

	// per-provider state
	requestTimestamps map[string][]time.Time   // rolling window of request timestamps
	backoffUntil      map[string]time.Time     // provider is prohibited until this time
	backoffDuration   map[string]time.Duration // current backoff duration (exponential)
	rateLimitCount    map[string]int           // consecutive 429 count per provider

	// GPU memory pressure (nvidia-smi) — when VRAM is tight, NIM may throttle
	lastGpuCheck time.Time
	gpuFreeMB    int
	gpuTotalMB   int

	// configuration
	windowDuration time.Duration // rolling window (default: 60s)
	maxRequests    int           // max requests per window (default: 60, NIM free tier)
	minBackoff     time.Duration // initial backoff (default: 5s)
	maxBackoff     time.Duration // max backoff (default: 120s)
	backoffFactor  float64       // exponential factor (default: 2.0)
	gpuThrottlePct float64       // GPU mem threshold % that triggers backoff (default: 90)
}

// NewRateLimiter creates a rate limiter with sensible defaults for NVIDIA NIM.
func NewRateLimiter() *PerProviderRateLimiter {
	return &PerProviderRateLimiter{
		requestTimestamps: make(map[string][]time.Time),
		backoffUntil:      make(map[string]time.Time),
		backoffDuration:   make(map[string]time.Duration),
		rateLimitCount:    make(map[string]int),
		windowDuration:    60 * time.Second,
		maxRequests:       200, // Higher limit for non-NVIDIA providers
		minBackoff:        5 * time.Second,
		maxBackoff:        120 * time.Second,
		backoffFactor:     2.0,
		gpuThrottlePct:    90.0,
	}
}

// CanRequest returns true if the provider can accept a request right now.
func (r *PerProviderRateLimiter) CanRequest(provider string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()

	// Check active backoff
	if until, ok := r.backoffUntil[provider]; ok {
		if now.Before(until) {
			return false
		}
		// backoff expired naturally — keep backoffDuration
		// so exponential growth persists across consecutive 429s
		delete(r.backoffUntil, provider)
	}

	// Prune old timestamps
	cutoff := now.Add(-r.windowDuration)
	if timestamps, ok := r.requestTimestamps[provider]; ok {
		pruned := timestamps[:0]
		for _, t := range timestamps {
			if t.After(cutoff) {
				pruned = append(pruned, t)
			}
		}
		r.requestTimestamps[provider] = pruned
	}

	// Check if within limit
	count := len(r.requestTimestamps[provider])
	if count >= r.maxRequests {
		return false
	}

	// Check GPU memory pressure for NVIDIA NIM
	if provider == "nvidia" {
		if now.Sub(r.lastGpuCheck) > 10*time.Second {
			r.checkGpuMemory()
		}
		if r.gpuTotalMB > 0 {
			freePct := float64(r.gpuFreeMB) / float64(r.gpuTotalMB) * 100.0
			if freePct < (100.0 - r.gpuThrottlePct) {
				return false
			}
		}
	}

	return true
}

// RecordRequest records that a request was made to the given provider.
func (r *PerProviderRateLimiter) RecordRequest(provider string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requestTimestamps[provider] = append(r.requestTimestamps[provider], time.Now())
}

// Record429 records a 429 with optional retry-after duration.
func (r *PerProviderRateLimiter) Record429(provider string, retryAfterDur time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.rateLimitCount[provider]++

	var backoff time.Duration
	if retryAfterDur > 0 {
		backoff = retryAfterDur
		if backoff < r.minBackoff {
			backoff = r.minBackoff
		}
		// Don't reset backoffDuration to minBackoff — preserve
		// the existing exponential backoff state
		if r.backoffDuration[provider] <= 0 {
			r.backoffDuration[provider] = r.minBackoff
		}
	} else {
		existing := r.backoffDuration[provider]
		if existing <= 0 {
			existing = r.minBackoff
		}
		backoff = time.Duration(float64(existing) * r.backoffFactor)
		if backoff > r.maxBackoff {
			backoff = r.maxBackoff
		}
		r.backoffDuration[provider] = backoff
	}

	// Add full jitter (AWS/GCF best practice) to prevent thundering herd
	// sleep = random(0, backoff) — spreads retries across the window
	jitter := time.Duration(rand.Int63n(int64(backoff)))
	r.backoffUntil[provider] = time.Now().Add(jitter)
}

// RecordSuccess resets backoff for a provider after a successful request.
func (r *PerProviderRateLimiter) RecordSuccess(provider string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.backoffUntil, provider)
	delete(r.backoffDuration, provider)
	r.rateLimitCount[provider] = 0
}

// checkGpuMemory runs nvidia-smi to get current VRAM stats.
func (r *PerProviderRateLimiter) checkGpuMemory() {
	r.lastGpuCheck = time.Now()
	cmd := exec.Command("nvidia-smi",
		"--query-gpu=memory.free,memory.total",
		"--format=csv,noheader,nounits",
	)
	out, err := cmd.Output()
	if err != nil {
		return
	}
	line := strings.TrimSpace(string(out))
	parts := strings.Split(line, ", ")
	if len(parts) < 2 {
		return
	}
	free, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	total, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 == nil && err2 == nil && total > 0 {
		r.gpuFreeMB = free
		r.gpuTotalMB = total
	}
}

// GetBackoffRemaining returns remaining backoff duration for a provider.
func (r *PerProviderRateLimiter) GetBackoffRemaining(provider string) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if until, ok := r.backoffUntil[provider]; ok {
		remaining := time.Until(until)
		if remaining > 0 {
			return remaining
		}
	}
	return 0
}

// GetGPUFreeMB returns last known free GPU memory in MB.
func (r *PerProviderRateLimiter) GetGPUFreeMB() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.gpuFreeMB
}

// parseRetryAfter parses Retry-After: seconds ("60") or HTTP-date format.
func parseRetryAfter(val string) time.Duration {
	if val == "" {
		return 0
	}
	seconds, err := strconv.Atoi(strings.TrimSpace(val))
	if err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	t, err := time.Parse(time.RFC1123, val)
	if err != nil {
		t, err = time.Parse(httpDateFormat, val)
		if err != nil {
			return 0
		}
	}
	dur := time.Until(t)
	if dur > 0 {
		return dur
	}
	return 0
}

const httpDateFormat = "02 Jan 2006 15:04:05 GMT"

// parseRateLimitReset parses X-RateLimit-Reset: epoch seconds or ms.
func parseRateLimitReset(val string) time.Duration {
	if val == "" {
		return 0
	}
	ts, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64)
	if err != nil {
		return 0
	}
	var t time.Time
	if ts > 1e12 {
		t = time.UnixMilli(ts)
	} else {
		t = time.Unix(ts, 0)
	}
	dur := time.Until(t)
	if dur > 0 {
		return dur
	}
	return 0
}
