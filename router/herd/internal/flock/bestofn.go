package flock

// BestOfN implements BEST-Route-inspired (ICML 2025) uncertain-band sampling.
// Prior routers pick ONE model and generate ONE response. In the 30-50% of
// queries where router confidence is intermediate, small model with best-of-N
// + lightweight judge matches the large model's single-sample quality at a
// fraction of the cost.
//
// Confidence bands:
//   high confidence (>0.75): single strong model, 1 sample
//   uncertain (0.40-0.75):  N cheap samples, judge picks best
//   low (<0.40): single cheapest viable model (don't waste strong model)
//
// This extends flock's astRace beyond first-substantive-wins.

const (
	confidenceHigh   = 0.75
	confidenceLow    = 0.40
	uncertainSamples = 4 // best-of-4 in the uncertain band
)

// SamplingDecision tells the router how to execute this request.
type SamplingDecision struct {
	// NumSamples: how many parallel samples to take
	NumSamples int
	// UseCheapModel: whether to use the cheap model for sampling
	UseCheapModel bool
	// Confidence: router confidence in the primary choice
	Confidence float64
	// Band: "high", "uncertain", or "low"
	Band string
}

// DecideSampling maps router confidence to a sampling strategy.
// winProb is P(primary beats alternative) from stratified Elo.
// costRatio is cheapCost/strongCost (0 = cheap is free).
func DecideSampling(winProb, costRatio float64) SamplingDecision {
	d := SamplingDecision{Confidence: winProb}

	switch {
	case winProb >= confidenceHigh:
		// High confidence: trust the router, single sample from primary
		d.Band = "high"
		d.NumSamples = 1
		d.UseCheapModel = false

	case winProb >= confidenceLow:
		// Uncertain band: sample cheap model N times, judge picks best.
		// Only worth it if cheap is actually cheap.
		d.Band = "uncertain"
		if costRatio < 0.3 {
			// Cheap is <30% of strong cost: best-of-4 is a bargain
			d.NumSamples = uncertainSamples
			d.UseCheapModel = true
		} else if costRatio < 0.6 {
			// Moderate: best-of-2
			d.NumSamples = 2
			d.UseCheapModel = true
		} else {
			// Not cheap enough to justify sampling: single strong
			d.NumSamples = 1
			d.UseCheapModel = false
		}

	default:
		// Low confidence: router doesn't know. Don't burn the strong model
		// on a guess — use cheap model, single sample.
		d.Band = "low"
		d.NumSamples = 1
		d.UseCheapModel = true
	}

	return d
}

// JudgeScore is a lightweight quality signal for picking best-of-N.
// Phase 1: length-normalized heuristic (non-empty, coherent length).
// Phase 2: small judge model call.
func JudgeScore(response string) float64 {
	if len(response) == 0 {
		return 0
	}
	// Prefer substantive but bounded responses
	n := float64(len(response))
	score := n / (n + 500.0) // saturating: 500 chars ~ 0.5, 2000 ~ 0.8
	// Penalize extremely short (likely truncated/refusal)
	if n < 50 {
		score *= 0.3
	}
	// Penalize extremely long (likely rambling)
	if n > 8000 {
		score *= 0.7
	}
	return score
}

// PickBest returns the index of the highest-judge-score response.
func PickBest(responses []string) int {
	best, bestScore := 0, -1.0
	for i, r := range responses {
		if s := JudgeScore(r); s > bestScore {
			best, bestScore = i, s
		}
	}
	return best
}
