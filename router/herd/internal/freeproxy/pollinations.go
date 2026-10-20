package freeproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// PollinationsProvider proxies to https://gen.pollinations.ai.
// Anonymous models (openai, gpt-oss) are served with NO Authorization header at
// all (verified live 2026-09-30). A real POLLINATIONS_API_KEY/POLLINATIONS_KEY
// unlocks the key-gated set. There is no dummy Bearer anymore — it was
// obsolete and misleading.
// Falls back to https://text.pollinations.ai when gen returns 401/429.
type PollinationsProvider struct {
	base      string
	textBase  string
	apiKey    string
	proxy     *httputil.ReverseProxy
	textProxy *httputil.ReverseProxy
	models    []string
	modelSet  map[string]struct{}
	limiter   RateLimiter
	cache     Cache
}

// anonymousModels are live-verified (2026-09-30) to return 200 with NO
// Authorization header. keyGatedModels 401 anonymously and unlock only with a
// real POLLINATIONS_API_KEY. Upstream availability shifts over time; when in
// doubt re-probe gen.pollinations.ai/v1/chat/completions per model.
var anonymousModels = []string{"openai", "gpt-oss"}

var keyGatedModels = []string{
	"gemma-4-31b", "qwen3.8-27b", "muse-glimmer", "muse-spark-1.2",
	"nemotron-3.5-lightning", "kimi-k3", "glm-5.3", "grok-4.6",
	"deepseek/deepseek-v4-flash-vision-exp",
}

func anonymousModelSet(apiKey string) []string {
	if apiKey != "" {
		all := make([]string, 0, len(anonymousModels)+len(keyGatedModels))
		all = append(all, anonymousModels...)
		return append(all, keyGatedModels...)
	}
	out := make([]string, len(anonymousModels))
	copy(out, anonymousModels)
	return out
}

func NewPollinationsProvider(limiter RateLimiter, cache Cache) *PollinationsProvider {
	base := "https://gen.pollinations.ai"
	textBase := "https://text.pollinations.ai"
	// Prefer env key if set (real pollen key from https://enter.pollinations.ai/keys)
	apiKey := os.Getenv("POLLINATIONS_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("POLLINATIONS_KEY")
	}
	// REMOVED 2026-09-30: dummy Bearer workaround. Upstream serves anonymous
	// models with zero auth; the dummy was dead weight.
	// ponytail: dummy bearer for free backends; use real key via POLLINATIONS_API_KEY if rate-limit matters
	baseURL, _ := url.Parse(base)
	textURL, _ := url.Parse(textBase)

	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        20,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	}

	p := &PollinationsProvider{
		base:     base,
		textBase: textBase,
		apiKey:   apiKey,
		models:   anonymousModelSet(apiKey),
		modelSet: make(map[string]struct{}),
		limiter:  limiter,
		cache:    cache,
	}
	for _, m := range p.models {
		p.modelSet[m] = struct{}{}
	}

	p.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(baseURL)
			r.Out.Host = r.Out.URL.Host
			// Anonymous when no key: upstream serves the anonymous set with
			// no auth at all. Only inject Bearer for a real configured key.
			// Also strip any client-supplied auth so client keys never leak upstream.
			if p.apiKey != "" {
				r.Out.Header.Set("Authorization", "Bearer "+p.apiKey)
				r.Out.Header.Set("x-api-key", p.apiKey)
			} else {
				r.Out.Header.Del("Authorization")
				r.Out.Header.Del("x-api-key")
			}
			// Preserve content-type, strip client auth leakage
			r.Out.Header.Set("Content-Type", "application/json")
		},
		ModifyResponse: func(resp *http.Response) error {
			if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
				resp.Header.Set("X-Accel-Buffering", "no")
			}
			return nil
		},
	}

	p.textProxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(textURL)
			r.Out.Host = r.Out.URL.Host
			if p.apiKey != "" {
				r.Out.Header.Set("Authorization", "Bearer "+p.apiKey)
				r.Out.Header.Set("x-api-key", p.apiKey)
			} else {
				r.Out.Header.Del("Authorization")
				r.Out.Header.Del("x-api-key")
			}
		},
	}

	return p
}

func (p *PollinationsProvider) ID() string       { return "pollinations-free" }
func (p *PollinationsProvider) BaseURL() string  { return p.base }
func (p *PollinationsProvider) Models() []string { return p.models }
func (p *PollinationsProvider) Handles(model string) bool {
	_, ok := p.modelSet[model]
	return ok
}
func (p *PollinationsProvider) Health(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", p.base+"/v1/models", nil)
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func (p *PollinationsProvider) Proxy(w http.ResponseWriter, r *http.Request) error {
	// Rate-limit gate (Pollinations ~1 req/15s anon) — if limiter says no, we still proxy but add header
	if p.limiter != nil && !p.limiter.Allow(p.ID()) {
		w.Header().Set("X-FreeProxy-RateLimited", "1")
		w.Header().Set("Retry-After", "15")
	}

	// Try cache for non-streaming POSTs (CF gateway style)
	if p.cache != nil && r.Method == "POST" && r.URL.Path == "/v1/chat/completions" {
		bodyBytes, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		// Simple cache key: model + body hash (naive, ponytail)
		key := p.ID() + ":" + string(bodyBytes[:min(200, len(bodyBytes))])
		if cached, ok := p.cache.Get(key); ok {
			w.Header().Set("X-Cache", "HIT")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			w.Write(cached)
			return nil
		}
		// On miss, capture response for caching (only 200s)
		rec := &cacheRecorder{ResponseWriter: w, body: &bytes.Buffer{}, status: 200}
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		// Clone request for text fallback if needed
		origBody := make([]byte, len(bodyBytes))
		copy(origBody, bodyBytes)

		p.proxy.ServeHTTP(rec, r)
		if rec.status == 401 || rec.status == 429 {
			// Fallback to text.pollinations.ai which still serves anonymous
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/openai" // text endpoint style
			r2.Body = io.NopCloser(bytes.NewReader(origBody))
			p.textProxy.ServeHTTP(w, r2)
			return nil
		}
		if rec.status == 200 && p.cache != nil {
			// Cache 60s for repeated prompts (CF edge style)
			p.cache.Set(key, rec.body.Bytes(), 60*time.Second)
		}
		return nil
	}

	// Non-cache path or streaming — direct proxy with fallback
	rec := &statusRecorder{ResponseWriter: w, status: 200}
	p.proxy.ServeHTTP(rec, r)
	if rec.status == 401 || rec.status == 429 {
		// Fallback to text endpoint on auth/rate errors
		r2 := r.Clone(r.Context())
		p.textProxy.ServeHTTP(w, r2)
	}
	return nil
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

type cacheRecorder struct {
	http.ResponseWriter
	body   *bytes.Buffer
	status int
}

func (c *cacheRecorder) WriteHeader(code int) {
	c.status = code
	c.ResponseWriter.WriteHeader(code)
}
func (c *cacheRecorder) Write(b []byte) (int, error) {
	c.body.Write(b)
	return c.ResponseWriter.Write(b)
}
func (c *cacheRecorder) Header() http.Header { return c.ResponseWriter.Header() }

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Pollinations direct fallback helper for JSON body rewriting (model alias)
func rewriteModel(body []byte, from, to string) []byte {
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return body
	}
	if m["model"] == from {
		m["model"] = to
		if b, err := json.Marshal(m); err == nil {
			return b
		}
	}
	return body
}
