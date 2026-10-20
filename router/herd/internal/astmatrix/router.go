package astmatrix

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RouteResult is the outcome of a routing strategy.
type RouteResult struct {
	OK       bool
	Status   int
	Provider string
	Model    string
	Lat      float64
	Data     []byte
	Stream   io.ReadCloser
	Err      string
	Winner   int
}

// strategyFunc is the signature for routing strategies.
type strategyFunc func(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult

// Router wraps Matrix and implements the router.Router interface so the
// server can dispatch cloud/chat models to remote providers via astmatrix.
type Router struct {
	config *AstMatrixConfig
	matrix *Matrix
}

// NewRouter creates a Router from config, initializing the provider matrix
// and health database.
func NewRouter(cfg *AstMatrixConfig) (*Router, error) {
	if cfg == nil {
		cfg = &AstMatrixConfig{}
	}
	cfg.Defaults()
	m, err := NewMatrix(cfg)
	if err != nil {
		return nil, fmt.Errorf("astmatrix.NewRouter: %w", err)
	}
	return &Router{config: cfg, matrix: m}, nil
}

// Handles reports whether this router can serve requests for the given model.
// It returns true for cloud model IDs that resolve via coding aliases or
// provider model lists — but NOT for local GGUF IDs (local dispatch takes
// priority in server.go).
func (r *Router) Handles(model string) bool {
	if model == "" {
		return false
	}
	// auto/fcm are always handled (strategy picks the provider)
	if model == "auto" || model == "fcm" || model == "free" {
		return true
	}
	// Explicit coding aliases map to specific cloud providers
	if isExplicit(model) {
		return true
	}
	// Check if any cloud provider lists this model
	for _, p := range r.matrix.Providers() {
		for _, mid := range p.models {
			if mid == model {
				return true
			}
		}
	}
	return false
}

// ServeHTTP routes an incoming OpenAI-compatible chat request to a cloud
// provider using the configured strategy.
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// Read the full body
	body, err := io.ReadAll(req.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}
	req.Body.Close()

	var bodyMap map[string]interface{}
	if err := json.Unmarshal(body, &bodyMap); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	// Extract session for sticky affinity
	session := req.Header.Get("X-Session-Id")
	if session == "" {
		session = "default"
	}

	// Pick strategy from header or config
	strategyName := req.Header.Get("X-estate-scripts-Strategy")
	if strategyName == "" {
		strategyName = r.config.Strategy
	}

	strategyFn, ok := strategies[strategyName]
	if !ok {
		strategyFn = strategies["hybrid"]
	}

	// Detect streaming
	stream, _ := bodyMap["stream"].(bool)

	// Run the strategy
	result := strategyFn(context.Background(), r.matrix, bodyMap, session)

	if stream && result.OK && result.Stream != nil {
		// Streaming response
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Routed-Via", result.Provider)
		w.Header().Set("X-Strategy", strategyName)
		w.Header().Set("X-Latency", fmt.Sprintf("%.3f", result.Lat))
		w.WriteHeader(http.StatusOK)
		flusher, ok := w.(http.Flusher)
		if !ok {
			result.Stream.Close()
			return
		}
		io.Copy(w, result.Stream)
		result.Stream.Close()
		flusher.Flush()
		return
	}

	// Non-streaming response
	if !result.OK {
		errMsg := result.Err
		if errMsg == "" {
			errMsg = fmt.Sprintf("routing failed: status %d", result.Status)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Routed-Via", result.Provider)
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": errMsg})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Routed-Via", result.Provider)
	w.Header().Set("X-Strategy", strategyName)
	w.Header().Set("X-Latency", fmt.Sprintf("%.3f", result.Lat))
	w.WriteHeader(http.StatusOK)
	w.Write(result.Data)
}

// Close closes the health database.
func (r *Router) Close() error {
	if r.matrix != nil {
		return r.matrix.Close()
	}
	return nil
}

// Matrix returns the underlying Matrix for inspection (UI, tests).
func (r *Router) Matrix() *Matrix {
	return r.matrix
}

// callOne makes a single HTTP request to a provider and records the result.
func callOne(ctx context.Context, m *Matrix, provider, model string, body map[string]interface{}) RouteResult {
	if !m.CircuitOk(provider) {
		return RouteResult{Status: 503, Provider: provider, Err: "circuit_open"}
	}

	// Check per-provider rate limiter before making a request
	if m.rateLimiter != nil && !m.rateLimiter.CanRequest(provider) {
		backoff := m.rateLimiter.GetBackoffRemaining(provider)
		errMsg := "rate_limited_by_router"
		if backoff > 0 {
			errMsg = fmt.Sprintf("rate_limited_by_router: retry after %.0fs", backoff.Seconds())
		}
		m.Record(model, provider, 429, 0, 0, "", "")
		return RouteResult{Status: 429, Provider: provider, Err: errMsg}
	}

	prov, ok := m.providers[provider]
	if !ok {
		return RouteResult{Status: 500, Provider: provider, Err: "unknown_provider"}
	}

	url := strings.TrimRight(prov.base, "/") + "/chat/completions"
	headers := map[string]string{
		"Content-Type":    "application/json",
		"User-Agent":      "estate-scriptsASTMatrix/3.1",
		"Accept-Encoding": "identity",
	}
	if !prov.noAuth {
		headers["Authorization"] = "Bearer " + m.GetKey(provider)
	} else {
		headers["Authorization"] = "Bearer not-required-for-local"
	}
	if provider == "openrouter" {
		headers["HTTP-Referer"] = "https://zed.dev"
		headers["X-Title"] = "estate-scripts-AST-Matrix"
	}

	payload := make(map[string]interface{})
	for k, v := range body {
		payload[k] = v
	}
	payload["model"] = model
	stream, _ := body["stream"].(bool)
	payload["stream"] = stream

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return RouteResult{Status: 500, Provider: provider, Err: "marshal_error"}
	}

	var timeout time.Duration
	if stream {
		timeout = 180 * time.Second
	} else {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return RouteResult{Status: 500, Provider: provider, Err: "request_error"}
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	// Record request for rate limiting
	if m.rateLimiter != nil {
		m.rateLimiter.RecordRequest(provider)
	}

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	lat := time.Since(start).Seconds()

	if err != nil {
		m.Record(model, provider, 500, lat, 0, "", "")
		return RouteResult{Status: 500, Provider: provider, Lat: lat, Err: err.Error()}
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 500))

		// Extract 429 retry headers for rate limiter
		if resp.StatusCode == 429 && m.rateLimiter != nil {
			retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
			rateLimitReset := parseRateLimitReset(resp.Header.Get("X-RateLimit-Reset"))
			retryDur := retryAfter
			if rateLimitReset > retryDur {
				retryDur = rateLimitReset
			}
			m.rateLimiter.Record429(provider, retryDur)
		}

		m.Record(model, provider, resp.StatusCode, lat, 0, "", "")
		if resp.StatusCode == 404 {
			// Report the 404 to the TS catalog brain (best-effort, async,
			// never blocks routing). The quarantine decision lives in the TS
			// package; herd only reports the event. The TS side rewrites the
			// live catalog file and herd picks it up on its next read.
			go reportServe404(provider, model)
		}
		return RouteResult{Status: resp.StatusCode, Provider: provider, Lat: lat, Err: string(errBody)}
	}

	// Record success to reset rate limiter backoff
	if m.rateLimiter != nil {
		m.rateLimiter.RecordSuccess(provider)
	}

	if stream {
		m.Record(model, provider, 200, lat, 0, "", "")
		return RouteResult{OK: true, Status: 200, Provider: provider, Model: model, Lat: lat, Stream: resp.Body}
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		m.Record(model, provider, 500, lat, 0, "", "")
		return RouteResult{Status: 500, Provider: provider, Lat: lat, Err: "read_error"}
	}
	m.Record(model, provider, 200, lat, 0, "", "")
	return RouteResult{OK: true, Status: 200, Provider: provider, Model: model, Lat: lat, Data: data}
}

// --- Strategies ---

func routeHybrid(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	model := getModel(body)
	if isExplicit(model) {
		p, mid := resolveModel(model, m.providers)
		r := callOne(ctx, m, p, mid, body)
		if r.OK {
			m.StickySet(session, p, mid)
			m.Record(mid, p, 200, r.Lat, 1, "hybrid_direct", session)
		}
		return r
	}
	sp, sm := m.StickyGet(session)
	if sp != "" && m.KeyOk(sp) && m.CircuitOk(sp) {
		if sm == "" {
			sm = model
		}
		r := callOne(ctx, m, sp, sm, body)
		if r.OK {
			return r
		}
	}
	r2 := routeAstRace(ctx, m, body, session)
	if r2.OK {
		return r2
	}
	return routeCircuitChain(ctx, m, body, session)
}

func routeAstRace(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	model := getModel(body)
	if isExplicit(model) {
		p, mid := resolveModel(model, m.providers)
		r := callOne(ctx, m, p, mid, body)
		if r.OK {
			m.StickySet(session, p, mid)
			m.Record(mid, p, 200, r.Lat, 1, "ast_race", session)
		}
		return r
	}
	cands := m.PickWeighted(m.config.MaxParallel)
	if len(cands) == 0 {
		return RouteResult{Status: 503, Err: "no_providers"}
	}
	type candidateResult struct {
		idx int
		r   RouteResult
	}
	results := make([]RouteResult, len(cands))
	var wg sync.WaitGroup
	for i, c := range cands {
		wg.Add(1)
		go func(idx int, p, mid string) {
			defer wg.Done()
			results[idx] = callOne(ctx, m, p, mid, body)
		}(i, c[0], c[1])
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(95 * time.Second):
	}
	var best RouteResult
	for _, r := range results {
		if !r.OK {
			continue
		}
		if len(r.Data) > 0 {
			var parsed struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if json.Unmarshal(r.Data, &parsed) == nil && len(parsed.Choices) > 0 {
				content := parsed.Choices[0].Message.Content
				if isAST(content) {
					m.StickySet(session, r.Provider, r.Model)
					m.Record(r.Model, r.Provider, 200, r.Lat, 1, "ast_race", session)
					return r
				}
			}
		}
		if !best.OK {
			best = r
		}
	}
	if best.OK {
		m.StickySet(session, best.Provider, best.Model)
		return best
	}
	return RouteResult{Status: 503, Err: "ast_race_exhausted"}
}

func routeSticky(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	model := getModel(body)
	if isExplicit(model) {
		return routeAstRace(ctx, m, body, session)
	}
	sp, sm := m.StickyGet(session)
	if sp != "" && m.KeyOk(sp) && m.CircuitOk(sp) {
		if sm == "" {
			sm = model
		}
		r := callOne(ctx, m, sp, sm, body)
		if r.OK {
			return r
		}
	}
	return routeAstRace(ctx, m, body, session)
}

func routeWeighted(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	cands := m.PickWeighted(1)
	if len(cands) == 0 {
		return RouteResult{Status: 503, Err: "no_providers"}
	}
	p, mid := cands[0][0], cands[0][1]
	r := callOne(ctx, m, p, mid, body)
	if r.OK {
		m.StickySet(session, p, mid)
	}
	return r
}

func routeCircuitChain(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	model := getModel(body)
	if isExplicit(model) {
		p, mid := resolveModel(model, m.providers)
		if m.KeyOk(p) && m.CircuitOk(p) {
			r := callOne(ctx, m, p, mid, body)
			if r.OK {
				m.StickySet(session, p, mid)
				return r
			}
		}
		return RouteResult{Status: 502, Err: fmt.Sprintf("explicit_provider_unavailable:%s", p)}
	}
	type provScore struct {
		name  string
		score float64
	}
	providers := m.Providers()
	var all []provScore
	for name := range providers {
		all = append(all, provScore{name, m.ELO(name)})
	}
	for i := 0; i < len(all); i++ {
		for j := i + 1; j < len(all); j++ {
			if all[j].score > all[i].score {
				all[i], all[j] = all[j], all[i]
			}
		}
	}
	for _, ps := range all {
		if !m.KeyOk(ps.name) || !m.CircuitOk(ps.name) {
			continue
		}
		mid := firstModelFor(ps.name)
		if mid == "" {
			continue
		}
		r := callOne(ctx, m, ps.name, mid, body)
		if r.OK {
			m.StickySet(session, ps.name, mid)
			return r
		}
	}
	return RouteResult{Status: 503, Err: "circuit_chain_exhausted"}
}

func routeFifo(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	m.mu.Lock()
	if m.fifoDepth >= m.config.FifoMax {
		m.mu.Unlock()
		return RouteResult{Status: 429, Err: "fifo_full"}
	}
	m.fifoDepth++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.fifoDepth > 0 {
			m.fifoDepth--
		}
		m.mu.Unlock()
	}()
	return routeAstRace(ctx, m, body, session)
}

func routeFree(ctx context.Context, m *Matrix, body map[string]interface{}, session string) RouteResult {
	model := getModel(body)
	if isExplicit(model) {
		p, mid := resolveModel(model, m.providers)
		if strings.Contains(mid, ":free") || p == "herd" {
			r := callOne(ctx, m, p, mid, body)
			if r.OK {
				m.StickySet(session, p, mid)
				m.Record(mid, p, 200, r.Lat, 1, "free", session)
			}
			return r
		}
	}
	var cands [][2]string
	for name, prov := range m.Providers() {
		if !m.KeyOk(name) || !m.CircuitOk(name) {
			continue
		}
		for _, mid := range prov.models {
			if strings.Contains(mid, ":free") {
				cands = append(cands, [2]string{name, mid})
			}
		}
	}
	if m.KeyOk("herd") {
		cands = append(cands, [2]string{"herd", "local-quality"})
	}
	if len(cands) == 0 {
		return RouteResult{Status: 503, Err: "no_free_providers"}
	}
	return raceCandidates(ctx, m, body, session, cands, "free")
}

func raceCandidates(ctx context.Context, m *Matrix, body map[string]interface{}, session string, cands [][2]string, strategy string) RouteResult {
	if len(cands) > m.config.MaxParallel {
		cands = cands[:m.config.MaxParallel]
	}
	results := make([]RouteResult, len(cands))
	var wg sync.WaitGroup
	for i, c := range cands {
		wg.Add(1)
		go func(idx int, p, mid string) {
			defer wg.Done()
			results[idx] = callOne(ctx, m, p, mid, body)
		}(i, c[0], c[1])
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(95 * time.Second):
	}
	var best RouteResult
	for _, r := range results {
		if !r.OK {
			continue
		}
		if len(r.Data) > 0 {
			var parsed struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if json.Unmarshal(r.Data, &parsed) == nil && len(parsed.Choices) > 0 {
				content := parsed.Choices[0].Message.Content
				if isAST(content) {
					m.StickySet(session, r.Provider, r.Model)
					m.Record(r.Model, r.Provider, 200, r.Lat, 1, strategy, session)
					return r
				}
			}
		}
		if !best.OK {
			best = r
		}
	}
	if best.OK {
		m.StickySet(session, best.Provider, best.Model)
		return best
	}
	return RouteResult{Status: 503, Err: strategy + "_exhausted"}
}

var strategies = map[string]strategyFunc{
	"hybrid":          routeHybrid,
	"ast_race":        routeAstRace,
	"sticky_affinity": routeSticky,
	"weighted_elo":    routeWeighted,
	"circuit_chain":   routeCircuitChain,
	"fifo_matrix":     routeFifo,
	"free":            routeFree,
}

func getModel(body map[string]interface{}) string {
	if m, ok := body["model"].(string); ok {
		return m
	}
	return "auto"
}

func extractModelFromBody(r *http.Request) string {
	if r.Body == nil || r.Method != http.MethodPost {
		return ""
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return ""
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var parsed struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	return parsed.Model
}
