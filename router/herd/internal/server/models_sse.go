package server

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/process"
)

// ModelEvent is the exact envelope Zed's llama.cpp provider expects from
// GET /models/sse (see crates/llama_cpp/src/llama_cpp.rs: ModelEvent).
// It mirrors upstream llama.cpp's notify_sse() broadcast so the proxy can
// synthesize the feed even when a backend does not speak /models/sse itself.
//
// Wire format: SSE, one event per `data:` line, Accept: text/event-stream.
//
//	data: {"model":"<id>|*","event":"<name>","data":{...}}\n\n
//
// Events that change model state (trigger Zed re-discovery):
//
//	"models_reload" (model "*"), "model_remove",
//	data.status == "loaded" | "unloaded".
//
// "loading" events carry data.progress for the % indicator but do NOT
// trigger re-discovery.
type ModelEvent struct {
	Model string          `json:"model"`
	Event string          `json:"event"`
	Data  *ModelEventData `json:"data,omitempty"`
}

// ModelEventData is the optional payload. Status drives Zed's state machine;
// progress is the per-stage load fraction (0.0..=1.0).
type ModelEventData struct {
	Status   *string       `json:"status,omitempty"`
	ExitCode *int32        `json:"exit_code,omitempty"`
	Progress *LoadProgress `json:"progress,omitempty"`
}

// LoadProgress matches Zed's LoadProgress: stages load in order
// (text_model, optional spec_model/mmproj_model), each 0.0..=1.0.
type LoadProgress struct {
	Stages  []string `json:"stages"`
	Current string   `json:"current"`
	Value   float32  `json:"value"`
}

// modelEventClient is one subscribed SSE connection.
type modelEventClient struct {
	ch chan ModelEvent
}

// modelEventBroadcaster fans model lifecycle events out to all subscribed
// /models/sse clients. The proxy owns the truth: herd starts and
// stops every backend process, so it can emit loaded/unloaded/loading
// events regardless of whether the backend itself supports /models/sse.
type modelEventBroadcaster struct {
	mu      sync.Mutex
	clients map[*modelEventClient]struct{}
	// lastStatus tracks the most recent terminal status per model so we only
	// broadcast on an actual transition (avoids Zed re-discovery spam).
	lastStatus map[string]string
	log        *logmon.Monitor
}

func newModelEventBroadcaster(log *logmon.Monitor) *modelEventBroadcaster {
	return &modelEventBroadcaster{
		clients:    make(map[*modelEventClient]struct{}),
		lastStatus: make(map[string]string),
		log:        log,
	}
}

func (b *modelEventBroadcaster) subscribe() *modelEventClient {
	c := &modelEventClient{ch: make(chan ModelEvent, 64)}
	b.mu.Lock()
	b.clients[c] = struct{}{}
	b.mu.Unlock()
	return c
}

func (b *modelEventBroadcaster) unsubscribe(c *modelEventClient) {
	b.mu.Lock()
	if _, ok := b.clients[c]; ok {
		delete(b.clients, c)
		close(c.ch)
	}
	b.mu.Unlock()
}

// broadcast sends an event to every subscriber. Non-blocking per client so a
// slow reader cannot stall the others.
func (b *modelEventBroadcaster) broadcast(ev ModelEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for c := range b.clients {
		select {
		case c.ch <- ev:
		default:
			// Drop on a full buffer; Zed reconnects and re-syncs via /v1/models.
		}
	}
}

// statusEvent emits a terminal loaded/unloaded transition (deduped).
// The lastStatus map is guarded by b.mu; the lock is released before
// broadcast() because broadcast() takes b.mu itself (non-reentrant).
func (b *modelEventBroadcaster) statusEvent(modelID, status string, exitCode *int32) {
	b.mu.Lock()
	if prev, ok := b.lastStatus[modelID]; ok && prev == status {
		b.mu.Unlock()
		return
	}
	b.lastStatus[modelID] = status
	b.mu.Unlock()
	data := &ModelEventData{Status: &status}
	if exitCode != nil {
		data.ExitCode = exitCode
	}
	b.broadcast(ModelEvent{
		Model: modelID,
		Event: "status_change",
		Data:  data,
	})
}

// loadingEvent emits a per-stage progress tick (does not change state).
func (b *modelEventBroadcaster) loadingEvent(modelID string, stages []string, current string, value float32) {
	b.broadcast(ModelEvent{
		Model: modelID,
		Event: "status_change",
		Data: &ModelEventData{
			Status:   strPtr("loading"),
			Progress: &LoadProgress{Stages: stages, Current: current, Value: value},
		},
	})
}

// reloadEvent announces the whole list changed (config reload / preload).
// The map reset is guarded by b.mu; the lock is released before
// broadcast() because broadcast() takes b.mu itself (non-reentrant).
func (b *modelEventBroadcaster) reloadEvent() {
	b.mu.Lock()
	b.lastStatus = make(map[string]string)
	b.mu.Unlock()
	b.broadcast(ModelEvent{Model: "*", Event: "models_reload"})
}

// removeEvent announces a model was removed from config. It broadcasts a
// model_remove event but leaves the status in lastStatus so that the
// next reconcileMissing tick will emit an unloaded transition.
func (b *modelEventBroadcaster) removeEvent(modelID string) {
	b.broadcast(ModelEvent{Model: modelID, Event: "model_remove"})
}

// syncRunning snapshots current RunningModels() and emits loaded/unloaded
// transitions for every known model. Called on startup, config reload, and
// after unload so Zed's capabilities stay current without a manual refresh.
func (b *modelEventBroadcaster) syncRunning(running map[string]process.ProcessState) {
	for id, st := range running {
		switch st {
		case process.StateReady, process.StateStarting:
			b.statusEvent(id, "loaded", nil)
		default:
			b.statusEvent(id, "unloaded", nil)
		}
	}
}

// reconcileMissing emits unloaded for any model the broadcaster previously
// marked loaded (in lastStatus) but that is absent from the current running
// set. This catches on-demand unloads that remove the model from
// RunningModels() entirely — a plain iteration over the running set would miss
// the disappearance and Zed would never learn the model unloaded.
func (b *modelEventBroadcaster) reconcileMissing(seen map[string]struct{}) {
	// Collect events to broadcast while holding the lock, then release
	// before broadcasting to avoid deadlock with broadcast()'s lock.
	var toBroadcast []ModelEvent
	b.mu.Lock()
	for id, prev := range b.lastStatus {
		if prev != "loaded" {
			continue
		}
		if _, stillThere := seen[id]; stillThere {
			continue
		}
		b.lastStatus[id] = "unloaded"
		toBroadcast = append(toBroadcast, ModelEvent{
			Model: id,
			Event: "status_change",
			Data:  &ModelEventData{Status: strPtr("unloaded")},
		})
	}
	b.mu.Unlock()

	for _, ev := range toBroadcast {
		b.broadcast(ev)
	}
}

func strPtr(s string) *string { return &s }

// handleModelEvents serves GET /models/sse as text/event-stream, matching
// upstream llama.cpp's get_router_models_sse framing exactly:
//
//	data: <json>\n\n
//
// Zed's stream_model_events() reads one JSON envelope per `data:` line and
// reconnects when the stream ends, so we close cleanly on disconnect/stop.
func (s *Server) handleModelEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	client := s.modelEvents.subscribe()
	defer s.modelEvents.unsubscribe(client)

	// Prime the client with current state so a fresh Zed subscriber sees
	// loaded/unloaded immediately (no wait for the next transition).
	if s.local != nil {
		s.modelEvents.syncRunning(s.local.RunningModels())
	}
	// Always send an immediate SSE frame so subscribers (Zed / e2e) do not
	// wait up to 30s when no models are running and the channel is quiet.
	if _, err := w.Write([]byte(": keep-alive\n\n")); err != nil {
		return
	}
	flusher.Flush()

	ctx := r.Context()
	shutdownDone := func() <-chan struct{} {
		if s.shutdownCtx != nil {
			return s.shutdownCtx.Done()
		}
		return make(chan struct{})
	}()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-shutdownDone:
			return
		case ev, ok := <-client.ch:
			if !ok {
				return
			}
			payload, err := json.Marshal(ev)
			if err != nil {
				s.modelEvents.log.Warnf("models/sse: marshal event: %v", err)
				continue
			}
			// Framing: "data: <json>\n\n" — matches llama.cpp + Zed parser.
			if _, err := w.Write(append([]byte("data: "), append(payload, '\n', '\n')...)); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			// Keep-alive comment so proxies don't drop an idle stream.
			if _, err := w.Write([]byte(": keep-alive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
