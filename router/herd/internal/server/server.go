package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mostlygeek/herd/internal/astmatrix"
	"github.com/mostlygeek/herd/internal/capcompat"
	"github.com/mostlygeek/herd/internal/chain"
	"github.com/mostlygeek/herd/internal/config"
	"github.com/mostlygeek/herd/internal/docagent"
	"github.com/mostlygeek/herd/internal/event"
	"github.com/mostlygeek/herd/internal/freeproxy"
	"github.com/mostlygeek/herd/internal/hw"
	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/mcptools"
	"github.com/mostlygeek/herd/internal/perf"
	"github.com/mostlygeek/herd/internal/process"
	"github.com/mostlygeek/herd/internal/router"
	"github.com/mostlygeek/herd/internal/store"
	"github.com/mostlygeek/herd/internal/swaputil"
)

// Server owns the HTTP mux, cross-cutting middleware, and the local/peer model
// dispatch. It supersedes router.Server: it builds the local and peer routers
// directly and dispatches between them itself.
type Server struct {
	cfg config.Config

	muxlog      *logmon.Monitor
	proxylog    *logmon.Monitor
	upstreamlog *logmon.Monitor

	perf     *perf.Monitor
	inflight *inflightTracker
	metrics  *metricsMonitor
	store    store.Store
	hardware *hw.HardwareSnapshot

	// reference is herd's own embedded documentation, served to the
	// Playground's agentic chat and to external MCP clients through /api/mcp.
	// It is immutable and independent of cfg, so the same library is shared
	// across the Server instances a hot config reload creates. A nil value
	// disables the endpoint; Docs methods are nil-receiver safe.
	reference *docagent.Docs

	// tools is the MCP tool surface served at /api/mcp. Providers are
	// aggregated here rather than enumerated in the handler, so a future
	// provider that proxies an upstream MCP endpoint plugs in without
	// touching the transport.
	tools *mcptools.Registry

	profileMu     sync.RWMutex
	activeProfile string

	build     BuildInfo
	local     router.LocalRouter
	peer      router.Router
	cloud     *astmatrix.Router   // cloud model routing via AST Matrix
	freeproxy *freeproxy.Registry // maximal modular free providers (pollinations, ovh, openrouter, cf-gw) — borrows tau providers

	// modelEvents broadcasts the /models/sse feed Zed's llama.cpp
	// provider subscribes to. The proxy owns model lifecycle truth,
	// so it synthesizes loaded/unloaded/loading events even when a
	// backend does not speak /models/sse itself.
	modelEvents *modelEventBroadcaster

	// capcompat holds model capabilities discovered from upstream servers.
	// It is refreshed when a model becomes ready and read by /v1/models, so
	// an unloaded model still advertises what it can do. A nil value disables
	// discovery; Service methods are nil-receiver safe.
	capcompat *capcompat.Service

	// capcompatCancel unsubscribes the process-state listener that drives
	// discovery. The event dispatcher is process-wide, so a hot config reload
	// would otherwise leave the retired Server probing alongside the new one.
	capcompatCancel context.CancelFunc
	mux             *http.ServeMux
	handler         http.Handler

	shutdownCtx  context.Context
	shutdownFn   context.CancelFunc
	shuttingDown atomic.Bool
}

// ActiveProfile returns the active runtime profile, or an empty string when no
// profile is active.
func (s *Server) ActiveProfile() string {
	s.profileMu.RLock()
	defer s.profileMu.RUnlock()
	return s.activeProfile
}

// setActiveProfile updates the runtime selection. An empty name deactivates
// profiles. It returns whether the selection changed.
func (s *Server) setActiveProfile(name string) (bool, error) {
	if name != "" {
		if _, ok := s.cfg.Profiles[name]; !ok {
			return false, fmt.Errorf("profile %q not found", name)
		}
	}
	s.profileMu.Lock()
	if s.activeProfile == name {
		s.profileMu.Unlock()
		return false, nil
	}
	s.activeProfile = name
	s.profileMu.Unlock()

	s.proxylog.Infof("active profile changed to %q", name)
	event.Emit(swaputil.ProfileChangedEvent{Active: name})
	return true, nil
}

// modelPostJSONRoutes are endpoints with a model id in the JSON request body.
var modelPostJSONRoutes = []string{
	"/v1/chat/completions",
	"/v1/responses",
	"/v1/completions",
	"/v1/messages",
	"/v1/messages/count_tokens",
	"/v1/embeddings",
	"/reranking",
	"/rerank",
	"/v1/rerank",
	"/v1/reranking",
	"/infill",
	"/completion",
	"/v1/audio/speech",
	"/v1/audio/voices",
	"/v1/images/generations",
	"/sdapi/v1/txt2img",
	"/sdapi/v1/img2img",

	// audio.cpp generic task API
	"/audioapi/v1/tasks/run",

	// versionless routes, the /v/ is stripped before the request is forwarded upstream
	// see issue #728
	"/v/chat/completions",
	"/v/responses",
	"/v/completions",
	"/v/messages",
	"/v/messages/count_tokens",
	"/v/embeddings",
	"/v/rerank",
	"/v/reranking",
}

// modelPostFormRoutes are multipart/form-data endpoints with a model id in the form data
var modelPostFormRoutes = []string{
	"/v1/audio/transcriptions",
	"/v1/images/edits",
}

// modelGetRoutes are model-dispatched GET endpoints (the model arrives as a
// query parameter).
var modelGetRoutes = []string{
	"/v1/audio/voices",
	"/sdapi/v1/loras",
	"/props",
}

// isMetricsRecordPath reports whether path is one of the model-dispatched
// endpoints that the metrics middleware records in the activity log.
func isMetricsRecordPath(path string) bool {
	for _, p := range modelPostJSONRoutes {
		if p == path {
			return true
		}
	}
	for _, p := range modelPostFormRoutes {
		if p == path {
			return true
		}
	}
	for _, p := range modelGetRoutes {
		if p == path {
			return true
		}
	}
	return false
}

// BuildInfo carries version metadata surfaced by GET /api/version.
type BuildInfo struct {
	Version string
	Commit  string
	Date    string
}

func New(cfg config.Config, muxlog *logmon.Monitor, proxylog *logmon.Monitor, upstreamlog *logmon.Monitor, perfMon *perf.Monitor, st store.Store, build BuildInfo, hardware *hw.HardwareSnapshot, refs *docagent.Docs) (*Server, error) {
	var local router.LocalRouter
	var err error

	switch cfg.Routing.Router.Use {
	case "matrix":
		local, err = router.NewMatrix(cfg, proxylog, upstreamlog)
		if err != nil {
			return nil, fmt.Errorf("creating matrix router: %w", err)
		}
	default: // "group"
		local, err = router.NewGroup(cfg, proxylog, upstreamlog)
		if err != nil {
			return nil, fmt.Errorf("creating group router: %w", err)
		}
	}

	peer, err := router.NewPeer(cfg, proxylog)
	if err != nil {
		return nil, fmt.Errorf("creating peer router: %w", err)
	}
	// Maximal modular freeproxy (pollinations, ovh, openrouter, cf-gw) — borrows tau providers concept
	// Default cache is global home/toxic: $HOME/cache/freeproxy (estate-scripts global, not /tmp)
	freeproxyRegistry := freeproxy.NewRegistry(freeproxy.NewMemoryLimiter(15*time.Second), freeproxy.NewGlobalCache())
	proxylog.Infof("freeproxy modular enabled: providers=%d models=%d cache=%s", len(freeproxyRegistry.Models()), len(freeproxyRegistry.Models()), "home/toxic/cache/freeproxy")

	// Initialize cloud router (AST Matrix) if configured.
	var cloud *astmatrix.Router
	if cfg.AstMatrix != nil && cfg.AstMatrix.Enabled {
		amCfg := &astmatrix.AstMatrixConfig{
			Enabled:     cfg.AstMatrix.Enabled,
			Strategy:    cfg.AstMatrix.Strategy,
			MaxParallel: cfg.AstMatrix.MaxParallel,
			DbPath:      cfg.AstMatrix.DbPath,
			StickyTTL:   cfg.AstMatrix.StickyTTL,
			FifoMax:     cfg.AstMatrix.FifoMax,
		}
		amCfg.Providers = make(map[string]astmatrix.ProviderCfg)
		for name, pcfg := range cfg.AstMatrix.Providers {
			amCfg.Providers[name] = astmatrix.ProviderCfg{
				BaseURL:   pcfg.BaseURL,
				KeyEnv:    pcfg.KeyEnv,
				KeyEnvAlt: pcfg.KeyEnvAlt,
				NoAuth:    pcfg.NoAuth,
			}
		}
		cloud, err = astmatrix.NewRouter(amCfg)
		if err != nil {
			return nil, fmt.Errorf("creating astmatrix router: %w", err)
		}
		proxylog.Infof("astmatrix cloud router enabled: strategy=%s providers=%d", cfg.AstMatrix.Strategy, len(cloud.Matrix().Providers()))
	}

	if st == nil {
		return nil, fmt.Errorf("store is required")
	}

	shutdownCtx, shutdownFn := context.WithCancel(context.Background())
	s := &Server{
		cfg:           cfg,
		muxlog:        muxlog,
		proxylog:      proxylog,
		upstreamlog:   upstreamlog,
		perf:          perfMon,
		inflight:      newInflightTracker(),
		metrics:       newMetricsMonitor(proxylog, cfg.MetricsMaxInMemory, cfg.CaptureBuffer, st),
		store:         st,
		build:         build,
		hardware:      hardware,
		reference:     refs,
		activeProfile: cfg.Hooks.OnStartup.Profile,
		local:         local,
		peer:          peer,
		cloud:         cloud,
		freeproxy:     freeproxyRegistry,
		modelEvents:   newModelEventBroadcaster(muxlog),
		shutdownCtx:   shutdownCtx,
		shutdownFn:    shutdownFn,
	}
	// SysProvider is constructed here because this is where perf and hardware
	// are in scope; wiring those in later is a change to internal/mcptools.
	tools, err := mcptools.New(
		docagent.NewDocsProvider(refs),
		mcptools.NewSysProvider(nil),
		config.NewConfigProvider(cfg),
	)
	if err != nil {
		return nil, fmt.Errorf("building the MCP tool registry: %w", err)
	}
	s.tools = tools

	s.routes()
	s.startPreload()
	// Continuously reconcile model load/unload state and broadcast transitions
	// Initialize capcompat and its cancel func.
	s.capcompat = capcompat.New(s.store.Cache(), proxylog)
	// on /models/sse so subscribers (e.g. Zed's llama.cpp provider) see models
	// appear/disappear as they are loaded on demand or unloaded — not just at
	// subscribe time. statusEvent dedupes against lastStatus, so only real
	// transitions are emitted.
	go s.watchModelState(3 * time.Second)
	return s, nil
}

// watchModelState polls the local router's running models and broadcasts a
// loaded/unloaded transition whenever a model's state changes. It stops when
// the server shuts down.
func (s *Server) watchModelState(interval time.Duration) {
	if s.local == nil {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.shutdownCtx.Done():
			return
		case <-ticker.C:
			running := s.local.RunningModels()
			seen := make(map[string]struct{}, len(running))
			for id, st := range running {
				seen[id] = struct{}{}
				switch st {
				case process.StateReady, process.StateStarting:
					s.modelEvents.statusEvent(id, "loaded", nil)
				default:
					s.modelEvents.statusEvent(id, "unloaded", nil)
				}
			}
			// Emit unloaded for any model previously marked loaded but no
			// longer in the running set (on-demand unload removes it entirely).
			s.modelEvents.reconcileMissing(seen)
		}
	}
}

// localPeerHandler dispatches a model-routed request to the local or peer
// router. The model is resolved once via swaputil.FetchContext.
func (s *Server) localPeerHandler(w http.ResponseWriter, r *http.Request) {
	stripVersionPrefix(r)
	stripAudioAPIPrefix(r)

	data, err := swaputil.FetchContext(r, s.cfg)
	if err != nil {
		swaputil.SendError(w, r, swaputil.ErrNoModelInContext)
		return
	}

	switch {
	case s.local.Handles(data.ModelID):
		s.proxylog.Debugf("dispatch: using local process for model: %s", data.ModelID)
		s.local.ServeHTTP(w, r)
	case s.freeproxy != nil && s.freeproxy.Handles(data.ModelID):
		if p, ok := s.freeproxy.ProviderFor(data.ModelID); ok {
			s.proxylog.Debugf("dispatch: using freeproxy %s for model: %s", p.ID(), data.ModelID)
			p.Proxy(w, r)
			return
		}
		swaputil.SendError(w, r, router.ErrNoRouterFound)
	case s.peer.Handles(data.ModelID):
		s.proxylog.Debugf("dispatch: using peer for model: %s", data.ModelID)
		s.peer.ServeHTTP(w, r)
	case s.cloud != nil && s.cloud.Handles(data.ModelID):
		s.proxylog.Debugf("dispatch: using cloud matrix for model: %s", data.ModelID)
		s.cloud.ServeHTTP(w, r)
	default:
		swaputil.SendError(w, r, router.ErrNoRouterFound)
	}
}

// stripVersionPrefix rewrites versionless /v/... requests to their /... form
// before forwarding upstream (issue #728).
func stripVersionPrefix(r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/v/") {
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/v")
	}
}

// stripAudioAPIPrefix rewrites /audioapi/... requests to their /... form
// before forwarding upstream, so /audioapi/v1/tasks/run reaches the upstream
// as /v1/tasks/run.
func stripAudioAPIPrefix(r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/audioapi") {
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/audioapi")
	}
}

// routes builds the mux, registers every route, and wraps the mux with the
// global CORS middleware.
func (s *Server) routes() {

	authMW := CreateAuthMiddleware(s.cfg)
	modelChain := chain.New(
		authMW,
		CreateProfileMiddleware(s),
		CreateSelectorMiddleware(s),
		CreateRequestContextMiddleware(s.cfg),
		CreateInflightMiddleware(s.inflight, s.cfg),
		CreateFilterMiddleware(s.cfg),
		CreateFormFilterMiddleware(s.cfg),
		CreateMetricsMiddleware(s.metrics, s.cfg),
	)
	// Custom endpoints only need auth.
	apiChain := chain.New(authMW)

	mux := http.NewServeMux()
	dispatch := http.HandlerFunc(s.localPeerHandler)

	for _, path := range modelPostJSONRoutes {
		mux.Handle("POST "+path, modelChain.Then(dispatch))
	}
	for _, path := range modelPostFormRoutes {
		mux.Handle("POST "+path, modelChain.Then(dispatch))
	}
	for _, path := range modelGetRoutes {
		mux.Handle("GET "+path, modelChain.Then(dispatch))
	}

	// herd API + custom endpoints.
	mux.Handle("GET /v1/models", apiChain.ThenFunc(s.handleListModels))
	mux.Handle("GET /models", apiChain.ThenFunc(s.handleListModels))
	// llama.cpp-compatible model event feed (Zed /models/sse consumer).
	mux.Handle("GET /models/sse", apiChain.ThenFunc(s.handleModelEvents))
	mux.Handle("GET /logs", apiChain.ThenFunc(s.handleLogs))
	mux.Handle("GET /logs/stream", apiChain.ThenFunc(s.handleLogStream))
	mux.Handle("GET /logs/stream/{logMonitorID...}", apiChain.ThenFunc(s.handleLogStream))

	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /wol-health", handleHealth)
	mux.HandleFunc("GET /{$}", handleRootRedirect)

	// Embedded UI.
	mux.Handle("GET /ui/", chain.New(authMW).ThenFunc(s.handleUI))
	mux.HandleFunc("GET /favicon.ico", s.handleFavicon)

	// Prometheus metrics (wrapped by apiChain, matches the legacy endpoint).
	mux.Handle("GET /metrics", apiChain.ThenFunc(s.handleMetrics))

	// Operations endpoints.
	mux.Handle("GET /unload", apiChain.ThenFunc(s.handleUnload))
	mux.Handle("GET /running", apiChain.ThenFunc(s.handleRunning))

	// Upstream passthrough. Meter only the model-dispatched endpoints that can
	// produce token usage/timings.
	upstreamChain := apiChain.Append(
		CreateProfileMiddleware(s),
		CreateUpstreamInflightMiddleware(s.inflight, s.cfg),
		CreateMetricsMiddleware(s.metrics, s.cfg),
	)
	mux.HandleFunc("GET /upstream", handleUpstreamRedirect)
	mux.Handle("/upstream/{upstreamPath...}", upstreamChain.ThenFunc(s.handleUpstream))

	// ComfyUI compatibility passthrough. This uses the fixed comfyui_auto model,
	// whose compatibility settings are applied while loading config. Only the
	// root path may start an unloaded model.
	mux.Handle("/comfyui", apiChain.ThenFunc(handleComfyUIRedirect))
	mux.Handle("/comfyui/{comfyPath...}", apiChain.ThenFunc(s.handleComfyUI))

	// API group (API-key protected) consumed by the UI.
	mux.Handle("POST /api/models/unload", apiChain.ThenFunc(s.handleAPIUnloadAll))
	mux.Handle("POST /api/models/unload/{model...}", apiChain.ThenFunc(s.handleAPIUnloadModel))
	mux.Handle("GET /api/profiles", apiChain.ThenFunc(s.handleAPIProfiles))
	mux.Handle("PUT /api/profiles/active", apiChain.ThenFunc(s.handleAPIActiveProfile))
	mux.Handle("POST /api/inflight/{id}/cancel", apiChain.ThenFunc(s.handleAPICancelInflight))
	mux.Handle("GET /api/events", apiChain.ThenFunc(s.handleAPIEvents))
	mux.Handle("GET /api/metrics/activity", apiChain.ThenFunc(s.handleAPIActivity))
	mux.Handle("GET /api/metrics/stats", apiChain.ThenFunc(s.handleAPIActivityStats))
	mux.Handle("GET /api/performance", apiChain.ThenFunc(s.handleAPIPerformance))
	mux.Handle("GET /api/version", apiChain.ThenFunc(s.handleAPIVersion))
	mux.Handle("GET /api/hardware", apiChain.ThenFunc(s.handleAPIHardware))
	mux.Handle("GET /api/captures/{id}", apiChain.ThenFunc(s.handleAPICapture))

	// Stateless MCP server exposing herd's own documentation as tools,
	// consumed by the Playground's agentic chat and by any external MCP client.
	// Registered without a method so non-POST reaches the handler and gets a
	// 405 with Allow, rather than the mux's bare 404.
	mux.Handle("/api/mcp", apiChain.ThenFunc(s.handleAPIMCP))

	s.mux = mux
	s.handler = chain.New(CreateRequestLogMiddleware(s.proxylog), CreateCORSMiddleware(s.cfg)).Then(mux)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// CloseStreams cancels long-lived response streams (Server-Sent Events) so a
// graceful httpServer.Shutdown can drain without blocking on them. It does not
// tear down routers; call Shutdown for that. Safe to call repeatedly.
func (s *Server) CloseStreams() {
	s.shutdownFn()
	if s.capcompatCancel != nil {
		s.capcompatCancel()
	}
}

// Shutdown stops the local and peer routers in parallel. It is idempotent;
// repeated calls return nil without re-running shutdown.
//
// Callers must drain inflight HTTP requests (httpServer.Shutdown) before
// calling this, otherwise inflight requests 502 when their processes are torn
// down. Call CloseStreams before httpServer.Shutdown so SSE streams do not
// block the drain.
func (s *Server) Shutdown(timeout time.Duration) error {
	if !s.shuttingDown.CompareAndSwap(false, true) {
		return nil
	}
	s.shutdownFn()
	if s.capcompatCancel != nil {
		s.capcompatCancel()
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	var errs []error

	// Server.Shutdown is a closed list: anything holding resources that is not
	// released here leaks. The tool registry is cheap today and expensive once
	// a provider holds upstream connections or subprocesses.
	if err := s.tools.Shutdown(timeout); err != nil {
		errs = append(errs, err)
	}

	for _, rt := range []router.Router{s.local, s.peer} {
		if rt == nil {
			continue
		}
		wg.Add(1)
		go func(rt router.Router) {
			defer wg.Done()
			if err := rt.Shutdown(timeout); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}(rt)
	}

	// Close the cloud router's health database.
	if s.cloud != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.cloud.Close(); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}

	wg.Wait()
	return errors.Join(errs...)
}
