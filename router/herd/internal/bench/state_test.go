// bench_test.go — comprehensive test coverage for the bench package.
// Conventions mirror internal/cache/cache_test.go and internal/config/*_test.go
// (same-package, stretchr/testify, table-driven subtests).
package bench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// helper: scratch dir under t.TempDir so each test gets a clean slate.
func newTempState(t *testing.T) (*State, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s := NewState()
	return s, path
}

func TestNewState(t *testing.T) {
	s := NewState()
	assert.Equal(t, PhaseSeed, s.Phase.Current)
	assert.Empty(t, s.Phase.History)
	assert.Equal(t, "herd", s.Context.Provider)
	assert.Equal(t, "http://127.0.0.1:25100/v1", s.Context.BaseURL)
	assert.Equal(t, 8, s.Context.MaxConcurrency)
	assert.Equal(t, 15, s.Context.ProbeTimeoutS)
	assert.NotNil(t, s.Findings.Discovered)
	assert.NotNil(t, s.Findings.Working)
	assert.NotNil(t, s.Findings.Dead)
	assert.NotNil(t, s.Assignments)
}

func TestLoadState_Missing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nope.json")
	s, err := LoadState(path)
	require.NoError(t, err)
	assert.Equal(t, PhaseSeed, s.Phase.Current, "missing file should yield fresh state")
}

func TestLoadState_Corrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	require.NoError(t, os.WriteFile(path, []byte("{not json"), 0o644))
	_, err := LoadState(path)
	assert.Error(t, err, "corrupt state should error")
}

func TestState_SaveAndLoad_Roundtrip(t *testing.T) {
	s, path := newTempState(t)
	s.Transition(PhaseDiscover, "test-agent")
	s.Findings.Discovered = []string{"a", "b", "c"}
	s.Findings.Working = []string{"a", "b"}
	s.Findings.Dead = []string{"c"}
	raw := json.RawMessage(`{"models":[]}`)
	s.Findings.BenchResults = &raw

	require.NoError(t, s.Save(path))
	loaded, err := LoadState(path)
	require.NoError(t, err)
	assert.Equal(t, PhaseDiscover, loaded.Phase.Current)
	assert.Equal(t, []string{"a", "b", "c"}, loaded.Findings.Discovered)
	assert.Equal(t, []string{"a", "b"}, loaded.Findings.Working)
	assert.Equal(t, []string{"c"}, loaded.Findings.Dead)
	require.NotNil(t, loaded.Findings.BenchResults)
}

func TestState_SaveCreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "a", "b", "c", "state.json")
	s := NewState()
	require.NoError(t, s.Save(nested))
	_, err := os.Stat(nested)
	assert.NoError(t, err)
}

func TestState_SaveIsAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	s := NewState()
	require.NoError(t, s.Save(path))
	_, err := os.Stat(path + ".tmp")
	assert.True(t, os.IsNotExist(err), "tmp file should be renamed away after save")
}

func TestState_Transition_AppendsHistory(t *testing.T) {
	s := NewState()
	s.Transition(PhaseDiscover, "orch")
	s.Transition(PhaseProbe, "orch")
	s.Transition(PhaseAutofix, "orch")
	assert.Equal(t, PhaseAutofix, s.Phase.Current)
	assert.Equal(t, []string{"discover", "probe", "autofix"}, s.Phase.History)
}

func TestState_Transition_AssignsRole(t *testing.T) {
	s := NewState()
	s.Transition(PhaseProbe, "agent-7")
	assert.Equal(t, "agent-7", s.Assignments[PhaseProbe])
}

func TestState_Transition_NilRoleLeavesAssignmentUnchanged(t *testing.T) {
	s := NewState()
	s.Transition(PhaseProbe, "first")
	s.Transition(PhaseProbe, "")
	assert.Equal(t, "first", s.Assignments[PhaseProbe], "empty role should not clobber")
}

func TestSafeFilename(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"herd/foo", "herd-foo"},
		{"a:b", "a_b"},
		{"1.2.3", "1-2-3"},
		{"plain", "plain"},
		{"path/with/many/slashes", "path-with-many-slashes"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, SafeFilename(c.in), "input=%q", c.in)
	}
}

func TestFormatAge(t *testing.T) {
	assert.Equal(t, "5s", FormatAge(time.Now().Add(-5*time.Second)))
	assert.Equal(t, "3m", FormatAge(time.Now().Add(-3*time.Minute)))
	assert.Equal(t, "2h", FormatAge(time.Now().Add(-2*time.Hour)))
}

func TestState_ConcurrentSave(t *testing.T) {
	s, path := newTempState(t)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Transition(PhaseProbe, "concurrent")
			_ = s.Save(path)
		}()
	}
	wg.Wait()
	// The file should exist and be valid JSON; lock guarantees no torn writes.
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var loaded State
	require.NoError(t, json.Unmarshal(data, &loaded))
	assert.Equal(t, PhaseProbe, loaded.Phase.Current)
}
