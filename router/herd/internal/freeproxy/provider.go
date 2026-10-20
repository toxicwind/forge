package freeproxy

import (
	"context"
	"net/http"
	"time"
)

// Provider is a modular free-backend proxy handler.
// Each provider (pollinations, ovh, openrouter, cloudflare-gateway) implements this.
type Provider interface {
	// ID returns the stable slug (e.g., "pollinations-free", "ovhcloud-free", "openrouter-free", "cloudflare-gw")
	ID() string
	// BaseURL returns the upstream base (e.g., https://gen.pollinations.ai)
	BaseURL() string
	// Models returns the model IDs this provider serves (exact upstream IDs)
	Models() []string
	// Handles reports whether this provider can serve the given model
	Handles(model string) bool
	// Proxy forwards the request to the upstream, handling auth workaround, rate-limit, and caching.
	// It must respect ctx cancellation and return after writing the response or an error.
	Proxy(w http.ResponseWriter, r *http.Request) error
	// Health checks the provider (lightweight)
	Health(ctx context.Context) error
}

// RateLimiter controls per-provider request pacing (e.g., Pollinations 1 req/15s anon)
type RateLimiter interface {
	Allow(provider string) bool
	Wait(provider string) time.Duration
}

// Cache handles response caching for repeated prompts (CF gateway style)
type Cache interface {
	Get(key string) ([]byte, bool)
	Set(key string, value []byte, ttl time.Duration)
}

// Config for the freeproxy registry
type RegistryConfig struct {
	Providers []Provider
	Cache     Cache
	Limiter   RateLimiter
}
