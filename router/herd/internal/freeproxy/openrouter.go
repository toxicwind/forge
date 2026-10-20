package freeproxy

import (
	"context"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

// OpenRouterProvider proxies to OpenRouter free tier (requires free-tier API key, no card).
// It is disabled if OPENROUTER_API_KEY is not free-tier or missing.
type OpenRouterProvider struct {
	base     string
	apiKey   string
	proxy    *httputil.ReverseProxy
	models   []string
	modelSet map[string]struct{}
}

func NewOpenRouterProvider() *OpenRouterProvider {
	base := "https://openrouter.ai/api/v1"
	apiKey := os.Getenv("OPENROUTER_API_KEY")
	u, _ := url.Parse(base)
	transport := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		ForceAttemptHTTP2: true,
		IdleConnTimeout:   90 * time.Second,
	}
	p := &OpenRouterProvider{
		base:   base,
		apiKey: apiKey,
		models: []string{
			"nvidia/nemotron-3-ultra-550b-a55b:free",
			"google/gemma-4-31b-it:free",
			"poolside/laguna-m.1:free",
			"google/gemma-3-27b-it:free",
		},
		modelSet: make(map[string]struct{}),
	}
	for _, m := range p.models {
		p.modelSet[m] = struct{}{}
	}
	p.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(u)
			r.Out.Host = r.Out.URL.Host
			if p.apiKey != "" {
				r.Out.Header.Set("Authorization", "Bearer "+p.apiKey)
				r.Out.Header.Set("x-api-key", p.apiKey)
				r.Out.Header.Set("HTTP-Referer", "https://github.com/toxicwind/herd")
				r.Out.Header.Set("X-Title", "Herd estate-scripts")
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
				resp.Header.Set("X-Accel-Buffering", "no")
			}
			return nil
		},
	}
	return p
}

func (o *OpenRouterProvider) ID() string       { return "openrouter-free" }
func (o *OpenRouterProvider) BaseURL() string  { return o.base }
func (o *OpenRouterProvider) Models() []string { return o.models }
func (o *OpenRouterProvider) Handles(model string) bool {
	if o.apiKey == "" {
		return false
	}
	_, ok := o.modelSet[model]
	return ok
}
func (o *OpenRouterProvider) Health(ctx context.Context) error {
	if o.apiKey == "" {
		return context.Canceled
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", o.base+"/models", nil)
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return err
	}
	return nil
}
func (o *OpenRouterProvider) Proxy(w http.ResponseWriter, r *http.Request) error {
	o.proxy.ServeHTTP(w, r)
	return nil
}
