package flock

import (
	"sync"
)

// CostQualityRouter implements the RouteLLM-inspired (ICLR 2025) single-knob
// cost/quality tradeoff. A matrix-factorization router is the phase-2 upgrade;
// this phase-1 version gives Chris the single alpha knob with a transparent
// linear model that's O(1) at request time.
//
// alpha in [0,1]: 0 = cheapest viable, 1 = highest quality regardless of cost.
// Score(provider) = alpha * qualityScore + (1-alpha) * costScore
// where qualityScore is normalized Elo win-probability and costScore is
// inverse normalized cost (1 = free, 0 = most expensive).

type ProviderCost struct {
	Provider string
	// CostPer1kTokens in USD, 0 = free
	CostPer1kTokens float64
	// Quality baseline (0-1), from benchmarks. Updated by stratified Elo.
	BaseQuality float64
}

type CostQualityRouter struct {
	mu      sync.RWMutex
	alpha   float64 // 0=cheap, 1=quality
	costs   map[string]*ProviderCost
	elo     *StratifiedElo
	maxCost float64 // for normalization
}

func NewCostQualityRouter(elo *StratifiedElo, alpha float64) *CostQualityRouter {
	if alpha < 0 {
		alpha = 0
	}
	if alpha > 1 {
		alpha = 1
	}
	return &CostQualityRouter{
		alpha: alpha,
		costs: make(map[string]*ProviderCost),
		elo:   elo,
	}
}

// SetAlpha adjusts the cost/quality tradeoff. Safe for live updates.
func (cqr *CostQualityRouter) SetAlpha(alpha float64) {
	if alpha < 0 {
		alpha = 0
	}
	if alpha > 1 {
		alpha = 1
	}
	cqr.mu.Lock()
	defer cqr.mu.Unlock()
	cqr.alpha = alpha
}

// RegisterProvider adds or updates provider cost info.
func (cqr *CostQualityRouter) RegisterProvider(p *ProviderCost) {
	cqr.mu.Lock()
	defer cqr.mu.Unlock()
	cqr.costs[p.Provider] = p
	if p.CostPer1kTokens > cqr.maxCost {
		cqr.maxCost = p.CostPer1kTokens
	}
}

// Score returns the combined cost/quality score for a provider in a task class.
// Higher is better.
func (cqr *CostQualityRouter) Score(provider, taskClass, model string) float64 {
	cqr.mu.RLock()
	defer cqr.mu.RUnlock()

	pc, ok := cqr.costs[provider]
	if !ok {
		// Unknown provider: neutral score
		return 0.5
	}

	// Quality: normalize Elo to 0-1 via win probability vs seed baseline
	quality := cqr.elo.WinProbability(taskClass, model, "__baseline__")
	// Blend with static base quality for cold-start
	if pc.BaseQuality > 0 {
		battles := 0
		// Use base quality until we have real battle data
		quality = 0.7*quality + 0.3*pc.BaseQuality
		_ = battles
	}

	// Cost: 1 = free, approaches 0 as cost approaches max
	var costScore float64
	if cqr.maxCost <= 0 || pc.CostPer1kTokens <= 0 {
		costScore = 1.0
	} else {
		costScore = 1.0 - (pc.CostPer1kTokens / cqr.maxCost)
		if costScore < 0 {
			costScore = 0
		}
	}

	return cqr.alpha*quality + (1-cqr.alpha)*costScore
}

// RankProviders sorts providers by combined score for the task class.
func (cqr *CostQualityRouter) RankProviders(providers []string, taskClass, model string) []string {
	scores := make(map[string]float64, len(providers))
	for _, p := range providers {
		scores[p] = cqr.Score(p, taskClass, model)
	}

	sorted := append([]string{}, providers...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && scores[sorted[j]] > scores[sorted[j-1]]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	return sorted
}

// Alpha returns current tradeoff setting.
func (cqr *CostQualityRouter) Alpha() float64 {
	cqr.mu.RLock()
	defer cqr.mu.RUnlock()
	return cqr.alpha
}
