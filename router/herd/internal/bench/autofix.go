// Package bench: autofix.go — update OMP models.yml to disable dead models.
package bench

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"gopkg.in/yaml.v3"
)

// ModelsYML is the on-disk shape of ~/.omp/agent/models.yml.
// We only touch the provider.modelOverrides.<model>.disabled field.
type ModelsYML struct {
	Providers map[string]ProviderConfig `yaml:"providers"`
}

// ProviderConfig is one provider block in models.yml.
type ProviderConfig struct {
	BaseURL        string                    `yaml:"baseUrl"`
	API            string                    `yaml:"api"`
	Auth           string                    `yaml:"auth"`
	Discovery      map[string]any            `yaml:"discovery"`
	ModelOverrides map[string]map[string]any `yaml:"modelOverrides"`
}

// DefaultModelsYMLPath is the OMP-side config file the autofix mutates.
func DefaultModelsYMLPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".omp", "agent", "models.yml")
}

// LoadModelsYML reads models.yml, returning an empty schema if missing.
func LoadModelsYML(path string) (*ModelsYML, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &ModelsYML{Providers: map[string]ProviderConfig{}}, nil
		}
		return nil, err
	}
	var m ModelsYML
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse models.yml: %w", err)
	}
	if m.Providers == nil {
		m.Providers = map[string]ProviderConfig{}
	}
	return &m, nil
}

// Save writes the models.yml back to disk atomically.
func (m *ModelsYML) Save(path string) error {
	data, err := yaml.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ApplyAutofix mutates the provider's modelOverrides:
//   - dead models get disabled: true
//   - working models have any existing disabled flag removed
//
// Returns the count of newly-disabled and re-enabled models.
func (m *ModelsYML) ApplyAutofix(provider string, working, dead []string) (disabled, enabled int) {
	p, ok := m.Providers[provider]
	if !ok {
		p = ProviderConfig{ModelOverrides: map[string]map[string]any{}}
	}
	if p.ModelOverrides == nil {
		p.ModelOverrides = map[string]map[string]any{}
	}
	for _, d := range dead {
		entry, exists := p.ModelOverrides[d]
		if !exists {
			entry = map[string]any{}
		}
		if _, ok := entry["disabled"]; !ok {
			disabled++
		}
		entry["disabled"] = true
		p.ModelOverrides[d] = entry
	}
	for _, w := range working {
		entry, exists := p.ModelOverrides[w]
		if !exists {
			continue
		}
		if _, ok := entry["disabled"]; ok {
			delete(entry, "disabled")
			enabled++
		}
		if len(entry) == 0 {
			delete(p.ModelOverrides, w)
		} else {
			p.ModelOverrides[w] = entry
		}
	}
	m.Providers[provider] = p
	return disabled, enabled
}

// EnsureHerdProvider idempotently inserts a herd provider block pointing at
// the local proxy. Safe to call when the file exists — does not overwrite
// other providers.
func (m *ModelsYML) EnsureHerdProvider(baseURL string) {
	if m.Providers == nil {
		m.Providers = map[string]ProviderConfig{}
	}
	if _, ok := m.Providers["herd"]; !ok {
		m.Providers["herd"] = ProviderConfig{
			BaseURL: baseURL,
			API:     "openai-completions",
			Auth:    "none",
			Discovery: map[string]any{
				"type":     "openai-models-list",
				"injectV1": true,
			},
			ModelOverrides: map[string]map[string]any{},
		}
	}
}

// DisabledModels returns the sorted list of model IDs with disabled: true.
func (m *ModelsYML) DisabledModels(provider string) []string {
	p, ok := m.Providers[provider]
	if !ok {
		return nil
	}
	var out []string
	for id, ov := range p.ModelOverrides {
		if v, ok := ov["disabled"]; ok {
			if b, _ := v.(bool); b {
				out = append(out, id)
			}
		}
	}
	sort.Strings(out)
	return out
}
