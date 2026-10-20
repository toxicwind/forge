package server

import (
	"encoding/json"
	"net/http"

	"github.com/mostlygeek/herd/internal/router"
)

// handlePeerHealth serves the per-peer self-healing state: healthy, degraded,
// circuit-open, or half-open (single-flight recovery probe), plus the EWMA
// latency, rolling error rate, failure score, and retry-after for each peer.
// Dead peers show here as circuit-open; recovered peers rejoin automatically.
func (s *Server) handlePeerHealth(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.peer.(interface {
		HealthSnapshots() []router.HealthSnapshot
	})
	if !ok {
		http.Error(w, `{"error":"peer health unavailable"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(provider.HealthSnapshots())
}
