package flock

import (
	"math"
	"sync"
)

// StratifiedElo implements P2L-inspired (ICML 2025) prompt-specific ranking.
// Flat global Elo is provably lossy: model A beats B on code but loses on
// creative writing, and a single number erases that. This maintains one Elo
// vector per task class, still MLE on observed battles, just stratified.
//
// Task classes: code, reasoning, chat, retrieval, multimodal, other.
// Selection = argmax(classElo[taskClass]) instead of argmax(globalElo).

var taskClasses = []string{"code", "reasoning", "chat", "retrieval", "multimodal", "other"}

const (
	eloKFactor   = 32.0
	eloSeed      = 1000.0
	eloDecayRate = 0.999 // per-update decay toward seed (prevents stale dominance)
)

type StratifiedElo struct {
	mu sync.RWMutex
	// class -> model -> elo
	ratings map[string]map[string]float64
	// class -> model -> battle count
	battles map[string]map[string]int
}

func NewStratifiedElo() *StratifiedElo {
	se := &StratifiedElo{
		ratings: make(map[string]map[string]float64),
		battles: make(map[string]map[string]int),
	}
	for _, c := range taskClasses {
		se.ratings[c] = make(map[string]float64)
		se.battles[c] = make(map[string]int)
	}
	return se
}

// normalizeClass maps arbitrary class strings to known buckets.
func normalizeClass(class string) string {
	for _, c := range taskClasses {
		if c == class {
			return c
		}
	}
	return "other"
}

// Get returns the Elo for model in task class, seeding at 1000 if unseen.
func (se *StratifiedElo) Get(class, model string) float64 {
	class = normalizeClass(class)
	se.mu.RLock()
	defer se.mu.RUnlock()
	if r, ok := se.ratings[class][model]; ok {
		return r
	}
	return eloSeed
}

// RecordBattle records a pairwise outcome: winner beat loser in task class.
// expected = 1/(1+10^((Rb-Ra)/400)), update = K*(actual-expected).
func (se *StratifiedElo) RecordBattle(class, winner, loser string) {
	class = normalizeClass(class)
	se.mu.Lock()
	defer se.mu.Unlock()

	rw := se.getLocked(class, winner)
	rl := se.getLocked(class, loser)

	expectedW := 1.0 / (1.0 + math.Pow(10, (rl-rw)/400.0))
	expectedL := 1.0 - expectedW

	// Apply decay toward seed before update (recency weighting)
	rw = rw*eloDecayRate + eloSeed*(1-eloDecayRate)
	rl = rl*eloDecayRate + eloSeed*(1-eloDecayRate)

	se.ratings[class][winner] = rw + eloKFactor*(1.0-expectedW)
	se.ratings[class][loser] = rl + eloKFactor*(0.0-expectedL)
	se.battles[class][winner]++
	se.battles[class][loser]++
}

func (se *StratifiedElo) getLocked(class, model string) float64 {
	if r, ok := se.ratings[class][model]; ok {
		return r
	}
	return eloSeed
}

// Rank returns models sorted by Elo descending for the task class.
func (se *StratifiedElo) Rank(class string, models []string) []string {
	class = normalizeClass(class)
	se.mu.RLock()
	ratings := make(map[string]float64, len(models))
	for _, m := range models {
		ratings[m] = se.getLocked(class, m)
	}
	se.mu.RUnlock()

	// Insertion sort (model lists are small)
	sorted := append([]string{}, models...)
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && ratings[sorted[j]] > ratings[sorted[j-1]]; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	return sorted
}

// WinProbability returns P(a beats b) in the given task class.
func (se *StratifiedElo) WinProbability(class, a, b string) float64 {
	ra := se.Get(class, a)
	rb := se.Get(class, b)
	return 1.0 / (1.0 + math.Pow(10, (rb-ra)/400.0))
}

// BattleCounts returns per-model battle counts for a class (monitoring).
func (se *StratifiedElo) BattleCounts(class string) map[string]int {
	class = normalizeClass(class)
	se.mu.RLock()
	defer se.mu.RUnlock()
	out := make(map[string]int, len(se.battles[class]))
	for k, v := range se.battles[class] {
		out[k] = v
	}
	return out
}
