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

// OVHProvider proxies to OVHcloud AI Endpoints (EU, 2 RPM anon, now gated behind OAuth).
// It requires OVH_API_KEY env (from https://kepler.ai.cloud.ovh.net/v1/oauth/ovh/authorize).
// If no key, it is disabled (Handles always false) but still listed for health.
type OVHProvider struct {
	base     string
	apiKey   string
	proxy    *httputil.ReverseProxy
	models   []string
	modelSet map[string]struct{}
}

func NewOVHProvider() *OVHProvider {
	base := "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1"
	apiKey := os.Getenv("OVH_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("OVHCLOUD_API_KEY")
	}
	// If no key, we still create but Handles will gate to false until key appears
	u, _ := url.Parse(base)
	transport := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		ForceAttemptHTTP2: true,
		IdleConnTimeout:   90 * time.Second,
	}
	p := &OVHProvider{
		base:   base,
		apiKey: apiKey,
		models: []string{
			"gpt-oss-20b", "Qwen3.6-27B", "Meta-Llama-3_3-70B-Instruct", "Mistral-Small-3.2",
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

func (o *OVHProvider) ID() string       { return "ovhcloud-free" }
func (o *OVHProvider) BaseURL() string  { return o.base }
func (o *OVHProvider) Models() []string { return o.models }
func (o *OVHProvider) Handles(model string) bool {
	if o.apiKey == "" {
		return false // disabled until key provisioned — ignore not-anonymous by disabling
	}
	_, ok := o.modelSet[model]
	return ok
}
func (o *OVHProvider) Health(ctx context.Context) error {
	if o.apiKey == "" {
		return context.Canceled // disabled
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
func (o *OVHProvider) Proxy(w http.ResponseWriter, r *http.Request) error {
	o.proxy.ServeHTTP(w, r)
	return nil
}
