package router

// Failing-first tests for the event-driven per-peer health state machine.
// They cover: taxonomy classification, weighted ejection, fail-fast while open,
// single-flight half-open probes, recovery/readmission, stale-outcome safety,
// EWMA scoring, degraded signals, concurrency, and end-to-end behavior through
// Peer.ServeHTTP against scripted backends.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mostlygeek/herd/internal/config"
	"github.com/mostlygeek/herd/internal/shared"
)

func testHealthConfig() config.HealthConfig {
	return config.HealthConfig{
		EWMAAlpha:         0.5,
		FailureThreshold:  4,
		RecoveryCredit:    1,
		SuccessThreshold:  1,
		CoolOffSeconds:    3600,
		DegradedLatencyMs: 1e9,
		DegradedErrorRate: 1.0,
		Weights: map[string]float64{
			"transport":        2.0,
			"5xx":              1.5,
			"404-dead-id":      3.0,
			"402-not-entitled": 2.0,
			"403-refused":      1.0,
			"429-throttled":    0.5,
			"200-empty":        1.5,
		},
	}
}

func TestClassifyOutcome(t *testing.T) {
	okBody := []byte(`{"choices":[{"message":{"content":"hello"}}]}`)
	emptyChoices := []byte(`{"choices":[]}`)
	cases := []struct {
		name         string
		status       int
		path         string
		body         []byte
		streamed     bool
		dataPayloads int
		completed    bool
		clientGone   bool
		want         OutcomeClass
	}{
		{"success", 200, "/v1/chat/completions", okBody, false, 0, true, false, OutcomeSuccess},
		{"empty body", 200, "/v1/chat/completions", []byte("  \n "), false, 0, true, false, OutcomeEmpty200},
		{"empty choices", 200, "/v1/chat/completions", emptyChoices, false, 0, true, false, OutcomeEmpty200},
		{"non-empty choices untouched", 200, "/v1/chat/completions", okBody, false, 0, true, false, OutcomeSuccess},
		{"stream with payloads", 200, "/v1/chat/completions", nil, true, 3, true, false, OutcomeSuccess},
		{"stream no payloads", 200, "/v1/chat/completions", nil, true, 0, true, false, OutcomeEmpty200},
		{"throttled", 429, "/v1/chat/completions", nil, false, 0, true, false, OutcomeThrottled},
		{"not entitled", 402, "/v1/chat/completions", nil, false, 0, true, false, OutcomeNotEntitled},
		{"dead id", 404, "/v1/chat/completions", nil, false, 0, true, false, OutcomeDeadID},
		{"refused", 403, "/v1/chat/completions", nil, false, 0, true, false, OutcomeRefused},
		{"other 4xx refused", 401, "/v1/chat/completions", nil, false, 0, true, false, OutcomeRefused},
		{"server error", 500, "/v1/chat/completions", nil, false, 0, true, false, OutcomeServerError},
		{"server error 503", 503, "/v1/chat/completions", nil, false, 0, true, false, OutcomeServerError},
		{"transport incomplete", 200, "/v1/chat/completions", okBody, false, 0, false, false, OutcomeTransport},
		{"transport no response", 0, "/v1/chat/completions", nil, false, 0, false, false, OutcomeTransport},
		{"client gone neutral", 200, "/v1/chat/completions", okBody, false, 0, false, true, OutcomeCancelled},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyOutcome(tc.status, tc.path, tc.body, tc.streamed, tc.dataPayloads, tc.completed, tc.clientGone)
			if got != tc.want {
				t.Fatalf("ClassifyOutcome() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCircuitOpensOnWeightedFailures(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	// transport weight 2.0, threshold 4 -> two transport failures trip the circuit.
	h.Report(OutcomeTransport, 10*time.Millisecond, "t1")
	if h.State() != HealthHealthy {
		t.Fatalf("state after 1 transport = %s, want healthy", h.State())
	}
	h.Report(OutcomeTransport, 10*time.Millisecond, "t2")
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state after 2 transports = %s, want circuit-open", h.State())
	}
}

func TestTaxonomyWeightsAreDistinct(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeNotEntitled, time.Millisecond, "")
	h.Report(OutcomeDeadID, time.Millisecond, "")
	h.Report(OutcomeThrottled, time.Millisecond, "")
	// 2.0 + 3.0 + 0.5 = 5.5 >= 4 -> open, and the score must equal the
	// class-distinct weights, not a flat per-failure count.
	snap := h.Snapshot()
	if snap.FailureScore != 5.5 {
		t.Fatalf("failure score = %.1f, want 5.5 (distinct class weights)", snap.FailureScore)
	}
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open", h.State())
	}
}

func TestOpenFailsFast(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	if h.State() != HealthCircuitOpen {
		t.Fatal("precondition: circuit should be open")
	}
	for i := 0; i < 5; i++ {
		if admit, _, _ := h.Admit(); admit {
			t.Fatalf("Admit() = true while circuit open (attempt %d)", i)
		}
	}
	if h.RetryAfter() <= 0 {
		t.Fatal("RetryAfter should be positive while open with 3600s cool-off")
	}
}

func TestHalfOpenSingleFlight(t *testing.T) {
	cfg := testHealthConfig()
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)

	const n = 16
	var probes int32
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if admit, probe, _ := h.Admit(); admit && probe {
				atomic.AddInt32(&probes, 1)
			}
		}()
	}
	wg.Wait()
	if probes != 1 {
		t.Fatalf("probes admitted = %d, want exactly 1 (single-flight)", probes)
	}
	if h.State() != HealthHalfOpen {
		t.Fatalf("state = %s, want half-open", h.State())
	}
}

func TestHalfOpenSuccessReadmits(t *testing.T) {
	cfg := testHealthConfig()
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)

	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected the half-open probe to be admitted")
	}
	h.reportOutcome(OutcomeSuccess, 20*time.Millisecond, "probe ok", true, gen)
	if h.State() != HealthHealthy {
		t.Fatalf("state after successful probe = %s, want healthy", h.State())
	}
	if admit, _, _ := h.Admit(); !admit {
		t.Fatal("peer should admit traffic after readmission")
	}
}

func TestHalfOpenFailureReopens(t *testing.T) {
	cfg := testHealthConfig()
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)

	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected the half-open probe to be admitted")
	}
	h.reportOutcome(OutcomeServerError, 20*time.Millisecond, "probe failed", true, gen)
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state after failed probe = %s, want circuit-open", h.State())
	}
	// Cool-off restarts: with 3600s configured here the next admit must deny.
	cfg2 := testHealthConfig()
	h2 := NewPeerHealth("p2", cfg2, testLogger)
	h2.Report(OutcomeTransport, time.Millisecond, "")
	h2.Report(OutcomeTransport, time.Millisecond, "")
	if admit, _, _ := h2.Admit(); admit {
		t.Fatal("freshly re-opened circuit must deny before cool-off")
	}
}

func TestRecoveryResetsFailureSlate(t *testing.T) {
	cfg := testHealthConfig()
	h := NewPeerHealth("p1", cfg, testLogger)
	// Eject: 2x transport at weight 2.0 reaches the threshold of 4.
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open", h.State())
	}
	expireCoolOff(h)
	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected the half-open probe to be admitted")
	}
	h.reportOutcome(OutcomeSuccess, 20*time.Millisecond, "probe ok", true, gen)
	if h.State() != HealthHealthy {
		t.Fatalf("state after successful probe = %s, want healthy", h.State())
	}
	// A recovered peer rejoins with a clean slate: a single further
	// transport failure (weight 2.0) must not re-eject it on its own.
	if sc := h.Snapshot().FailureScore; sc != 0 {
		t.Fatalf("score after recovery = %.1f, want 0 (clean slate)", sc)
	}
	h.Report(OutcomeTransport, time.Millisecond, "")
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy (one failure must not re-eject a recovered peer)", h.State())
	}
	// But the full threshold of fresh evidence still ejects.
	h.Report(OutcomeTransport, time.Millisecond, "")
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open (fresh threshold re-ejects)", h.State())
	}
}

func TestStaleSuccessDoesNotCloseOpenCircuit(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	// A slow in-flight request from before the trip reports success late.
	h.Report(OutcomeSuccess, 500*time.Millisecond, "stale")
	if h.State() != HealthCircuitOpen {
		t.Fatalf("stale success moved state to %s, want circuit-open", h.State())
	}
}

func TestCancelledProbeReopensWithoutWedging(t *testing.T) {
	cfg := testHealthConfig()
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)
	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected probe admission")
	}
	h.reportOutcome(OutcomeCancelled, 5*time.Millisecond, "client went away", true, gen)
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open after cancelled probe", h.State())
	}
	// The next real request after cool-off must be able to probe again.
	expireCoolOff(h)
	if admit, probe, _ := h.Admit(); !admit || !probe {
		t.Fatal("expected a fresh probe after cancelled probe")
	}
}

func TestCancelledIsNeutral(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	before := h.Snapshot().FailureScore
	h.Report(OutcomeCancelled, time.Millisecond, "")
	after := h.Snapshot().FailureScore
	if before != after {
		t.Fatalf("cancelled changed score %.1f -> %.1f, want neutral", before, after)
	}
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy", h.State())
	}
}

func TestRecoveryCreditBleedsScore(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "") // +2
	h.Report(OutcomeSuccess, time.Millisecond, "")   // -1 -> 1
	h.Report(OutcomeTransport, time.Millisecond, "") // +2 -> 3 < 4
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy (score bled by success)", h.State())
	}
	if s := h.Snapshot().FailureScore; s != 3 {
		t.Fatalf("score = %.1f, want 3", s)
	}
}

func TestSuccessThresholdMultipleProbes(t *testing.T) {
	cfg := testHealthConfig()
	cfg.SuccessThreshold = 2
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)

	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected first probe")
	}
	h.reportOutcome(OutcomeSuccess, 10*time.Millisecond, "probe 1", true, gen)
	if h.State() != HealthHalfOpen {
		t.Fatalf("state after 1/2 probes = %s, want half-open", h.State())
	}
	admit, probe, gen = h.Admit()
	if !admit || !probe {
		t.Fatal("expected second probe")
	}
	h.reportOutcome(OutcomeSuccess, 10*time.Millisecond, "probe 2", true, gen)
	if h.State() != HealthHealthy {
		t.Fatalf("state after 2/2 probes = %s, want healthy", h.State())
	}
}

func TestEWMA(t *testing.T) {
	cfg := testHealthConfig()
	cfg.EWMAAlpha = 0.5
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeSuccess, 100*time.Millisecond, "")
	if got := h.Snapshot().EWMALatencyMs; got != 100 {
		t.Fatalf("ewma after first sample = %.1f, want 100", got)
	}
	h.Report(OutcomeSuccess, 300*time.Millisecond, "")
	// 0.5*300 + 0.5*100 = 200
	if got := h.Snapshot().EWMALatencyMs; got != 200 {
		t.Fatalf("ewma after second sample = %.1f, want 200", got)
	}
	h.Report(OutcomeSuccess, 200*time.Millisecond, "")
	// 0.5*200 + 0.5*200 = 200
	if got := h.Snapshot().EWMALatencyMs; got != 200 {
		t.Fatalf("ewma after third sample = %.1f, want 200", got)
	}
}

func TestDegradedOnLatencyAndRecovery(t *testing.T) {
	cfg := testHealthConfig()
	cfg.EWMAAlpha = 1.0 // ewma tracks the latest sample exactly
	cfg.DegradedLatencyMs = 100
	h := NewPeerHealth("p1", cfg, testLogger)
	h.Report(OutcomeSuccess, 250*time.Millisecond, "")
	if h.State() != HealthDegraded {
		t.Fatalf("state = %s, want degraded (ewma 250ms >= 100ms)", h.State())
	}
	// Degraded still admits traffic.
	if admit, _, _ := h.Admit(); !admit {
		t.Fatal("degraded peer must still admit traffic")
	}
	h.Report(OutcomeSuccess, 10*time.Millisecond, "")
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy after latency recovered", h.State())
	}
}

func TestDegradedOnErrorRate(t *testing.T) {
	cfg := testHealthConfig()
	cfg.DegradedErrorRate = 0.5
	h := NewPeerHealth("p1", cfg, testLogger)
	// 8 samples minimum, half failing -> error rate 0.5.
	for i := 0; i < 4; i++ {
		h.Report(OutcomeSuccess, time.Millisecond, "")
	}
	for i := 0; i < 4; i++ {
		h.Report(OutcomeThrottled, time.Millisecond, "")
	}
	if h.State() != HealthDegraded {
		t.Fatalf("state = %s, want degraded (error rate 0.5)", h.State())
	}
	for i := 0; i < 8; i++ {
		h.Report(OutcomeSuccess, time.Millisecond, "")
	}
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy after errors drained", h.State())
	}
}

func TestConcurrentReportsAreSafe(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				h.Admit()
				if (i+j)%3 == 0 {
					h.Report(OutcomeTransport, time.Millisecond, "")
				} else {
					h.Report(OutcomeSuccess, time.Millisecond, "")
				}
				h.Snapshot()
			}
		}(i)
	}
	wg.Wait()
	// No assertion on final state — race detector is the assertion.
}

func TestHealthConfigDefaults(t *testing.T) {
	var hc config.HealthConfig
	hc.ApplyDefaults()
	if hc.Enabled == nil || !*hc.Enabled {
		t.Fatal("health should default to enabled")
	}
	if hc.FailureThreshold <= 0 || hc.CoolOffSeconds <= 0 || hc.SuccessThreshold <= 0 {
		t.Fatal("threshold defaults must be positive")
	}
	if hc.EWMAAlpha <= 0 || hc.EWMAAlpha > 1 {
		t.Fatal("ewma alpha must be in (0,1]")
	}
	for _, class := range []string{"transport", "5xx", "404-dead-id", "402-not-entitled", "403-refused", "429-throttled", "200-empty"} {
		if hc.WeightFor(class) <= 0 {
			t.Fatalf("default weight for %s must be positive", class)
		}
	}
	if hc.WeightFor("success") != 0 || hc.WeightFor("cancelled") != 0 {
		t.Fatal("success/cancelled weights must be zero")
	}
	// Explicit opt-out is honored.
	off := false
	hc2 := config.HealthConfig{Enabled: &off}
	hc2.ApplyDefaults()
	if *hc2.Enabled {
		t.Fatal("enabled:false must be honored")
	}
}

// ---------------------------------------------------------------------------
// End-to-end through Peer.ServeHTTP against scripted backends.
// ---------------------------------------------------------------------------

func newTestPeer(t *testing.T, backendURL string, hc config.HealthConfig) *Peer {
	t.Helper()
	proxyURL, _ := url.Parse(backendURL)
	pr, err := NewPeer(config.Config{Peers: config.PeerDictionaryConfig{
		"test-peer": {
			Proxy:    backendURL,
			ProxyURL: proxyURL,
			Models:   []string{"test-model"},
			Health:   hc,
		},
	}}, testLogger)
	if err != nil {
		t.Fatal(err)
	}
	return pr
}

func chatRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	*req = *req.WithContext(shared.SetContext(req.Context(), shared.ReqContextData{Model: "test-model", ModelID: "test-model"}))
	return req
}

func TestPeerIntegration_EjectAndReadmit(t *testing.T) {
	var calls int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n <= 2 {
			http.Error(w, `{"error":"boom"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"recovered"}}]}`))
	}))
	defer backend.Close()

	hc := testHealthConfig()
	hc.FailureThreshold = 3
	pr := newTestPeer(t, backend.URL, hc)

	doReq := func() int {
		w := httptest.NewRecorder()
		pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
		return w.Code
	}

	if code := doReq(); code != 500 {
		t.Fatalf("req1 = %d, want 500", code)
	}
	if code := doReq(); code != 500 {
		t.Fatalf("req2 = %d, want 500", code)
	}
	// Two 5xx (1.5 each) hit the threshold of 3 -> ejected. Expire the
	// cool-off deterministically; req3 is admitted as the half-open probe
	// and the recovered backend returns 200 -> readmitted.
	expireCoolOff(pr.health["test-peer"])
	if code := doReq(); code != 200 {
		t.Fatalf("req3 (probe) = %d, want 200", code)
	}
	snaps := pr.HealthSnapshots()
	if len(snaps) != 1 {
		t.Fatalf("snapshots = %d, want 1", len(snaps))
	}
	if snaps[0].State != HealthHealthy {
		t.Fatalf("final state = %s, want healthy", snaps[0].State)
	}
	if snaps[0].Transitions < 3 {
		t.Fatalf("transitions = %d, want >= 3 (healthy->open->half-open->healthy)", snaps[0].Transitions)
	}
}

func TestPeerIntegration_FailFast503WhileOpen(t *testing.T) {
	var calls int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer backend.Close()

	hc := testHealthConfig()
	hc.CoolOffSeconds = 3600
	hc.FailureThreshold = 3
	pr := newTestPeer(t, backend.URL, hc)

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
		if w.Code != 502 {
			t.Fatalf("req%d = %d, want 502", i+1, w.Code)
		}
	}
	// Circuit is open now: the next request must fail fast without touching
	// the backend.
	w := httptest.NewRecorder()
	pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("fail-fast = %d, want 503", w.Code)
	}
	if body := w.Body.String(); !strings.Contains(body, "peer_circuit_open") {
		t.Fatalf("fail-fast body missing peer_circuit_open: %s", body)
	}
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("backend calls = %d, want 2 (no traffic while open)", n)
	}
}

func TestPeerIntegration_Empty200Ejects(t *testing.T) {
	var calls int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[]}`)) // honest 200, empty completion
	}))
	defer backend.Close()

	hc := testHealthConfig()
	hc.CoolOffSeconds = 3600
	hc.FailureThreshold = 3 // 200-empty weight 1.5 -> two empties eject
	pr := newTestPeer(t, backend.URL, hc)

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
		if w.Code != 200 {
			t.Fatalf("req%d = %d, want 200 (empty body still proxied)", i+1, w.Code)
		}
	}
	// Ejected now: the third request fails fast without touching the backend.
	w := httptest.NewRecorder()
	pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("req3 = %d, want 503 fail-fast", w.Code)
	}
	if n := atomic.LoadInt32(&calls); n != 2 {
		t.Fatalf("backend calls = %d, want 2 (no traffic while open)", n)
	}
	snaps := pr.HealthSnapshots()
	if snaps[0].State != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open after repeated 200-empty", snaps[0].State)
	}
}

func TestPeerIntegration_TransportFailureEjects(t *testing.T) {
	// Backend that accepts then dies: use an unroutable address for a hard
	// transport failure.
	pr := newTestPeer(t, "http://127.0.0.1:1/", testHealthConfig())

	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
		if w.Code != 502 {
			t.Fatalf("req%d = %d, want 502", i+1, w.Code)
		}
	}
	snaps := pr.HealthSnapshots()
	if snaps[0].State != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open after transport failures", snaps[0].State)
	}
	// Fail fast now.
	w := httptest.NewRecorder()
	pr.ServeHTTP(w, chatRequest(t, `{"model":"test-model"}`))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("fail-fast = %d, want 503", w.Code)
	}
}

func TestStaleSuccessDuringHalfOpenIsNotAProbe(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)
	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected the half-open probe to be admitted")
	}
	// A slow pre-trip request reports success late, while the probe is in
	// flight. It carries no probe identity: it must not count toward
	// readmission.
	h.reportOutcome(OutcomeSuccess, 500*time.Millisecond, "stale", false, gen-1)
	if h.State() != HealthHalfOpen {
		t.Fatalf("state = %s, want half-open (stale success must not readmit)", h.State())
	}
	// The real probe still decides.
	h.reportOutcome(OutcomeSuccess, 20*time.Millisecond, "probe ok", true, gen)
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy after the real probe", h.State())
	}
}

func TestStaleFailureDuringHalfOpenIsTelemetryOnly(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)
	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected the half-open probe to be admitted")
	}
	before := h.Snapshot().FailureScore
	// A stale failure from a pre-trip request lands while the probe is in
	// flight. Its evidence was already priced into the trip: telemetry only,
	// no score movement, probe slot untouched.
	h.reportOutcome(OutcomeTransport, time.Millisecond, "stale", false, gen-1)
	if got := h.Snapshot().FailureScore; got != before {
		t.Fatalf("stale failure moved score %.1f -> %.1f during half-open, want telemetry-only", before, got)
	}
	if h.State() != HealthHalfOpen {
		t.Fatalf("state = %s, want half-open", h.State())
	}
	if !h.Snapshot().HalfOpenProbe {
		t.Fatal("stale failure must not clear the in-flight probe slot")
	}
	// The real probe still decides: failure re-opens.
	h.reportOutcome(OutcomeServerError, 20*time.Millisecond, "probe failed", true, gen)
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open after the real probe failed", h.State())
	}
}

func TestOldGenerationProbeOutcomeIgnored(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)
	admit, _, gen1 := h.Admit()
	if !admit {
		t.Fatal("expected probe P1 to be admitted")
	}
	// P1's client disconnects; circuit re-opens and the slot is retired.
	h.reportOutcome(OutcomeCancelled, 5*time.Millisecond, "p1 gone", true, gen1)
	if h.State() != HealthCircuitOpen {
		t.Fatalf("state = %s, want circuit-open after cancelled P1", h.State())
	}
	expireCoolOff(h)
	admit, probe, gen2 := h.Admit()
	if !admit || !probe {
		t.Fatal("expected probe P2 to be admitted")
	}
	if gen2 == gen1 {
		t.Fatal("generation must advance across the re-open")
	}
	// P1's transport finally reports failure with its stale generation.
	// Wrong generation: telemetry only, must not disturb P2's probe.
	h.reportOutcome(OutcomeTransport, 900*time.Millisecond, "p1 late", true, gen1)
	if h.State() != HealthHalfOpen {
		t.Fatalf("state = %s, want half-open (P2 still in flight)", h.State())
	}
	// P2 succeeds: readmitted on the real probe's outcome.
	h.reportOutcome(OutcomeSuccess, 20*time.Millisecond, "p2 ok", true, gen2)
	if h.State() != HealthHealthy {
		t.Fatalf("state = %s, want healthy after P2", h.State())
	}
}

func TestReopenRetiresProbeSlot(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	h.Report(OutcomeTransport, time.Millisecond, "")
	h.Report(OutcomeTransport, time.Millisecond, "")
	expireCoolOff(h)
	admit, probe, gen := h.Admit()
	if !admit || !probe {
		t.Fatal("expected the half-open probe to be admitted")
	}
	if !h.Snapshot().HalfOpenProbe {
		t.Fatal("want probe marked in flight")
	}
	h.reportOutcome(OutcomeServerError, 20*time.Millisecond, "probe failed", true, gen)
	if h.Snapshot().HalfOpenProbe {
		t.Fatal("re-open must retire the probe slot")
	}
	// No wedge: after cool-off a fresh probe is admissible.
	expireCoolOff(h)
	if admit, probe, _ := h.Admit(); !admit || !probe {
		t.Fatal("expected a fresh probe after re-open")
	}
}

func TestSSEFinalLineWithoutNewlineCounted(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	newStreamObs := func() *healthObserver {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		obs := newHealthObserver(h, req, true, false, 0)
		obs.status = 200
		return obs
	}
	// A stream whose only data line lacks a trailing newline still carried a
	// payload: it must not be misread as 200-empty.
	obs := newStreamObs()
	obs.noteBytes([]byte("data: {\"id\":\"1\"}"))
	obs.finishAtEOF()
	if s := h.Snapshot().FailureScore; s != 0 {
		t.Fatalf("score = %.1f, want 0 (final unterminated data line counts)", s)
	}
	// A lone unterminated [DONE] carries no payload: still 200-empty.
	h2 := NewPeerHealth("p2", testHealthConfig(), testLogger)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	obs2 := newHealthObserver(h2, req, true, false, 0)
	obs2.status = 200
	obs2.noteBytes([]byte("data: [DONE]"))
	obs2.finishAtEOF()
	if s := h2.Snapshot().FailureScore; s == 0 {
		t.Fatal("score = 0, want > 0 ([DONE]-only stream is 200-empty)")
	}
}

func TestNonCompletionEmptyEndpointsStaySuccess(t *testing.T) {
	cases := []struct {
		name         string
		path         string
		streamed     bool
		dataPayloads int
	}{
		{"empty models list", "/v1/models", false, 0},
		{"empty health check", "/healthz", false, 0},
		{"non-completion sse no payloads", "/v1/models", true, 0},
		{"embeddings empty body is 200-empty", "/v1/embeddings", false, 0},
		{"legacy completions empty body is 200-empty", "/v1/completions", false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyOutcome(200, tc.path, []byte(""), tc.streamed, tc.dataPayloads, true, false)
			want := OutcomeSuccess
			if completionPathRelevant(tc.path) {
				want = OutcomeEmpty200
			}
			if got != want {
				t.Fatalf("ClassifyOutcome(200, %q) = %q, want %q", tc.path, got, want)
			}
		})
	}
}

var errTestDial = errors.New("dial tcp: connection refused")

func newTestObserver(h *PeerHealth, path string, streaming bool, cancelCtx bool) *healthObserver {
	req := httptest.NewRequest(http.MethodPost, path, nil)
	if cancelCtx {
		ctx, cancel := context.WithCancel(req.Context())
		cancel()
		req = req.WithContext(ctx)
	}
	return newHealthObserver(h, req, streaming, false, 0)
}

func samples(h *PeerHealth) uint64 { return h.Snapshot().EWMASamples }

func TestObserverExactlyOnce_Non2xxStatus(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, false)
	obs.finishStatus(502)
	obs.finishStatus(502) // duplicate status call
	obs.finishAtEOF()     // then EOF: must not report again
	obs.finishAtClose()   // then close: must not report again
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1 (status reported once)", n)
	}
}

func TestObserverExactlyOnce_CompleteBody(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, false)
	obs.status = 200
	obs.noteBytes([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	obs.finishAtEOF()
	obs.finishAtEOF()   // duplicate EOF
	obs.finishAtClose() // then close
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1", n)
	}
	if s := h.Snapshot().FailureScore; s != 0 {
		t.Fatalf("score = %.1f, want 0 (successful body)", s)
	}
}

func TestObserverExactlyOnce_SSEStream(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", true, false)
	obs.status = 200
	obs.noteBytes([]byte("data: {\"id\":\"1\"}\n\n"))
	obs.noteBytes([]byte("data: [DONE]\n\n"))
	obs.finishAtEOF()
	obs.finishAtEOF()
	obs.finishAtClose()
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1", n)
	}
	if s := h.Snapshot().FailureScore; s != 0 {
		t.Fatalf("score = %.1f, want 0 (stream carried payloads)", s)
	}
}

func TestObserverExactlyOnce_EOFThenClose(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, false)
	obs.status = 200
	// Empty body -> 200-empty on EOF; a racing Close must not re-report.
	obs.finishAtEOF()
	obs.finishAtClose()
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1 (EOF wins, Close suppressed)", n)
	}
	if s := h.Snapshot().FailureScore; s == 0 {
		t.Fatal("score = 0, want > 0 (empty body at EOF is 200-empty)")
	}
}

func TestObserverExactlyOnce_CloseBeforeEOF(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, false)
	obs.status = 200
	obs.noteBytes([]byte(`{"choices":[{"message":{"content":"partial`))
	obs.finishAtClose() // body closed before EOF: transport, not empty-200
	obs.finishAtEOF()   // late EOF: suppressed
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1 (Close wins, late EOF suppressed)", n)
	}
}

func TestObserverCancelledNeutral(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, true) // ctx cancelled
	obs.status = 200
	obs.noteBytes([]byte(`{"choices":[]}`)) // would be 200-empty...
	obs.finishAtClose()                     // ...but the client went away first
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1", n)
	}
	// Cancelled is neutral: no failure score, and no readmission credit either.
	if s := h.Snapshot().FailureScore; s != 0 {
		t.Fatalf("score = %.1f, want 0 (client-gone close is neutral)", s)
	}
}

func TestObserverTransportError(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, false)
	obs.finishTransport(errTestDial)
	obs.finishAtClose() // racing close must not double-report
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1", n)
	}
}

func TestObserverCompetingFinishTransportAndStatus(t *testing.T) {
	h := NewPeerHealth("p1", testHealthConfig(), testLogger)
	obs := newTestObserver(h, "/v1/chat/completions", false, false)
	obs.finishTransport(errTestDial)
	obs.finishStatus(500) // status after transport failure: suppressed
	if n := samples(h); n != 1 {
		t.Fatalf("samples = %d, want exactly 1 (transport wins, status suppressed)", n)
	}
}
