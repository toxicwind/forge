package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/process"
	"github.com/mostlygeek/herd/internal/router/scheduler"
)

func TestModelEvents_PrimeEmitsLoaded(t *testing.T) {
	bc := newModelEventBroadcaster(logmon.New())
	client := bc.subscribe()
	defer bc.unsubscribe(client)
	// Simulate one running model.
	bc.syncRunning(map[string]process.ProcessState{
		"m1": process.StateReady,
	})

	select {
	case ev := <-client.ch:
		if ev.Model != "m1" {
			t.Fatalf("model = %q, want m1", ev.Model)
		}
		if ev.Data == nil || ev.Data.Status == nil || *ev.Data.Status != "loaded" {
			t.Fatalf("event data.status = %+v, want loaded", ev.Data)
		}
		if ev.Event != "status_change" {
			t.Fatalf("event = %q, want status_change", ev.Event)
		}
	default:
		t.Fatal("no event primed on subscribe")
	}
}

// streamRecorder captures incremental SSE writes. httptest.ResponseRecorder
// buffers until the handler returns, which never happens for a long-lived
// stream, so we use a minimal streaming http.ResponseWriter instead.
type streamRecorder struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	hdr  http.Header
	code int
}

func newStreamRecorder() *streamRecorder {
	return &streamRecorder{hdr: make(http.Header), code: http.StatusOK}
}

func (r *streamRecorder) Header() http.Header { return r.hdr }
func (r *streamRecorder) WriteHeader(c int) {
	r.mu.Lock()
	if r.code == 0 {
		r.code = c
	}
	r.mu.Unlock()
}
func (r *streamRecorder) Write(b []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.Write(b)
}
func (r *streamRecorder) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.String()
}
func (r *streamRecorder) Flush() {}

type stubLocalRouter struct {
	running map[string]process.ProcessState
}

func (s *stubLocalRouter) RunningModels() map[string]process.ProcessState {
	return s.running
}
func (s *stubLocalRouter) Unload(time.Duration, ...string)              {}
func (s *stubLocalRouter) StartSwap(string, []string)                   {}
func (s *stubLocalRouter) GrantServe(scheduler.HandlerReq, string) bool { return false }
func (s *stubLocalRouter) GrantError(scheduler.HandlerReq, error)       {}
func (s *stubLocalRouter) StopProcesses(time.Duration, []string)        {}
func (s *stubLocalRouter) Shutdown(time.Duration) error                 { return nil }
func (s *stubLocalRouter) ServeHTTP(http.ResponseWriter, *http.Request) {}
func (s *stubLocalRouter) Handles(string) bool                          { return true }
func (s *stubLocalRouter) ProcessLogger(string) (*logmon.Monitor, bool) { return nil, false }

func TestModelEvents_HandlerStreams(t *testing.T) {
	// stubLocalRouter lets the handler exercise its real s.local.RunningModels()
	// priming path (instead of the nil-guard skip).
	stub := &stubLocalRouter{running: map[string]process.ProcessState{"m1": process.StateReady}}
	s := &Server{
		local:       stub,
		modelEvents: newModelEventBroadcaster(logmon.New()),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/models/sse", nil).WithContext(ctx)
	w := newStreamRecorder()
	go func() { s.handleModelEvents(w, req) }()

	// Give the handler time to prime + write the first event, then cancel.
	time.Sleep(50 * time.Millisecond)
	cancel()
	time.Sleep(20 * time.Millisecond)

	body := w.String()
	if !strings.Contains(body, "data:") {
		t.Fatalf("body has no data: line, got %q", body)
	}
	if !strings.Contains(body, `"model":"m1"`) {
		t.Fatalf("body missing m1 event: %q", body)
	}
	if !strings.Contains(body, `"status":"loaded"`) {
		t.Fatalf("body missing loaded status: %q", body)
	}
}
