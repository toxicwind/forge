package config

// Outcome-class keys for HealthConfig.Weights. They mirror the OutcomeClass
// values in the router package (kept as strings here so the config package
// does not import the router).
const (
	HealthClassSuccess     = "success"
	HealthClassEmpty200    = "200-empty"
	HealthClassThrottled   = "429-throttled"
	HealthClassNotEntitled = "402-not-entitled"
	HealthClassDeadID      = "404-dead-id"
	HealthClassRefused     = "403-refused"
	HealthClassServerError = "5xx"
	HealthClassTransport   = "transport"
	HealthClassCancelled   = "cancelled"
)

// HealthConfig holds the per-peer self-healing knobs. It lives on PeerConfig
// as the optional `health:` block. Zero values are replaced by ApplyDefaults.
//
// Semantics:
//   - Every observed outcome adds its class weight to a failure score; each
//     success subtracts RecoveryCredit (floor zero).
//   - When the score reaches FailureThreshold the circuit opens: the peer is
//     ejected from rotation and requests fail fast with 503 until CoolOffSeconds
//     elapse, at which point the next real request is admitted as a single-flight
//     half-open probe. A successful probe readmits the peer; a failed probe
//     re-opens the circuit.
//   - Degraded is advisory (the peer still serves): EWMA latency at or above
//     DegradedLatencyMs, or rolling error rate at or above DegradedErrorRate.
//   - Enabled defaults to true when the health block is present or absent; set
//     `enabled: false` to opt a peer out explicitly.
//   - CoolOffSeconds at or below 0 falls back to the 30s default: YAML cannot
//     distinguish "omitted" from "explicit 0", and a zero cool-off would turn
//     every post-trip request into a backend probe instead of failing fast.
type HealthConfig struct {
	Enabled           *bool              `yaml:"enabled" json:"enabled"`
	EWMAAlpha         float64            `yaml:"ewma_alpha" json:"ewma_alpha"`
	FailureThreshold  float64            `yaml:"failure_threshold" json:"failure_threshold"`
	RecoveryCredit    float64            `yaml:"recovery_credit" json:"recovery_credit"`
	SuccessThreshold  int                `yaml:"success_threshold" json:"success_threshold"`
	CoolOffSeconds    float64            `yaml:"cool_off_seconds" json:"cool_off_seconds"`
	DegradedLatencyMs float64            `yaml:"degraded_latency_ms" json:"degraded_latency_ms"`
	DegradedErrorRate float64            `yaml:"degraded_error_rate" json:"degraded_error_rate"`
	Weights           map[string]float64 `yaml:"weights" json:"weights"`
}

// DefaultHealthConfig returns the documented default knobs. Thresholds are
// conservative: a single 429 or 5xx never ejects a peer; sustained transport
// failure or repeated dead-id responses do.
func DefaultHealthConfig() HealthConfig {
	return HealthConfig{
		Enabled:           boolPtr(true),
		EWMAAlpha:         0.2,
		FailureThreshold:  8,
		RecoveryCredit:    1,
		SuccessThreshold:  1,
		CoolOffSeconds:    30,
		DegradedLatencyMs: 15000,
		DegradedErrorRate: 0.5,
		Weights: map[string]float64{
			HealthClassTransport:   2.0,
			HealthClassServerError: 1.5,
			HealthClassDeadID:      3.0,
			HealthClassNotEntitled: 2.0,
			HealthClassRefused:     1.5,
			HealthClassThrottled:   0.5,
			HealthClassEmpty200:    1.5,
			HealthClassSuccess:     0,
			HealthClassCancelled:   0,
		},
	}
}

// ApplyDefaults fills zero/unset values with defaults and clamps ranges.
func (h *HealthConfig) ApplyDefaults() {
	d := DefaultHealthConfig()
	if h.Enabled == nil {
		h.Enabled = d.Enabled
	}
	if h.EWMAAlpha <= 0 || h.EWMAAlpha > 1 {
		h.EWMAAlpha = d.EWMAAlpha
	}
	if h.FailureThreshold <= 0 {
		h.FailureThreshold = d.FailureThreshold
	}
	if h.RecoveryCredit < 0 {
		h.RecoveryCredit = d.RecoveryCredit
	}
	if h.SuccessThreshold <= 0 {
		h.SuccessThreshold = d.SuccessThreshold
	}
	// CoolOffSeconds <= 0 is indistinguishable from "omitted" in YAML and
	// would defeat fail-fast (every request becomes a probe), so it falls
	// back to the default.
	if h.CoolOffSeconds <= 0 {
		h.CoolOffSeconds = d.CoolOffSeconds
	}
	if h.DegradedLatencyMs < 0 {
		h.DegradedLatencyMs = d.DegradedLatencyMs
	}
	if h.DegradedErrorRate < 0 || h.DegradedErrorRate > 1 {
		h.DegradedErrorRate = d.DegradedErrorRate
	}
	if h.Weights == nil {
		h.Weights = map[string]float64{}
	}
	for class, w := range d.Weights {
		if _, ok := h.Weights[class]; !ok {
			h.Weights[class] = w
		}
	}
	for class, w := range h.Weights {
		if w < 0 {
			h.Weights[class] = 0
		}
	}
}

// WeightFor returns the failure weight for an outcome class, falling back to
// defaults for classes the user did not configure.
func (h HealthConfig) WeightFor(class string) float64 {
	if w, ok := h.Weights[class]; ok {
		return w
	}
	d := DefaultHealthConfig()
	if w, ok := d.Weights[class]; ok {
		return w
	}
	return 1.0
}

func boolPtr(b bool) *bool {
	return &b
}
