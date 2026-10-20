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

// CloudflareGatewayProvider wraps a Custom Provider via Cloudflare AI Gateway.
// It proxies to https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-<slug>/v1
// and gets CF caching, logging, rate-limiting on top of the free backend.
// Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_API_TOKEN.
type CloudflareGatewayProvider struct {
	base     string
	proxy    *httputil.ReverseProxy
	models   []string
	modelSet map[string]struct{}
	enabled  bool
}

func NewCloudflareGatewayProvider() *CloudflareGatewayProvider {
	acct := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	gw := os.Getenv("CLOUDFLARE_GATEWAY_ID")
	if gw == "" {
		gw = "default"
	}
	// If no account, disabled
	enabled := acct != ""
	base := ""
	if enabled {
		// Default to pollinations-free custom provider slug
		base = "https://gateway.ai.cloudflare.com/v1/" + acct + "/" + gw + "/custom-pollinations-free/v1"
		// Allow override
		if envBase := os.Getenv("CLOUDFLARE_GATEWAY_POLL_BASE"); envBase != "" {
			base = envBase
		}
	}
	u, _ := url.Parse(base)
	transport := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		ForceAttemptHTTP2: true,
		IdleConnTimeout:   90 * time.Second,
	}
	p := &CloudflareGatewayProvider{
		base:    base,
		enabled: enabled,
		models: []string{
			"openai", "gemma-4-31b", "gpt-oss",
		},
		modelSet: make(map[string]struct{}),
	}
	for _, m := range p.models {
		p.modelSet[m] = struct{}{}
	}
	p.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			if !p.enabled {
				return
			}
			r.SetURL(u)
			r.Out.Host = r.Out.URL.Host
			// CF AI Gateway uses CLOUDFLARE_API_TOKEN for gateway auth if needed, but custom provider
			// itself is free — we don't inject backend key here, CF handles it.
		},
		ModifyResponse: func(resp *http.Response) error {
			if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
				resp.Header.Set("X-Accel-Buffering", "no")
			}
			// Propagate CF cache status
			if cfCache := resp.Header.Get("cf-cache-status"); cfCache != "" {
				resp.Header.Set("X-CF-Cache", cfCache)
			}
			return nil
		},
	}
	return p
}

func (c *CloudflareGatewayProvider) ID() string       { return "cloudflare-gw" }
func (c *CloudflareGatewayProvider) BaseURL() string  { return c.base }
func (c *CloudflareGatewayProvider) Models() []string { return c.models }
func (c *CloudflareGatewayProvider) Handles(model string) bool {
	if !c.enabled {
		return false
	}
	_, ok := c.modelSet[model]
	return ok
}
func (c *CloudflareGatewayProvider) Health(ctx context.Context) error {
	if !c.enabled {
		return context.Canceled
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", c.base+"/models", nil)
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
func (c *CloudflareGatewayProvider) Proxy(w http.ResponseWriter, r *http.Request) error {
	c.proxy.ServeHTTP(w, r)
	return nil
}
