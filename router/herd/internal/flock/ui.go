package flock

import (
	"encoding/json"
	"net/http"
)

// UIHandler serves flock status and metrics.
type UIHandler struct {
	router *Router
}

// NewUIHandler creates a UI handler bound to a router.
func NewUIHandler(router *Router) *UIHandler {
	return &UIHandler{router: router}
}

// ServeHTTP handles /flock/status and /flock/metrics.
// Legacy /astmatrix/* paths are still served (additive compat).
func (h *UIHandler) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	switch req.URL.Path {
	case "/flock/status", "/astmatrix/status":
		h.handleStatus(w, req)
	case "/flock/metrics", "/astmatrix/metrics":
		h.handleMetrics(w, req)
	default:
		http.NotFound(w, req)
	}
}

func (h *UIHandler) handleStatus(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	providers := []map[string]interface{}{}
	for _, p := range h.router.registry.All() {
		cb := h.router.getCircuit(p.ID)
		state, failures, lastFail := cb.Stats()
		providers = append(providers, map[string]interface{}{
			"id":         p.ID,
			"base_url":   p.BaseURL,
			"healthy":    h.router.healthDB.IsHealthy(p.ID),
			"latency_ms": h.router.healthDB.GetLatency(p.ID).Milliseconds(),
			"elo":        h.router.healthDB.GetELO(p.ID),
			"circuit":    state,
			"failures":   failures,
			"last_fail":  lastFail,
			"free_tier":  p.FreeTier,
		})
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"enabled":   h.router.cfg.Enabled,
		"strategy":  h.router.cfg.Strategy,
		"providers": providers,
	})
}

func (h *UIHandler) handleMetrics(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h.router.metrics.Snapshot())
}
