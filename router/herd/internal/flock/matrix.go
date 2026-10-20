package flock

import (
	"sync"
)

// Matrix coordinates providers, circuit breakers, and health state.
// It is a thin wrapper around Router for compatibility with upstream naming.
type Matrix struct {
	mu       sync.RWMutex
	registry *ProviderRegistry
	health   *HealthDB
	limiter  *RateLimiter
	config   *FlockConfig
	router   *Router
}

// NewMatrix creates a Matrix from config.
func NewMatrix(cfg *FlockConfig, reg *ProviderRegistry, health *HealthDB, limiter *RateLimiter) (*Matrix, error) {
	return &Matrix{
		registry: reg, health: health,
		limiter: limiter, config: cfg,
	}, nil
}

func (m *Matrix) Providers() *ProviderRegistry { return m.registry }
func (m *Matrix) Health() *HealthDB            { return m.health }
func (m *Matrix) Limiter() *RateLimiter        { return m.limiter }
