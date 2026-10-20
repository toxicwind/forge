package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/process"
)

// TestModelEvents_EndToEnd exercises the full /models/sse chain the way Zed's
// llama.cpp provider consumes it:
//  1. Start a real Server with a stub local router (no New(), so we wire the
//     broadcaster + watcher exactly as New() does).
//  2. A client subscribes to GET /models/sse (SSE, Accept: text/event-stream).
//  3. Simulate an on-demand model LOAD by mutating the router's running set,
//     which the watchModelState goroutine must detect and broadcast.
//  4. Simulate an UNLOAD the same way.
//  5. Assert the exact ModelEvent envelope arrives for each transition, and
//     that no duplicate is emitted for an unchanged state (Zed re-discovery
//     must not be spammed).
func TestModelEvents_EndToEnd(t *testing.T) {
	stub := &stubRouter{
		models:  map[string]bool{"m1": true},
		running: map[string]process.ProcessState{}, // start: nothing loaded
	}
	s := newTestServer(stub, newStubRouter(nil, ""))
	s.modelEvents = newModelEventBroadcaster(logmon.NewWriter(io.Discard))
	// Mirror New(): launch the state watcher.
	go s.watchModelState(20 * time.Millisecond)
	t.Cleanup(func() { s.shutdownFn() })

	// --- subscribe exactly like Zed: GET /models/sse, Accept: text/event-stream ---
	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil)
	req.Header.Set("Accept", "text/event-stream")
	w := newStreamRecorder()
	go func() { s.ServeHTTP(w, req) }()

	// Give the handler time to subscribe + prime (nothing loaded yet -> no event).
	time.Sleep(60 * time.Millisecond)

	// --- simulate on-demand LOAD of m1 ---
	stub.setRunningState("m1", process.StateReady)
	time.Sleep(120 * time.Millisecond)

	// --- simulate UNLOAD of m1 ---
	stub.deleteRunningState("m1")
	time.Sleep(120 * time.Millisecond)

	// --- assert: exactly one loaded + one unloaded event, correct envelope ---
	events := parseSSE(t, w.String())

	var loaded, unloaded int
	for _, ev := range events {
		if ev.Model != "m1" {
			t.Fatalf("unexpected model %q", ev.Model)
		}
		if ev.Data == nil || ev.Data.Status == nil {
			t.Fatalf("event missing data.status: %+v", ev)
		}
		switch *ev.Data.Status {
		case "loaded":
			loaded++
		case "unloaded":
			unloaded++
		default:
			t.Fatalf("unexpected status %q", *ev.Data.Status)
		}
		if ev.Event != "status_change" {
			t.Fatalf("event = %q, want status_change", ev.Event)
		}
	}

	if loaded != 1 {
		t.Fatalf("loaded events = %d, want 1 (got events: %v)", loaded, events)
	}
	if unloaded != 1 {
		t.Fatalf("unloaded events = %d, want 1 (got events: %v)", unloaded, events)
	}
}

// parseSSE extracts ModelEvent envelopes from an SSE byte stream. Each event is
// a single `data: <json>` line; comments (`: keep-alive`) are ignored — this
// mirrors Zed's stream_model_events() parser.
func parseSSE(t *testing.T, body string) []ModelEvent {
	t.Helper()
	var events []ModelEvent
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue // skip keep-alive comments / blank lines
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var ev ModelEvent
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			t.Fatalf("parse SSE payload %q: %v", payload, err)
		}
		events = append(events, ev)
	}
	return events
}

// ensure context import is used (handler path references r.Context()).
var _ = context.Background
