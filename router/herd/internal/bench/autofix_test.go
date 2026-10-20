// autofix_test.go — tests for the OMP models.yml mutator.
package bench

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadModelsYML_Missing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "models.yml")
	m, err := LoadModelsYML(path)
	require.NoError(t, err)
	assert.Empty(t, m.Providers)
}

func TestLoadModelsYML_Roundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "models.yml")
	initial := `providers:
  herd:
    baseUrl: http://127.0.0.1:25100/v1
    api: openai-completions
    auth: none
    modelOverrides:
      dead-model:
        disabled: true
`
	require.NoError(t, os.WriteFile(path, []byte(initial), 0o644))

	m, err := LoadModelsYML(path)
	require.NoError(t, err)
	require.Contains(t, m.Providers, "herd")
	assert.Equal(t, "http://127.0.0.1:25100/v1", m.Providers["herd"].BaseURL)
}

func TestLoadModelsYML_Corrupt(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.yml")
	require.NoError(t, os.WriteFile(path, []byte(":\n  - broken"), 0o644))
	_, err := LoadModelsYML(path)
	assert.Error(t, err)
}

func TestModelsYML_SaveAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "models.yml")
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	require.NoError(t, m.Save(path))
	_, err := os.Stat(path + ".tmp")
	assert.True(t, os.IsNotExist(err), "tmp file should be renamed away")
}

func TestModelsYML_SaveCreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a", "b", "c", "models.yml")
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	require.NoError(t, m.Save(path))
	_, err := os.Stat(path)
	assert.NoError(t, err)
}

func TestEnsureHerdProvider_AddsWhenMissing(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	m.EnsureHerdProvider("http://127.0.0.1:25100/v1")
	require.Contains(t, m.Providers, "herd")
	assert.Equal(t, "http://127.0.0.1:25100/v1", m.Providers["herd"].BaseURL)
	assert.Equal(t, "openai-completions", m.Providers["herd"].API)
	assert.Equal(t, "none", m.Providers["herd"].Auth)
}

func TestEnsureHerdProvider_Idempotent(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	m.EnsureHerdProvider("http://first/v1")
	original := m.Providers["herd"]
	m.EnsureHerdProvider("http://second/v1")
	assert.Equal(t, original, m.Providers["herd"], "second call must not clobber")
}

func TestApplyAutofix_DisablesDead(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	d, e := m.ApplyAutofix("herd", []string{"a", "b"}, []string{"x", "y"})
	assert.Equal(t, 2, d)
	assert.Equal(t, 0, e)
	assert.True(t, m.Providers["herd"].ModelOverrides["x"]["disabled"].(bool))
	assert.True(t, m.Providers["herd"].ModelOverrides["y"]["disabled"].(bool))
}

func TestApplyAutofix_ReenablesWorking(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{
		"herd": {ModelOverrides: map[string]map[string]any{
			"a": {"disabled": true},
			"b": {"disabled": true},
		}},
	}}
	d, e := m.ApplyAutofix("herd", []string{"a", "b"}, nil)
	assert.Equal(t, 0, d)
	assert.Equal(t, 2, e)
	_, hasA := m.Providers["herd"].ModelOverrides["a"]
	_, hasB := m.Providers["herd"].ModelOverrides["b"]
	assert.False(t, hasA, "empty override should be removed")
	assert.False(t, hasB)
}

func TestApplyAutofix_KeepsNonDisabledOverrides(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{
		"herd": {ModelOverrides: map[string]map[string]any{
			"a": {"maxTokens": 4096, "disabled": true},
		}},
	}}
	_, e := m.ApplyAutofix("herd", []string{"a"}, nil)
	assert.Equal(t, 1, e)
	// maxTokens should survive the re-enable
	assert.Equal(t, 4096, m.Providers["herd"].ModelOverrides["a"]["maxTokens"])
}

func TestApplyAutofix_CountsNewlyDisabled(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{
		"herd": {ModelOverrides: map[string]map[string]any{
			"x": {"disabled": true}, // already disabled
		}},
	}}
	d, _ := m.ApplyAutofix("herd", nil, []string{"x", "y"})
	assert.Equal(t, 1, d, "only y should count as newly disabled")
}

func TestApplyAutofix_MissingProvider(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	d, e := m.ApplyAutofix("herd", nil, []string{"x"})
	assert.Equal(t, 1, d)
	assert.Equal(t, 0, e)
	require.Contains(t, m.Providers, "herd", "missing provider should be created")
}

func TestDisabledModels_Sorted(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{
		"herd": {ModelOverrides: map[string]map[string]any{
			"z": {"disabled": true},
			"a": {"disabled": true},
			"m": {"disabled": true},
		}},
	}}
	assert.Equal(t, []string{"a", "m", "z"}, m.DisabledModels("herd"))
}

func TestDisabledModels_IgnoresNonBoolean(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{
		"herd": {ModelOverrides: map[string]map[string]any{
			"x": {"disabled": "yes"}, // string, not bool
			"y": {"disabled": true},
		}},
	}}
	assert.Equal(t, []string{"y"}, m.DisabledModels("herd"))
}

func TestDisabledModels_UnknownProvider(t *testing.T) {
	m := &ModelsYML{Providers: map[string]ProviderConfig{}}
	assert.Nil(t, m.DisabledModels("nonexistent"))
}
