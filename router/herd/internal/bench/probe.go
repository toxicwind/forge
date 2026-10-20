// Package bench: probe.go — model liveness probing with full-grade
// latency tracking. Uses a shared *http.Client with connection pooling
// (matches internal/flock/router.go and internal/shared/http.go
// conventions) instead of allocating a new client per request.
package bench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Model is a single model returned by the herd /v1/models endpoint.
type Model struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	OwnedBy string `json:"owned_by"`
	Name    string `json:"name"`
}

// ModelsResponse mirrors the OpenAI-compatible /v1/models payload.
type ModelsResponse struct {
	Data []Model `json:"data"`
}

// sharedClient returns a *http.Client tuned for short, parallel probes
// against a single herd instance. The Transport is the same shape used
// by internal/flock/router.go so the herd proxy is exercised the
// same way end-to-end.
func sharedClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     30 * time.Second,
			DisableCompression:  true,
		},
	}
}

// Discover fetches all models from the herd /v1/models endpoint.
// Returns the model IDs sorted lexicographically.
func Discover(ctx context.Context, baseURL string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		return nil, fmt.Errorf("discover: build request: %w", err)
	}
	client := sharedClient(10 * time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("discover: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discover: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("discover: read body: %w", err)
	}
	var mr ModelsResponse
	if err := json.Unmarshal(body, &mr); err != nil {
		return nil, fmt.Errorf("discover: parse: %w", err)
	}
	ids := make([]string, 0, len(mr.Data))
	for _, m := range mr.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// ProbeOptions configures a Probe run.
type ProbeOptions struct {
	BaseURL        string
	Model          string
	TimeoutSeconds int
	// Client is optional; when nil, a shared pooled client is used.
	Client *http.Client
}

// Probe sends a single chat-completion request to classify model liveness.
// 200 → alive; 402/410/404/503 → dead; timeout → timeout; else error.
func Probe(ctx context.Context, opts ProbeOptions) ProbeResult {
	timeout := time.Duration(opts.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	pctx, cancel := context.WithTimeoutCause(ctx, timeout,
		fmt.Errorf("probe %q deadline %s", opts.Model, timeout))
	defer cancel()

	payload, _ := json.Marshal(map[string]any{
		"model": opts.Model,
		"messages": []map[string]string{
			{"role": "user", "content": "hi"},
		},
		"max_tokens": 1,
	})

	req, err := http.NewRequestWithContext(pctx, http.MethodPost,
		opts.BaseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return ProbeResult{Model: opts.Model, Status: StatusError, Detail: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")

	client := opts.Client
	if client == nil {
		client = sharedClient(timeout)
	}

	start := time.Now()
	resp, err := client.Do(req)
	elapsed := time.Since(start)

	if err != nil {
		// Distinguish timeout from generic network error using errors.Is
		// — the cause attached via WithTimeoutCause is unwrapped here so
		// the error message stays useful.
		if errors.Is(pctx.Err(), context.DeadlineExceeded) {
			return ProbeResult{
				Model: opts.Model, Status: StatusTimeout,
				LatencyMs: elapsed.Milliseconds(),
				Detail:    "deadline_exceeded",
			}
		}
		return ProbeResult{
			Model: opts.Model, Status: StatusError,
			LatencyMs: elapsed.Milliseconds(),
			Detail:    err.Error(),
		}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	return ProbeResult{
		Model:      opts.Model,
		Status:     classifyHTTP(resp.StatusCode),
		HTTPStatus: resp.StatusCode,
		LatencyMs:  elapsed.Milliseconds(),
		Detail:     fmt.Sprintf("http=%d elapsed=%s", resp.StatusCode, elapsed.Round(time.Millisecond)),
	}
}

// classifyHTTP maps HTTP status codes to a probe classification.
// 200 → alive; 402/410/404/503 → dead; everything else → error.
func classifyHTTP(code int) ProbeStatus {
	switch {
	case code == http.StatusOK:
		return StatusAlive
	case code == http.StatusPaymentRequired,
		code == http.StatusGone,
		code == http.StatusNotFound,
		code == http.StatusServiceUnavailable:
		return StatusDead
	default:
		return StatusError
	}
}

// ProbeAll runs probes in parallel for every model ID, using up to
// maxConcurrency workers. Returns a slice of results in input order.
// A single shared *http.Client is reused across all goroutines so
// connection pooling actually pays off.
func ProbeAll(ctx context.Context, baseURL string, models []string, maxConcurrency, timeoutSec int) []ProbeResult {
	if maxConcurrency <= 0 {
		maxConcurrency = 8
	}
	if timeoutSec <= 0 {
		timeoutSec = 15
	}
	timeout := time.Duration(timeoutSec) * time.Second
	client := sharedClient(timeout)
	results := make([]ProbeResult, len(models))
	sem := make(chan struct{}, maxConcurrency)
	var wg sync.WaitGroup
	for i, m := range models {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, m string) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = Probe(ctx, ProbeOptions{
				BaseURL:        baseURL,
				Model:          m,
				TimeoutSeconds: timeoutSec,
				Client:         client,
			})
		}(i, m)
	}
	wg.Wait()
	return results
}

// Classify partitions probe results into working and dead sets.
// "working" = alive; "dead" = dead OR server-error HTTP codes (500/401/403).
func Classify(results []ProbeResult) (working, dead []string) {
	for _, r := range results {
		switch r.Status {
		case StatusAlive:
			working = append(working, r.Model)
		case StatusDead:
			dead = append(dead, r.Model)
		default:
			if r.HTTPStatus >= 500 || r.HTTPStatus == 401 || r.HTTPStatus == 403 {
				dead = append(dead, r.Model)
			}
		}
	}
	sort.Strings(working)
	sort.Strings(dead)
	return working, dead
}

// LatencyStats is a small distribution summary over a set of
// non-zero latency samples. All fields are in milliseconds.
// Computed in O(n log n) via sort; no third-party histogram dep.
type LatencyStats struct {
	Count int     `json:"count"`
	Min   int64   `json:"min_ms"`
	Max   int64   `json:"max_ms"`
	Mean  float64 `json:"mean_ms"`
	P50   int64   `json:"p50_ms"`
	P95   int64   `json:"p95_ms"`
	P99   int64   `json:"p99_ms"`
}

// Latency computes distribution stats from a slice of millisecond
// samples. Empty input returns the zero value.
func Latency(samples []int64) LatencyStats {
	if len(samples) == 0 {
		return LatencyStats{}
	}
	sorted := append([]int64(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	var sum int64
	for _, v := range sorted {
		sum += v
	}
	pick := func(p float64) int64 {
		if len(sorted) == 0 {
			return 0
		}
		idx := int(math.Ceil(p*float64(len(sorted)))) - 1
		if idx < 0 {
			idx = 0
		}
		if idx >= len(sorted) {
			idx = len(sorted) - 1
		}
		return sorted[idx]
	}
	return LatencyStats{
		Count: len(sorted),
		Min:   sorted[0],
		Max:   sorted[len(sorted)-1],
		Mean:  float64(sum) / float64(len(sorted)),
		P50:   pick(0.50),
		P95:   pick(0.95),
		P99:   pick(0.99),
	}
}

// ProbeLatencySummaries returns per-status latency distributions over a
// set of probe results. Useful for "alive models have p95 < 200ms" gates.
func ProbeLatencySummaries(results []ProbeResult) map[ProbeStatus]LatencyStats {
	out := map[ProbeStatus]LatencyStats{
		StatusAlive:   {},
		StatusDead:    {},
		StatusTimeout: {},
		StatusError:   {},
	}
	buckets := map[ProbeStatus][]int64{
		StatusAlive:   {},
		StatusDead:    {},
		StatusTimeout: {},
		StatusError:   {},
	}
	for _, r := range results {
		if r.LatencyMs <= 0 {
			continue
		}
		buckets[r.Status] = append(buckets[r.Status], r.LatencyMs)
	}
	for k, v := range buckets {
		out[k] = Latency(v)
	}
	return out
}
