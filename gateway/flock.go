package flock

// CloudRouter routes tool calls across upstream MCP servers using health,
// latency, and ELO-based provider selection. Neither mcpproxy-go nor herd
// owns this package; both embed it as a first-class peer dependency.

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

type CloudRouter struct {
	cfg      *Config
	registry *ProviderRegistry
	health   *HealthDB
	limiter  *RateLimiter
	circuits *CircuitRegistry
	logger   *zap.Logger
	mu       sync.RWMutex
}

type Config struct {
	Strategy       string        `json:"strategy" yaml:"strategy"`
	DefaultTimeout time.Duration `json:"default_timeout" yaml:"default_timeout"`
	RateLimitRPS   float64       `json:"rate_limit_rps" yaml:"rate_limit_rps"`
	CircuitFailure int           `json:"circuit_failure" yaml:"circuit_failure"`
	CircuitTimeout time.Duration `json:"circuit_timeout" yaml:"circuit_timeout"`
	HealthInterval time.Duration `json:"health_interval" yaml:"health_interval"`
}

func (c *Config) Defaults() {
	if c.Strategy == "" { c.Strategy = "latency" }
	if c.DefaultTimeout == 0 { c.DefaultTimeout = 30 * time.Second }
	if c.RateLimitRPS == 0 { c.RateLimitRPS = 10 }
	if c.CircuitFailure == 0 { c.CircuitFailure = 5 }
	if c.CircuitTimeout == 0 { c.CircuitTimeout = 30 * time.Second }
	if c.HealthInterval == 0 { c.HealthInterval = 10 * time.Second }
}

func NewCloudRouter(cfg *Config, logger *zap.Logger) (*CloudRouter, error) {
	if cfg == nil {
		cfg = &Config{}
		cfg.Defaults()
	}
	return &CloudRouter{
		cfg: cfg, registry: NewProviderRegistry(),
		health: NewHealthDB(cfg.HealthInterval),
		limiter: NewRateLimiter(cfg.RateLimitRPS),
		circuits: NewCircuitRegistry(cfg.CircuitFailure, cfg.CircuitTimeout),
		logger: logger,
	}, nil
}

func (cr *CloudRouter) RegisterProvider(name, serverType, endpoint string, weight float64) {
	cr.registry.Register(name, serverType, endpoint, weight)
}

func (cr *CloudRouter) Route(ctx context.Context, toolName string) (string, error) {
	cr.mu.RLock()
	defer cr.mu.RUnlock()
	providers := cr.registry.All()
	if len(providers) == 0 {
		return "", fmt.Errorf("flock: no providers registered")
	}
	var candidates []*Provider
	for _, p := range providers {
		if !cr.health.IsHealthy(p.Name) { continue }
		if !cr.circuits.Allow(p.Name) { continue }
		if !cr.limiter.Acquire(p.Name, 1.0) { continue }
		candidates = append(candidates, p)
	}
	if len(candidates) == 0 {
		return "", fmt.Errorf("flock: no healthy providers for %s", toolName)
	}
	return cr.selectProvider(candidates, toolName).Name, nil
}

func (cr *CloudRouter) selectProvider(candidates []*Provider, toolName string) *Provider {
	switch cr.cfg.Strategy {
	case "elo": return cr.selectByELO(candidates)
	case "round_robin": return cr.selectRoundRobin(candidates)
	default: return cr.selectByLatency(candidates)
	}
}

func (cr *CloudRouter) selectByLatency(candidates []*Provider) *Provider {
	best, bestLat := candidates[0], cr.health.Latency(candidates[0].Name)
	for _, p := range candidates[1:] {
		if lat := cr.health.Latency(p.Name); lat < bestLat {
			best, bestLat = p, lat
		}
	}
	return best
}

func (cr *CloudRouter) selectByELO(candidates []*Provider) *Provider {
	best, bestELO := candidates[0], candidates[0].ELO
	for _, p := range candidates[1:] {
		if p.ELO > bestELO { best, bestELO = p, p.ELO }
	}
	return best
}

var rrCounter uint64
func (cr *CloudRouter) selectRoundRobin(candidates []*Provider) *Provider {
	return candidates[atomic.AddUint64(&rrCounter, 1)%uint64(len(candidates))]
}

func (cr *CloudRouter) RecordResult(provider string, success bool, latency time.Duration) {
	cr.health.Record(provider, success, latency)
	cr.limiter.RecordLatency(provider, latency)
	if success { cr.circuits.RecordSuccess(provider) } else { cr.circuits.RecordFailure(provider) }
}

func (cr *CloudRouter) Release(provider string, tokens float64) {
	cr.limiter.Release(provider, tokens)
}
