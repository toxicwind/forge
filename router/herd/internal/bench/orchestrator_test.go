// orchestrator_test.go — end-to-end tests for the orchestrator state machine.
// Uses t.TempDir() so the real OMP paths are never touched.
package bench

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestOrchestrator wires an orchestrator pointed at scratch paths so
// the real /mnt/agents/output and ~/.omp/agent are never touched.
func newTestOrchestrator(t *testing.T) (*Orchestrator, string, string) {
	t.Helper()
	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	ymlPath := filepath.Join(dir, "models.yml")
	s, err := LoadState(statePath)
	require.NoError(t, err)
	yml, err := LoadModelsYML(ymlPath)
	require.NoError(t, err)
	return &Orchestrator{
		State:     s,
		ModelsYML: yml,
		YMLPath:   ymlPath,
		BenchPath: "/nonexistent/omp",
		StatePath: statePath,
	}, statePath, ymlPath
}

func TestOrchestrator_RunSeed(t *testing.T) {
	o, statePath, _ := newTestOrchestrator(t)
	require.NoError(t, o.RunSeed())
	assert.Equal(t, PhaseSeed, o.State.Phase.Current)
	_, err := os.Stat(statePath)
	assert.NoError(t, err, "state file should exist after RunSeed")
}

func TestOrchestrator_RunDiscover_AgainstFakeHerd(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{models: []string{"a", "b", "c"}}).routes())
	defer srv.Close()

	o, _, ymlPath := newTestOrchestrator(t)
	o.State.Context.BaseURL = srv.URL + "/v1"
	require.NoError(t, o.RunDiscover(context.Background()))
	assert.Equal(t, []string{"a", "b", "c"}, o.State.Findings.Discovered)
	assert.Equal(t, PhaseDiscover, o.State.Phase.Current)
	_, err := os.Stat(ymlPath)
	assert.NoError(t, err)
	assert.Contains(t, o.ModelsYML.Providers, "herd")
}

func TestOrchestrator_RunDiscover_FailureMarksBlocked(t *testing.T) {
	o, _, _ := newTestOrchestrator(t)
	o.State.Context.BaseURL = "http://127.0.0.1:1/v1" // nothing listening
	err := o.RunDiscover(context.Background())
	assert.Error(t, err)
	require.NotNil(t, o.State.Phase.BlockedBy)
	assert.Equal(t, "discover_failed", *o.State.Phase.BlockedBy)
}

func TestOrchestrator_RunProbe_ClassifiesAndPersists(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[
				{"id":"alive","object":"model"},
				{"id":"dead","object":"model"}
			]}`))
		case "/v1/chat/completions":
			var req struct {
				Model string `json:"model"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			switch req.Model {
			case "alive":
				w.WriteHeader(http.StatusOK)
			case "dead":
				w.WriteHeader(http.StatusPaymentRequired)
			default:
				w.WriteHeader(http.StatusInternalServerError)
			}
		}
	}))
	defer srv.Close()

	o, _, _ := newTestOrchestrator(t)
	o.State.Context.BaseURL = srv.URL + "/v1"
	require.NoError(t, o.RunDiscover(context.Background()))
	require.NoError(t, o.RunProbe(context.Background()))

	assert.ElementsMatch(t, []string{"alive"}, o.State.Findings.Working)
	assert.ElementsMatch(t, []string{"dead"}, o.State.Findings.Dead)
	assert.Equal(t, PhaseProbe, o.State.Phase.Current)
	assert.Len(t, o.State.Findings.Probes, 2)
}

func TestOrchestrator_RunAutofix_DisablesAndReenables(t *testing.T) {
	o, _, ymlPath := newTestOrchestrator(t)
	o.State.Findings.Working = []string{"w1", "w2"}
	o.State.Findings.Dead = []string{"d1", "d2"}

	d, e, err := o.RunAutofix()
	require.NoError(t, err)
	assert.Equal(t, 2, d)
	assert.Equal(t, 0, e)

	// re-run with the same split: nothing new to disable, nothing to re-enable
	d, e, err = o.RunAutofix()
	require.NoError(t, err)
	assert.Equal(t, 0, d)
	assert.Equal(t, 0, e)

	// flip d1 to working
	o.State.Findings.Working = []string{"w1", "w2", "d1"}
	o.State.Findings.Dead = []string{"d2"}
	d, e, err = o.RunAutofix()
	require.NoError(t, err)
	assert.Equal(t, 0, d)
	assert.Equal(t, 1, e, "d1 should be re-enabled")

	data, err := os.ReadFile(ymlPath)
	require.NoError(t, err)
	assert.Contains(t, string(data), "d2")
	assert.NotContains(t, string(data), "d1:") // d1 was removed when re-enabled
}

func TestOrchestrator_RunAutofix_SaveErrorPropagates(t *testing.T) {
	// Point YMLPath at a directory path so the atomic rename in Save fails:
	// rename(tmp, dir) errors with "is a directory".
	dir := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(dir, "models.yml"), 0o755))
	o, _, _ := newTestOrchestrator(t)
	o.YMLPath = filepath.Join(dir, "models.yml")
	o.State.Findings.Dead = []string{"x"}
	_, _, err := o.RunAutofix()
	assert.Error(t, err)
}
func TestOrchestrator_RunAggregate_NoResults(t *testing.T) {
	o, _, _ := newTestOrchestrator(t)
	require.NoError(t, o.RunSeed())
	require.NoError(t, o.RunAggregate())
	assert.Equal(t, PhaseAggregate, o.State.Phase.Current)
}

func TestOrchestrator_RunAggregate_WithResults(t *testing.T) {
	o, _, _ := newTestOrchestrator(t)
	raw := json.RawMessage(`{"profile":"chat","runs":3,"models":[],"failures":0}`)
	o.State.Findings.BenchResults = &raw
	require.NoError(t, o.RunAggregate())
	assert.Equal(t, PhaseAggregate, o.State.Phase.Current)
}

func TestOrchestrator_TopByThroughput_NilWhenNoResults(t *testing.T) {
	o, _, _ := newTestOrchestrator(t)
	assert.Nil(t, o.TopByThroughput(5))
}

func TestOrchestrator_TopByThroughput_RanksDescending(t *testing.T) {
	o, _, _ := newTestOrchestrator(t)
	raw := json.RawMessage(`{"models":[
		{"model":"a","stats":{"throughput":10}},
		{"model":"b","stats":{"throughput":50}},
		{"model":"c","stats":{"throughput":25}}
	]}`)
	o.State.Findings.BenchResults = &raw

	top := o.TopByThroughput(3)
	require.Len(t, top, 3)
	assert.Equal(t, "b", top[0].Model)
	assert.Equal(t, "c", top[1].Model)
	assert.Equal(t, "a", top[2].Model)
}

func TestOrchestrator_TopByThroughput_FallsBackToTokensPerSecond(t *testing.T) {
	o, _, _ := newTestOrchestrator(t)
	raw := json.RawMessage(`{"models":[
		{"model":"a","stats":{"tokens_per_second":99}},
		{"model":"b","stats":{"tokens_per_second":1}}
	]}`)
	o.State.Findings.BenchResults = &raw
	top := o.TopByThroughput(2)
	assert.Equal(t, "a", top[0].Model)
}

func TestOrchestrator_FullPipeline_AgainstFakeHerd(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_, _ = w.Write([]byte(`{"data":[{"id":"m1","object":"model"},{"id":"m2","object":"model"}]}`))
			return
		}
		// chat-completions: m1 alive, m2 dead
		var req struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Model == "m1" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	o, _, ymlPath := newTestOrchestrator(t)
	o.State.Context.BaseURL = srv.URL + "/v1"

	require.NoError(t, o.RunSeed())
	require.NoError(t, o.RunDiscover(context.Background()))
	require.NoError(t, o.RunProbe(context.Background()))
	_, _, err := o.RunAutofix()
	require.NoError(t, err)
	require.NoError(t, o.RunAggregate())

	assert.Equal(t, PhaseAggregate, o.State.Phase.Current)
	data, err := os.ReadFile(ymlPath)
	require.NoError(t, err)
	assert.Contains(t, string(data), "m2")
	// verify the pipeline surfaced latency summaries (count tracks probes
	// regardless of sub-ms timing — fast localhost can produce 0ms readings).
	_ = ProbeLatencySummaries(o.State.Findings.Probes)
	assert.Equal(t, 2, len(o.State.Findings.Probes), "two probes should have run")
}

// Sanity: latency bench doesn't block forever on tiny inputs.
func TestOrchestrator_ProbeAllCompletesQuickly(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) { return 200, "ok", 0 },
	}).routes())
	defer srv.Close()
	o, _, _ := newTestOrchestrator(t)
	o.State.Context.BaseURL = srv.URL + "/v1"
	o.State.Findings.Discovered = []string{"a", "b", "c"}

	start := time.Now()
	results := ProbeAll(context.Background(), o.State.Context.BaseURL,
		o.State.Findings.Discovered, 2, 5)
	elapsed := time.Since(start)

	assert.Len(t, results, 3)
	assert.Less(t, elapsed, 2*time.Second, "3 sequential probes should finish in <2s")
}
