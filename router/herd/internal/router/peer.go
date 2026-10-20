package router

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mostlygeek/herd/internal/config"
	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/swaputil"
)

type peerMember struct {
	peerID       string
	reverseProxy *httputil.ReverseProxy
	apiKey       string
}

type peerRoute struct {
	member  *peerMember
	modelID string
}

type Peer struct {
	cfg    config.Config
	logger *logmon.Monitor
	peers  map[string]*peerRoute

	mu     sync.RWMutex
	health map[string]*PeerHealth

	shutdownCtx  context.Context
	shutdownFn   context.CancelFunc
	shuttingDown atomic.Bool
	inflight     sync.WaitGroup
}

func NewPeer(cfg config.Config, logger *logmon.Monitor) (*Peer, error) {
	if err := config.ValidatePeerNamespace(cfg); err != nil {
		return nil, err
	}

	peers := cfg.Peers
	modelMap := make(map[string]*peerRoute)
	bareRoutes := make(map[string][]*peerRoute)

	peerIDs := make([]string, 0, len(peers))
	for peerID := range peers {
		peerIDs = append(peerIDs, peerID)
	}
	sort.Strings(peerIDs)

	health := make(map[string]*PeerHealth, len(peerIDs))
	for _, peerID := range peerIDs {
		hc := peers[peerID].Health
		// ApplyDefaults fills unset fields and preserves explicitly
		// configured ones. Replacing the whole struct when Enabled is
		// nil discarded FailureThreshold/Weights, so peers never
		// ejected under a partially-specified health config.
		hc.ApplyDefaults()
		health[peerID] = NewPeerHealth(peerID, hc, logger)
	}

	for _, peerID := range peerIDs {
		peer := peers[peerID]

		peerTransport := &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   time.Duration(peer.Timeouts.Connect) * time.Second,
				KeepAlive: time.Duration(peer.Timeouts.KeepAlive) * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   time.Duration(peer.Timeouts.TLSHandshake) * time.Second,
			ResponseHeaderTimeout: time.Duration(peer.Timeouts.ResponseHeader) * time.Second,
			ExpectContinueTimeout: time.Duration(peer.Timeouts.ExpectContinue) * time.Second,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       time.Duration(peer.Timeouts.IdleConn) * time.Second,
		}

		reverseProxy := &httputil.ReverseProxy{
			Transport: peerTransport,
			Rewrite: func(r *httputil.ProxyRequest) {
				r.SetURL(peer.ProxyURL)
				r.Out.Host = r.Out.URL.Host
				// Debug: log outgoing URL (only when debug level)
			},
		}

		reverseProxy.ModifyResponse = func(resp *http.Response) error {
			if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
				resp.Header.Set("X-Accel-Buffering", "no")
			}
			// Health observation: classify the outcome from the actual
			// response. A non-2xx status is immediately classifiable; a
			// 2xx body is observed through to EOF so the 200-empty
			// honesty check sees the real bytes. Exactly-once is
			// enforced by the observer itself.
			if obs := healthObserverFrom(resp.Request.Context()); obs != nil {
				if resp.StatusCode < 200 || resp.StatusCode >= 300 {
					obs.finishStatus(resp.StatusCode)
				} else {
					obs.status = resp.StatusCode
					if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
						obs.streaming = true
					}
					resp.Body = &observingReadCloser{ReadCloser: resp.Body, obs: obs}
				}
			}
			return nil
		}

		reverseProxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			// Health observation: a proxy-level error is a transport
			// outcome (or a neutral cancel when the client went away).
			if obs := healthObserverFrom(r.Context()); obs != nil {
				obs.finishTransport(err)
			}
			// A cancelled request is not a peer failure, so keep it out of the
			// warning stream whether or not the sentinel applies below.
			if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
				logger.Debugf("peer %s: request cancelled: %v", peerID, err)
			} else {
				logger.Warnf("peer %s: proxy error: %v", peerID, err)
			}

			// Only a client that actually hung up gets the recorded-only
			// sentinel (#1029). A request cancelled server-side still has a
			// client waiting for an answer.
			if swaputil.MarkClientClosed(w, r) || swaputil.ResponseStarted(w) {
				return
			}

			errMsg := fmt.Sprintf("peer proxy error: %v", err)
			if runtime.GOOS == "darwin" && strings.Contains(err.Error(), "connect: no route to host") {
				errMsg += " (hint: on macOS, check System Settings > Privacy & Security > Local Network permissions)"
			}
			swaputil.SendResponse(w, r, http.StatusBadGateway, errMsg)
		}

		pp := &peerMember{
			peerID:       peerID,
			reverseProxy: reverseProxy,
			apiKey:       peer.ApiKey,
		}

		seen := make(map[string]struct{})
		for _, modelID := range peer.Models {
			if _, duplicate := seen[modelID]; duplicate {
				continue
			}
			seen[modelID] = struct{}{}

			route := &peerRoute{member: pp, modelID: modelID}
			modelMap[config.PeerModelFQN(peerID, modelID)] = route
			bareRoutes[modelID] = append(bareRoutes[modelID], route)
		}
	}

	for modelID, routes := range bareRoutes {
		if len(routes) != 1 {
			continue
		}
		if _, reserved := modelMap[modelID]; reserved {
			continue
		}
		modelMap[modelID] = routes[0]
	}

	shutdownCtx, shutdownFn := context.WithCancel(context.Background())

	return &Peer{
		cfg:         cfg,
		logger:      logger,
		peers:       modelMap,
		health:      health,
		shutdownCtx: shutdownCtx,
		shutdownFn:  shutdownFn,
	}, nil
}

func (r *Peer) Handles(model string) bool {
	_, ok := r.peers[model]
	return ok
}

func (r *Peer) Shutdown(timeout time.Duration) error {
	if !r.shuttingDown.CompareAndSwap(false, true) {
		return fmt.Errorf("shutdown already in progress")
	}

	if timeout == 0 {
		r.shutdownFn()
		r.inflight.Wait()
		return nil
	}

	done := make(chan struct{})
	go func() {
		r.inflight.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-time.After(timeout):
		r.shutdownFn()
		r.inflight.Wait()
		return fmt.Errorf("peer shutdown timed out after %v", timeout)
	}
}

func (r *Peer) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if r.shuttingDown.Load() {
		swaputil.SendError(w, req, fmt.Errorf("peer proxy is shutting down"))
		return
	}
	r.inflight.Add(1)
	defer r.inflight.Done()

	data, err := swaputil.FetchContext(req, r.cfg)
	if err != nil {
		swaputil.SendError(w, req, err)
		return
	}

	route, found := r.peers[data.ModelID]
	if !found {
		r.logger.Warnf("peer model not found: %s", data.ModelID)
		swaputil.SendError(w, req, ErrNoPeerModelFound)
		return
	}
	pp := route.member

	// Health admission: an ejected peer fails fast with 503 instead
	// of burning a backend call. Admitted requests carry a health
	// observer (in the request context) that reports exactly one
	// outcome when the proxied response completes or fails.
	if ph, ok := r.health[pp.peerID]; ok && ph != nil {
		admit, probe, gen := ph.Admit()
		if !admit {
			swaputil.SendResponse(w, req, http.StatusServiceUnavailable,
				"peer_circuit_open: peer ejected by health monitor; retry later")
			return
		}
		obs := newHealthObserver(ph, req, false, probe, gen)
		req = req.WithContext(context.WithValue(req.Context(), healthObserverKey{}, obs))
	}

	r.logger.Debugf("peer: routing model %s to peer %s as %s (free=%v)", data.ModelID, pp.peerID, route.modelID, pp.apiKey == "")

	if data.Model != route.modelID {
		req, err = swaputil.ReplaceRequestModel(req, data.Model, route.modelID)
		if err != nil {
			swaputil.SendResponse(w, req, http.StatusBadRequest, err.Error())
			return
		}
	}

	if pp.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+pp.apiKey)
		req.Header.Set("x-api-key", pp.apiKey)
	} else {
		// Workaround for "not anonymous" gate (Pollinations now requires any Bearer to avoid 401).
		// We ignore anonymous distinction entirely: inject dummy Bearer so free tier always passes.
		// ponytail: dummy bearer for free backends; use real key via peer.apiKey if rate-limit matters
		req.Header.Set("Authorization", "Bearer pollinations-free-workaround")
		req.Header.Set("x-api-key", "pollinations-free-workaround")
	}
	r.logger.Debugf("peer: outgoing Authorization=%s Host=%s Path=%s", req.Header.Get("Authorization"), req.Host, req.URL.Path)
	// Cancel the proxy request when the client disconnects or shutdown times out.
	// Deriving from the request covers the client half directly and keeps the
	// request's context values — notably the client context that tells a real
	// disconnect apart from a server-side cancel. AfterFunc links the unrelated
	// shutdown context in without a goroutine leak.
	ctx, cancel := context.WithCancel(req.Context())
	stopShutdown := context.AfterFunc(r.shutdownCtx, cancel)
	req = req.WithContext(ctx)

	pp.reverseProxy.ServeHTTP(w, req)

	stopShutdown()
	cancel()
}

// HealthSnapshots returns the current health view of every peer this Peer
// fronts, keyed by peer ID. Test/observability bridge.
func (pr *Peer) HealthSnapshots() []HealthSnapshot {
	pr.mu.RLock()
	defer pr.mu.RUnlock()
	out := make([]HealthSnapshot, 0, len(pr.health))
	for _, ph := range pr.health {
		out = append(out, ph.Snapshot())
	}
	return out
}
