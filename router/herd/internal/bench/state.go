// Package bench provides model probing and benchmarking for the herd proxy.
//
// The bench orchestrator discovers models served by a herd instance, probes
// each for liveness, classifies them as alive/dead, and updates the OMP
// models.yml to disable inconsistent models. It is the first-party
// alternative to external benchmark tooling.
package bench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Phase enumerates the orchestrator state machine stages.
type Phase string

const (
	PhaseSeed      Phase = "seed"
	PhaseDiscover  Phase = "discover"
	PhaseProbe     Phase = "probe"
	PhaseAutofix   Phase = "autofix"
	PhaseBench     Phase = "bench"
	PhaseAggregate Phase = "aggregate"
	PhaseReactive  Phase = "reactive"
)

// ProbeStatus is the per-model classification after a probe.
type ProbeStatus string

const (
	StatusAlive   ProbeStatus = "alive"
	StatusDead    ProbeStatus = "dead"
	StatusTimeout ProbeStatus = "timeout"
	StatusError   ProbeStatus = "error"
)

// ProbeResult is the outcome of a single model probe.
type ProbeResult struct {
	Model      string      `json:"model"`
	Status     ProbeStatus `json:"status"`
	HTTPStatus int         `json:"http_status"`
	LatencyMs  int64       `json:"latency_ms"`
	Detail     string      `json:"detail"`
}

// State is the single source of truth for orchestrator coordination.
// Subagents read this on entry and atomically rewrite on exit.
type State struct {
	Meta        map[string]any   `json:"meta"`
	Phase       PhaseState       `json:"phase"`
	Context     Context          `json:"context"`
	Findings    Findings         `json:"findings"`
	Assignments map[Phase]string `json:"assignments"`
	mu          sync.Mutex       `json:"-"`
}

// PhaseState tracks the current orchestrator phase + history.
type PhaseState struct {
	Current    Phase    `json:"current"`
	History    []string `json:"history"`
	BlockedBy  *string  `json:"blocked_by"`
	RetryCount int      `json:"retry_count"`
}

// Context holds the runtime configuration of the orchestrator.
type Context struct {
	Provider       string `json:"provider"`
	BaseURL        string `json:"baseUrl"`
	MaxConcurrency int    `json:"maxConcurrency"`
	ProbeTimeoutS  int    `json:"probeTimeoutSec"`
}

// Findings accumulates discovered models, probe results, and bench outcomes.
type Findings struct {
	Discovered   []string         `json:"discovered"`
	Probes       []ProbeResult    `json:"probes"`
	Working      []string         `json:"working"`
	Dead         []string         `json:"dead"`
	BenchResults *json.RawMessage `json:"bench_results"`
}

// DefaultStatePath is the canonical shared state file location.
const DefaultStatePath = "/mnt/agents/output/omp-bench-state.json"

// MirrorPath is the OMP-side mirror used by eval for in-process access.
func MirrorPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".omp", "agent", "bench-state.json")
}

// NewState returns a State populated with the standard empty schema.
func NewState() *State {
	return &State{
		Meta: map[string]any{
			"project":         "herd",
			"orchestrator_id": "main",
		},
		Phase: PhaseState{
			Current:    PhaseSeed,
			History:    []string{},
			RetryCount: 0,
		},
		Context: Context{
			Provider:       "herd",
			BaseURL:        "http://127.0.0.1:25100/v1",
			MaxConcurrency: 8,
			ProbeTimeoutS:  15,
		},
		Findings: Findings{
			Discovered: []string{},
			Probes:     []ProbeResult{},
			Working:    []string{},
			Dead:       []string{},
		},
		Assignments: map[Phase]string{},
	}
}

// LoadState reads the state file or returns a fresh empty State.
func LoadState(path string) (*State, error) {
	if path == "" {
		path = DefaultStatePath
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewState(), nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse state: %w", err)
	}
	return &s, nil
}

// Save writes the state to disk atomically (tmp + rename) and mirrors it.
func (s *State) Save(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if path == "" {
		path = DefaultStatePath
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	// mirror
	mirror := MirrorPath()
	if err := os.MkdirAll(filepath.Dir(mirror), 0o755); err == nil {
		_ = os.WriteFile(mirror, data, 0o644)
	}
	return nil
}

// Transition advances the phase, appends to history, and assigns the role.
func (s *State) Transition(next Phase, role string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Phase.Current = next
	s.Phase.History = append(s.Phase.History, string(next))
	if s.Assignments == nil {
		s.Assignments = map[Phase]string{}
	}
	if role != "" {
		s.Assignments[next] = role
	}
}

// SafeFilename converts a model ID to a filesystem-safe name.
// Replaces / with -, removes unsafe characters.
func SafeFilename(modelID string) string {
	r := strings.NewReplacer("/", "-", ":", "_", ".", "-")
	return r.Replace(modelID)
}

// FormatAge returns a human-readable duration since the given timestamp.
func FormatAge(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
}
