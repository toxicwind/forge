package freeproxy

import (
	"testing"
)

// Regression: no dummy Bearer. Anonymous mode sends zero auth and only
// routes the anonymous-verified model set.
func TestPollinationsAnonymousNoDummyAuth(t *testing.T) {
	t.Setenv("POLLINATIONS_API_KEY", "")
	t.Setenv("POLLINATIONS_KEY", "")
	p := NewPollinationsProvider(nil, nil)
	if p.apiKey != "" {
		t.Fatalf("anonymous mode must have empty apiKey, got %q", p.apiKey)
	}
	if !p.Handles("openai") {
		t.Error("anonymous set must handle openai")
	}
	if !p.Handles("gpt-oss") {
		t.Error("anonymous set must handle gpt-oss")
	}
	for _, m := range []string{"gemma-4-31b", "qwen3.8-27b", "muse-glimmer", "muse-spark-1.2", "kimi-k3", "nemotron-3.5-lightning"} {
		if p.Handles(m) {
			t.Errorf("key-gated model %q must be parked without a key", m)
		}
	}
	if len(p.Models()) != len(anonymousModels) {
		t.Errorf("anonymous Models() = %d, want %d", len(p.Models()), len(anonymousModels))
	}
}

// Regression: a real key unlocks the gated set and is injected.
func TestPollinationsKeyUnlocksGated(t *testing.T) {
	t.Setenv("POLLINATIONS_API_KEY", "test-key-123")
	p := NewPollinationsProvider(nil, nil)
	if p.apiKey != "test-key-123" {
		t.Fatalf("apiKey = %q, want test-key-123", p.apiKey)
	}
	for _, m := range keyGatedModels {
		if !p.Handles(m) {
			t.Errorf("keyed mode must handle gated model %q", m)
		}
	}
	want := len(anonymousModels) + len(keyGatedModels)
	if len(p.Models()) != want {
		t.Errorf("keyed Models() = %d, want %d", len(p.Models()), want)
	}
}
