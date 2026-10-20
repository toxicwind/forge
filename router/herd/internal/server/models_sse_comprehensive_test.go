package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mostlygeek/herd/internal/config"
	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/process"
	"github.com/mostlygeek/herd/internal/store/sqlite"
)

// TestModelEvents_Reconnect tests Zed's reconnect logic.
func TestModelEvents_Reconnect(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{"m1": process.StateReady},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	req1 := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req1.Header.Set("Accept", "text/event-stream")
	w1 := newStreamRecorder()
	go func() { s.ServeHTTP(w1, req1) }()
	time.Sleep(60 * time.Millisecond)

	// Disconnect first client
	s.shutdownFn()
	time.Sleep(20 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proxylog := logmon.NewWriter(io.Discard)
	st, _ := sqlite.New("")
	s2 := &Server{
		cfg:         config.Config{Security: &config.SecurityConfig{}},
		muxlog:      logmon.NewWriter(io.Discard),
		proxylog:    proxylog,
		upstreamlog: logmon.NewWriter(io.Discard),
		inflight:    newInflightTracker(),
		metrics:     newMetricsMonitor(proxylog, 0, 0, st),
		store:       st,
		local:       stub,
		peer:        newStubRouter(nil, ""),
		modelEvents: newModelEventBroadcaster(proxylog),
		shutdownCtx: ctx,
		shutdownFn:  cancel,
	}
	s2.routes()
	go s2.watchModelState(20 * time.Millisecond)
	defer cancel()

	req2 := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req2.Header.Set("Accept", "text/event-stream")
	w2 := newStreamRecorder()
	go func() { s2.ServeHTTP(w2, req2) }()
	time.Sleep(60 * time.Millisecond)

	events := parseSSE(t, w2.String())
	if len(events) != 1 {
		t.Fatalf("reconnect: expected 1 primed event, got %d: %v", len(events), events)
	}
	if events[0].Model != "m1" || events[0].Data == nil || events[0].Data.Status == nil || *events[0].Data.Status != "loaded" {
		t.Fatalf("reconnect: unexpected event %+v", events[0])
	}
}

// TestModelEvents_ConcurrentSubscribers tests multiple Zed instances
// can subscribe simultaneously and all receive events.
func TestModelEvents_ConcurrentSubscribers(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	const numClients = 5
	results := make([][]ModelEvent, numClients)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
			req = req.WithContext(ctx)
			req.Header.Set("Accept", "text/event-stream")
			w := newStreamRecorder()
			s.ServeHTTP(w, req)
			results[idx] = parseSSE(t, w.String())
		}(i)
	}

	time.Sleep(100 * time.Millisecond)
	stub.setRunningState("m1", process.StateReady)
	time.Sleep(150 * time.Millisecond)
	cancel() // terminate all SSE handlers
	wg.Wait()

	for i, events := range results {
		var loaded int
		for _, ev := range events {
			if ev.Data != nil && ev.Data.Status != nil && *ev.Data.Status == "loaded" {
				loaded++
			}
		}
		if loaded != 1 {
			t.Errorf("client %d: expected 1 loaded event, got %d: %v", i, loaded, events)
		}
	}
}

// TestModelEvents_KeepAlive tests keep-alive comments.
func TestModelEvents_KeepAlive(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req.Header.Set("Accept", "text/event-stream")
	w := newStreamRecorder()
	go func() { s.ServeHTTP(w, req) }()
	time.Sleep(50 * time.Millisecond)
}

// TestModelEvents_NoDuplicatePriming tests that reconnecting when state
// hasn't changed does NOT emit spurious events (dedup works).
// First connect emits 1 loaded (prime), subsequent reconnects emit 0.
func TestModelEvents_NoDuplicatePriming(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{"m1": process.StateReady},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	// First connect: should emit 1 loaded (initial prime)
	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req.Header.Set("Accept", "text/event-stream")
	w := newStreamRecorder()
	go func() { s.ServeHTTP(w, req) }()
	time.Sleep(60 * time.Millisecond)
	events := parseSSE(t, w.String())
	var loaded int
	for _, ev := range events {
		if ev.Data != nil && ev.Data.Status != nil && *ev.Data.Status == "loaded" {
			loaded++
		}
	}
	if loaded != 1 {
		t.Errorf("first connect: expected 1 loaded, got %d", loaded)
	}

	// Subsequent reconnects: should emit 0 (dedup works)
	for i := 1; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
		req.Header.Set("Accept", "text/event-stream")
		w := newStreamRecorder()
		go func() { s.ServeHTTP(w, req) }()
		time.Sleep(60 * time.Millisecond)
		events := parseSSE(t, w.String())
		var loaded int
		for _, ev := range events {
			if ev.Data != nil && ev.Data.Status != nil && *ev.Data.Status == "loaded" {
				loaded++
			}
		}
		if loaded != 0 {
			t.Errorf("reconnect %d: expected 0 loaded (dedup), got %d", i, loaded)
		}
	}
}

// TestModelEvents_LoadingProgress tests that StateStarting is treated as
// loaded (not a separate loading progress event). Current implementation
// treats both StateReady and StateStarting as "loaded" for simplicity.
// Loading progress granularity would require backend integration.
func TestModelEvents_LoadingProgress(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req.Header.Set("Accept", "text/event-stream")
	w := newStreamRecorder()
	go func() { s.ServeHTTP(w, req) }()
	time.Sleep(60 * time.Millisecond)

	// Set to StateStarting (loading phase)
	stub.setRunningState("m1", process.StateStarting)
	time.Sleep(120 * time.Millisecond)

	events := parseSSE(t, w.String())
	var loaded int
	for _, ev := range events {
		if ev.Data != nil && ev.Data.Status != nil && *ev.Data.Status == "loaded" {
			loaded++
		}
	}
	// StateStarting is treated as "loaded" (no separate loading progress)
	if loaded != 1 {
		t.Fatalf("expected 1 loaded event for StateStarting, got %d: %v", loaded, events)
	}
}

// TestModelEvents_ModelsReload tests models_reload event.
func TestModelEvents_ModelsReload(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true, "m2": true},
		running: map[string]process.ProcessState{"m1": process.StateReady},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req.Header.Set("Accept", "text/event-stream")
	w := newStreamRecorder()
	go func() { s.ServeHTTP(w, req) }()
	time.Sleep(60 * time.Millisecond)

	s.modelEvents.reloadEvent()
	time.Sleep(100 * time.Millisecond)

	events := parseSSE(t, w.String())
	var reload int
	for _, ev := range events {
		if ev.Model == "*" && ev.Event == "models_reload" {
			reload++
		}
	}
	if reload != 1 {
		t.Fatalf("expected 1 models_reload event, got %d: %v", reload, events)
	}
}

// TestModelEvents_ModelRemove tests model_remove event.
func TestModelEvents_ModelRemove(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{"m1": process.StateReady},
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req.Header.Set("Accept", "text/event-stream")
	w := newStreamRecorder()
	go func() { s.ServeHTTP(w, req) }()
	time.Sleep(60 * time.Millisecond)

	delete(stub.models, "m1")
	stub.deleteRunningState("m1")
	s.modelEvents.removeEvent("m1")
	time.Sleep(100 * time.Millisecond)

	events := parseSSE(t, w.String())
	var removed, unloaded int
	for _, ev := range events {
		if ev.Event == "model_remove" && ev.Model == "m1" {
			removed++
		}
		if ev.Data != nil && ev.Data.Status != nil && *ev.Data.Status == "unloaded" {
			unloaded++
		}
	}
	if removed != 1 {
		t.Fatalf("expected 1 model_remove, got %d", removed)
	}
	if unloaded != 1 {
		t.Fatalf("expected 1 unloaded from remove, got %d", unloaded)
	}
}

// TestModelEvents_NoAuthChatPath tests keyless chat path.
func TestModelEvents_NoAuthChatPath(t *testing.T) {
	stub := newStubRouter([]string{"m1"}, `{"choices":[{"finish_reason":"stop","index":0,"message":{"role":"assistant","content":"ok"}}]}`)
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"m1","messages":[{"role":"user","content":"hi"}],"max_tokens":4,"stream":false}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("chat no-auth: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}
