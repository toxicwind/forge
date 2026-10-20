package astmatrix

import (
	"os"
	"regexp"
	"sort"
	"strings"
)

// provider holds runtime state for one upstream provider.
type provider struct {
	base      string
	keyEnv    string
	keyEnvAlt string
	noAuth    bool
	models    []string
}

// defaultProviders builds the provider table from the GENERATED canonical
// catalog (providers_generated.go — DO NOT EDIT BY HAND; source of truth is
// packages/providers/src/data.ts in the TS package, which is the brain).
// No model IDs are hardcoded here.
//
// Cold start: providers carry their generated seeds, dead-ID filtered. The
// Matrix overlays the LIVE serving sets from the TS-exported live catalog
// file (LiveCatalogReader.SyncProviderModels) — the answer, which is data.
// No discovery or quarantine logic lives in this binary.
//
// The extended registry (registry.go) merges in afterwards in deterministic
// (sorted) order: core catalog wins on collision, non-openai formats and
// empty BaseURLs are skipped.
func defaultProviders() map[string]*provider {
	dead := deadIDSet()
	providers := make(map[string]*provider, len(ProviderCatalogDefs))
	for _, d := range ProviderCatalogDefs {
		if !d.Enabled || d.RouterLocal {
			continue
		}
		providers[d.Name] = &provider{
			base:      d.BaseURL,
			keyEnv:    d.KeyEnv,
			keyEnvAlt: d.KeyEnvAlt,
			noAuth:    d.NoAuth,
			models:    filterDeadIDs(ProviderCatalogSeeds[d.Name], dead),
		}
	}

	// Merge extended providers from registry (skip duplicates, skip non-openai, skip empty BaseURL)
	ids := make([]string, 0, len(RegistryProviders))
	for id := range RegistryProviders {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		reg := RegistryProviders[id]
		if _, exists := providers[id]; exists {
			continue // core provider takes precedence
		}
		if reg.BaseURL == "" || reg.Format != "openai" {
			continue // can only route openai-format providers
		}
		var models []string
		for _, m := range reg.Models {
			models = append(models, m.ID)
		}
		providers[id] = &provider{
			base:   reg.BaseURL,
			keyEnv: keyEnvFor(id),
			noAuth: reg.NoAuth,
			models: models,
		}
	}
	return providers
}

// deadIDSet builds the dead-tier set from the generated list.
func deadIDSet() map[string]bool {
	set := make(map[string]bool, len(ProviderCatalogDeadIDs))
	for _, id := range ProviderCatalogDeadIDs {
		set[id] = true
	}
	return set
}

// filterDeadIDs removes permanently-dead ids from a seed list.
func filterDeadIDs(ids []string, dead map[string]bool) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !dead[id] {
			out = append(out, id)
		}
	}
	return out
}

// aliasTargetServable reports whether an alias target is currently servable:
// not on the permanent dead list, and present in the provider's current
// serving set (which comes from the live catalog file, or generated seeds at
// cold start). Quarantined models are absent from the serving set, so this
// single membership check covers both guards. Data check, not logic.
func aliasTargetServable(providers map[string]*provider, prov, model string) bool {
	if deadIDSet()[model] {
		return false
	}
	p, ok := providers[prov]
	if !ok {
		return false
	}
	for _, id := range p.models {
		if id == model {
			return true
		}
	}
	return false
}

// codingAlias maps friendly alias -> [provider, model] or nil for auto/fcm.
// codingAlias is the merged alias table: the canonical generated aliases
// (ProviderCatalogAliases — source of truth is the TS package) plus
// herd-local extras. Herd-local wins on key collision.
var codingAlias = func() map[string][2]string {
	m := make(map[string][2]string, len(ProviderCatalogAliases)+len(herdLocalAliases))
	for k, v := range ProviderCatalogAliases {
		m[k] = v
	}
	for k, v := range herdLocalAliases {
		m[k] = v
	}
	return m
}()

// herdLocalAliases are herd-specific aliases with NO canonical equivalent.
// Canonical aliases live in ProviderCatalogAliases (generated from @ranch/roost);
// anything duplicated there was removed 2026-09-30 - this map holds only true extras:
// strategy directives, local-role shortcuts, and extended-registry aliases
// (whose providers live in registry.go, not the core catalog).
var herdLocalAliases = map[string][2]string{
	// Auto routing (nil means use strategy)
	"auto": {},
	"fcm":  {},
	// Local-first ranked roles
	"fast":          {"herd", "local-fast"},
	"local-fast":    {"herd", "local-fast"},
	"quality":       {"herd", "local-quality"},
	"local-quality": {"herd", "local-quality"},
	"longctx":       {"herd", "local-longctx"},
	"local-longctx": {"herd", "local-longctx"},
	"local-auto":    {"herd", "local-quality"},
	// OpenRouter free aliases (verified working 2026-07-28)
	"gpt-oss-20b": {"openrouter", "openai/gpt-oss-20b:free"},
	// NVIDIA NIM aliases
	"nim-llama-3.3-70b": {"nvidia", "meta/llama-3.3-70b-instruct"},
	// Extended provider aliases from registry
	"opencode":           {"opencode", "opencode"},
	"xai-grok-4":         {"xai", "grok-4"},
	"xai-grok-3":         {"xai", "grok-3"},
	"mimo-auto":          {"mimo-free", "mimo-auto"},
	"perplexity-sonar":   {"perplexity", "sonar-pro"},
	"together-llama-3.3": {"together", "meta-llama/Llama-3.3-70B-Instruct-Turbo"},
}

// localPatterns matches known local GGUF model ID prefixes.
var localPatterns = regexp.MustCompile(`^(beellama|mradermacher|jackrong|turboquant|ik_llama|ik_turboquant|holo|qwen/|gemma-4|exaone)`)

// isLocalSwapModelId returns true for model IDs that should route to the local herd.
func isLocalSwapModelId(model string) bool {
	if model == "" || model == "auto" || model == "fcm" {
		return false
	}
	if target, ok := codingAlias[model]; ok && len(target) > 0 && target[0] == "herd" {
		return true
	}
	return localPatterns.MatchString(model)
}

// resolveModel resolves a model name to (provider, modelID).
func resolveModel(model string, providers map[string]*provider) (string, string) {
	// Check coding aliases (guarded: dead or non-serving targets refused).
	if target, ok := codingAlias[model]; ok {
		if len(target) > 0 && target[0] != "" {
			if aliasTargetServable(providers, target[0], target[1]) {
				return target[0], target[1]
			}
		}
	}
	// Check if it's a local GGUF model ID
	if isLocalSwapModelId(model) {
		return "herd", model
	}
	// Auto/fcm: search all providers by weighted ELO
	if model == "auto" || model == "fcm" {
		// Find first provider with a key and circuit ok
		for pname, p := range providers {
			if pname == "herd" {
				continue
			}
			if p.noAuth || os.Getenv(p.keyEnv) != "" {
				if len(p.models) > 0 {
					return pname, p.models[0]
				}
			}
		}
		return "herd", "local-quality"
	}
	// Search provider model lists
	for pname, p := range providers {
		for _, m := range p.models {
			if m == model {
				return pname, model
			}
		}
	}
	// Fallback: openrouter -> nvidia -> herd
	if _, ok := providers["openrouter"]; ok {
		return "openrouter", model
	}
	if _, ok := providers["nvidia"]; ok {
		return "nvidia", model
	}
	return "herd", "local-quality"
}

// isExplicit returns true if the model maps to a specific provider via coding aliases.
func isExplicit(model string) bool {
	target, ok := codingAlias[model]
	if !ok {
		return false
	}
	return len(target) > 0 && target[0] != ""
}

// astRe detects code/AST content in responses.
var astRe = regexp.MustCompile(`(def |class |import |from |function |const |let |var |#include|package |fn |pub |struct |impl |async |await |\.ts|\.py|\.rs|\.js|AST|tree-sitter|syntax|` + "```" + `)`)

func isAST(text string) bool {
	if text == "" {
		return false
	}
	if strings.Contains(text, "```") {
		return true
	}
	sample := text
	if len(sample) > 5000 {
		sample = sample[:5000]
	}
	return astRe.MatchString(sample)
}
