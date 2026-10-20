// Package bench: orchestrator.go — the state machine that runs the
// seed → discover → probe → autofix → bench → aggregate → reactive loop.
package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"
)

// Orchestrator is the high-level coordinator. It owns the state file and
// runs phases sequentially, persisting progress after each.
type Orchestrator struct {
	State     *State
	ModelsYML *ModelsYML
	YMLPath   string
	BenchPath string
	StatePath string
}

// NewOrchestrator wires a fresh Orchestrator with default paths.
func NewOrchestrator() (*Orchestrator, error) {
	state, err := LoadState(DefaultStatePath)
	if err != nil {
		return nil, err
	}
	yml, err := LoadModelsYML(DefaultModelsYMLPath())
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("home dir: %w", err)
	}
	return &Orchestrator{
		State:     state,
		ModelsYML: yml,
		YMLPath:   DefaultModelsYMLPath(),
		BenchPath: filepath.Join(home, ".local", "bin", "omp"),
		StatePath: DefaultStatePath,
	}, nil
}

// RunSeed initializes the state file with default empty values.
func (o *Orchestrator) RunSeed() error {
	o.State.Transition(PhaseSeed, "orchestrator")
	if o.State.Findings.Discovered == nil {
		o.State.Findings.Discovered = []string{}
	}
	if o.State.Findings.Working == nil {
		o.State.Findings.Working = []string{}
	}
	if o.State.Findings.Dead == nil {
		o.State.Findings.Dead = []string{}
	}
	return o.State.Save(o.StatePath)
}

// RunDiscover fetches /v1/models and writes the discovered IDs into state.
// Also ensures the herd provider is registered in models.yml.
func (o *Orchestrator) RunDiscover(ctx context.Context) error {
	ids, err := Discover(ctx, o.State.Context.BaseURL)
	if err != nil {
		o.State.Phase.BlockedBy = strPtr("discover_failed")
		_ = o.State.Save(o.StatePath)
		return err
	}
	o.State.Findings.Discovered = ids
	o.ModelsYML.EnsureHerdProvider(o.State.Context.BaseURL)
	if err := o.ModelsYML.Save(o.YMLPath); err != nil {
		return fmt.Errorf("save models.yml: %w", err)
	}
	o.State.Transition(PhaseDiscover, "orchestrator")
	return o.State.Save(o.StatePath)
}

// RunProbe probes every discovered model with the configured concurrency.
// Updates state with per-model results and classifies into working/dead.
func (o *Orchestrator) RunProbe(ctx context.Context) error {
	results := ProbeAll(ctx,
		o.State.Context.BaseURL,
		o.State.Findings.Discovered,
		o.State.Context.MaxConcurrency,
		o.State.Context.ProbeTimeoutS,
	)
	o.State.Findings.Probes = results
	working, dead := Classify(results)
	o.State.Findings.Working = working
	o.State.Findings.Dead = dead
	o.State.Transition(PhaseProbe, "orchestrator")
	return o.State.Save(o.StatePath)
}

// RunAutofix mutates models.yml to disable dead models and re-enable working
// ones. Returns the (newly_disabled, re_enabled) counts.
func (o *Orchestrator) RunAutofix() (int, int, error) {
	d, e := o.ModelsYML.ApplyAutofix(o.State.Context.Provider,
		o.State.Findings.Working, o.State.Findings.Dead)
	if err := o.ModelsYML.Save(o.YMLPath); err != nil {
		return d, e, err
	}
	o.State.Transition(PhaseAutofix, "orchestrator")
	return d, e, o.State.Save(o.StatePath)
}

// RunBench invokes `omp bench` on the working set with chat profile.
// Writes the raw JSON output to state. Returns the path to the result file.
func (o *Orchestrator) RunBench(ctx context.Context, runs, par int) (string, error) {
	if len(o.State.Findings.Working) == 0 {
		o.State.Transition(PhaseBench, "orchestrator")
		return "", o.State.Save(o.StatePath)
	}
	args := []string{"bench"}
	args = append(args, o.State.Findings.Working...)
	args = append(args,
		"--profile", "chat",
		"--runs", fmt.Sprintf("%d", runs),
		"--par", fmt.Sprintf("%d", par),
		"--json",
	)
	cmd := exec.CommandContext(ctx, o.BenchPath, args...)
	resultPath := "/tmp/omp-bench-results.json"
	cmd.Stdout = openFileOrDiscard(resultPath)
	cmd.Stderr = openFileOrDiscard("/tmp/omp-bench.log")
	if err := cmd.Run(); err != nil {
		// continue — bench may have partial results
	}
	raw, rerr := readFileBytes(resultPath)
	if rerr == nil {
		rawMsg := json.RawMessage(raw)
		o.State.Findings.BenchResults = &rawMsg
	}
	o.State.Transition(PhaseBench, "orchestrator")
	if err := o.State.Save(o.StatePath); err != nil {
		return resultPath, err
	}
	return resultPath, nil
}

// RunAggregate summarizes bench results and persists them to disk.
func (o *Orchestrator) RunAggregate() error {
	raw := o.State.Findings.BenchResults
	if raw == nil {
		o.State.Transition(PhaseAggregate, "orchestrator")
		return o.State.Save(o.StatePath)
	}
	var summary struct {
		Profile  string `json:"profile"`
		Runs     int    `json:"runs"`
		Models   int    `json:"-"`
		Failures int    `json:"failures"`
	}
	var models struct {
		Models []map[string]any `json:"models"`
	}
	_ = json.Unmarshal(*raw, &summary)
	_ = json.Unmarshal(*raw, &models)
	summary.Models = len(models.Models)
	home, _ := os.UserHomeDir()
	stamped := filepath.Join(home, ".omp", "agent",
		fmt.Sprintf("bench-results-%s.json", time.Now().Format("20060102")))
	if data, err := json.MarshalIndent(json.RawMessage(*raw), "", "  "); err == nil {
		_ = writeFileBytes(stamped, data)
	}
	o.State.Transition(PhaseAggregate, "orchestrator")
	return o.State.Save(o.StatePath)
}

// TopByThroughput returns the top-N working models by tokens/sec, derived
// from the bench JSON. Returns nil when bench results are absent.
func (o *Orchestrator) TopByThroughput(n int) []ModelThroughput {
	if o.State.Findings.BenchResults == nil {
		return nil
	}
	var parsed struct {
		Models []struct {
			Model string         `json:"model"`
			Stats map[string]any `json:"stats"`
		} `json:"models"`
	}
	if err := json.Unmarshal(*o.State.Findings.BenchResults, &parsed); err != nil {
		return nil
	}
	out := make([]ModelThroughput, 0, len(parsed.Models))
	for _, m := range parsed.Models {
		mt := ModelThroughput{Model: m.Model}
		if m.Stats != nil {
			if v, ok := m.Stats["throughput"].(float64); ok {
				mt.Throughput = v
			} else if v, ok := m.Stats["tokens_per_second"].(float64); ok {
				mt.Throughput = v
			}
		}
		out = append(out, mt)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Throughput > out[j].Throughput })
	if n > 0 && n < len(out) {
		out = out[:n]
	}
	return out
}

// ModelThroughput is a single model's bench summary.
type ModelThroughput struct {
	Model      string  `json:"model"`
	Throughput float64 `json:"throughput"`
}

func strPtr(s string) *string { return &s }
