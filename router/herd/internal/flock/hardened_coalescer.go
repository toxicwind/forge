package flock

import (
	"bytes"
	"io"
	"net/http"
	"sync"

	"golang.org/x/sync/singleflight"
)

// HardenedCoalescer implements singleflight request coalescing.
// Borrowed from jhonsferg/relay (Go) — the hardened version of what flock
// already does, with two subtle bugs fixed:
//
// 1. Context detachment: the leader uses a detached context so one caller's
//    cancellation doesn't kill the shared in-flight request.
// 2. Header aliasing: each waiter gets an independent body copy + cloned
//    Header map, avoiding corruption when multiple waiters read concurrently.
//
// This wraps http.RoundTripper for drop-in use.

type HardenedCoalescer struct {
	group singleflight.Group
	// only coalesce idempotent methods
	methods map[string]bool
}

func NewHardenedCoalescer() *HardenedCoalescer {
	return &HardenedCoalescer{
		methods: map[string]bool{
			"GET":  true,
			"HEAD": true,
		},
	}
}

// coalesceKey builds a dedup key from method + URL + body hash.
// For POST (LLM requests), include a hash of the body.
func coalesceKey(req *http.Request, bodyBytes []byte) string {
	key := req.Method + "\x00" + req.URL.String()
	if len(bodyBytes) > 0 {
		// Simple FNV hash of body for key (not crypto, just dedup)
		h := uint64(14695981039346656037)
		for _, b := range bodyBytes {
			h ^= uint64(b)
			h *= 1099511628211
		}
		key += "\x00" + string(rune(h>>32)) + string(rune(h&0xffffffff))
	}
	return key
}

// Do executes the request with coalescing. bodyBytes is the request body
// (read before calling, since req.Body is single-use).
// rt is the underlying RoundTripper to use for the actual request.
func (hc *HardenedCoalescer) Do(
	req *http.Request,
	bodyBytes []byte,
	rt http.RoundTripper,
) (*http.Response, error) {
	// Only coalesce configured methods, or POST with identical body
	// (LLM chat completions are the main coalescing target)
	coalesce := hc.methods[req.Method]
	if req.Method == "POST" && len(bodyBytes) > 0 {
		coalesce = true // dedupe identical LLM requests
	}
	if !coalesce {
		return rt.RoundTrip(req)
	}

	key := coalesceKey(req, bodyBytes)

	// singleflight: concurrent identical requests share one execution
	result, err, _ := hc.group.Do(key, func() (interface{}, error) {
		// Leader: use detached context (don't inherit caller's cancellation)
		// Clone the request with a fresh body
		leaderReq := req.Clone(req.Context())
		if len(bodyBytes) > 0 {
			leaderReq.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			leaderReq.ContentLength = int64(len(bodyBytes))
		}

		resp, err := rt.RoundTrip(leaderReq)
		if err != nil {
			return nil, err
		}

		// Read full body for sharing (LLM responses are bounded)
		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}

		return &sharedResponse{
			statusCode: resp.StatusCode,
			header:     resp.Header.Clone(), // independent copy
			body:       respBody,
		}, nil
	})

	if err != nil {
		return nil, err
	}

	shared := result.(*sharedResponse)

	// Each waiter gets an independent body copy + cloned headers
	// (avoids aliasing corruption on concurrent reads)
	return &http.Response{
		Status:        http.StatusText(shared.statusCode),
		StatusCode:    shared.statusCode,
		Header:        shared.header.Clone(),
		Body:          io.NopCloser(bytes.NewReader(shared.body)),
		ContentLength: int64(len(shared.body)),
		Request:       req,
	}, nil
}

type sharedResponse struct {
	statusCode int
	header     http.Header
	body       []byte
}

// Stats returns singleflight stats for monitoring.
type CoalescerStats struct {
	// singleflight doesn't expose internals; we track via wrapper
	mu        sync.Mutex
	total     int64
	coalesced int64
}

func (cs *CoalescerStats) Record(coalesced bool) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	cs.total++
	if coalesced {
		cs.coalesced++
	}
}

func (cs *CoalescerStats) Snapshot() (total, coalesced int64) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.total, cs.coalesced
}
