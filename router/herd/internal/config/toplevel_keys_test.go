package config

import (
	"os"
	"strings"
	"testing"
)

// A config naming a key herd does not know must fail the load. yaml.v3 drops
// such keys silently, which is how a top-level `aliases:` block sat in the
// estate's herd.yaml for months: it parsed, it warned about nothing, and
// nothing in it was ever served.
func TestRejectsUnknownTopLevelKey(t *testing.T) {
	_, err := LoadConfigFromReader(strings.NewReader(`
aliases:
  fast:
    cmd: ./llama-server --port ${PORT}
models:
  m1:
    cmd: ./llama-server --port ${PORT}
`))
	if err == nil {
		t.Fatal("expected an error for unknown top-level key `aliases`")
	}
	if !strings.Contains(err.Error(), "aliases") {
		t.Errorf("error should name the offending key, got: %v", err)
	}
}

func TestAcceptsKnownTopLevelKeys(t *testing.T) {
	if _, err := LoadConfigFromReader(strings.NewReader(`
models:
  m1:
    cmd: ./llama-server --port ${PORT}
`)); err != nil {
		t.Fatalf("a valid config must load: %v", err)
	}
}

// `defs` holds YAML anchors consumed through `<<:` merge keys. The YAML
// parser resolves those itself and no Config field reads the block, so it
// must not be rejected.
func TestAcceptsDefsAnchorBlock(t *testing.T) {
	if _, err := LoadConfigFromReader(strings.NewReader(`
defs:
  llm: &llm
    in: [text]
    out: [text]
models:
  m1:
    cmd: ./llama-server --port ${PORT}
    capabilities:
      <<: [*llm]
`)); err != nil {
		t.Fatalf("defs/anchor configs must load: %v", err)
	}
}

// Unknown keys nested below the top level stay tolerated: the legacy
// `filters.strip_params` path decodes through an anonymous struct that must
// ignore fields it does not model.
func TestToleratesUnknownNestedKeys(t *testing.T) {
	if _, err := LoadConfigFromReader(strings.NewReader(`
models:
  m1:
    cmd: ./llama-server --port ${PORT}
    filters:
      strip_params: not-a-real-option
`)); err != nil {
		t.Fatalf("nested unknown keys must not fail the load: %v", err)
	}
}

// The configs the estate actually runs must load. This is the check that
// catches a silently-dropped section in production config.
func TestRealEstateConfigsLoad(t *testing.T) {
	for _, p := range []string{
		"/home/toxic/estate/config/herd.yaml",
		"/home/toxic/kimi-auto/herd.d/kimi-auto.yaml",
	} {
		f, err := os.Open(p)
		if err != nil {
			t.Skipf("config not present on this box: %s", p)
		}
		cfg, err := LoadConfigFromReader(f)
		f.Close()
		if err != nil {
			t.Errorf("%s must load: %v", p, err)
			continue
		}
		if len(cfg.Models) == 0 {
			t.Errorf("%s loaded with zero models", p)
		}
	}
}