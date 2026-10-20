package router

import (
	"net/url"
	"testing"

	"github.com/mostlygeek/herd/internal/config"
)

// TestHerdFQNEstateRegression — estate-shaped regression test for the
// 2026-09-20 incident: a stale herd binary registered only bare model
// names and silently dropped cross-peer duplicates ("already mapped to
// another peer, skipping"), so OpenFang's qualified request
// openrouter-free/nex-agi/nex-n2.5-mini:free died with "Model not found".
// FQN keys (peerID + "/" + modelID) must ALWAYS resolve; bare names only
// when unique across peers (upstream mostlygeek/herd semantics).
func TestHerdFQNEstateRegression(t *testing.T) {
	mkPeers := func() config.PeerDictionaryConfig {
		peers := config.PeerDictionaryConfig{}
		add := func(id, proxy string, models ...string) {
			u, _ := url.Parse(proxy)
			peers[id] = config.PeerConfig{Proxy: proxy, ProxyURL: u, Models: models}
		}
		add("openrouter-free", "http://127.0.0.1:25109",
			"nex-agi/nex-n2.5-mini:free", "qwen3.5-9b-tool")
		add("openrouter-paid", "http://127.0.0.1:25110",
			"nex-agi/nex-n2.5-mini:free", "anthropic/claude-sonnet-4")
		add("toolcall-local", "http://127.0.0.1:25152",
			"qwen3.5-9b-tool")
		add("moonshot", "https://api.moonshot.ai",
			"moonshotai/kimi-k2.6")
		return peers
	}

	pr, err := NewPeer(config.Config{Peers: mkPeers()}, testLogger)
	if err != nil {
		t.Fatal(err)
	}

	// Every (peer, model) FQN must resolve to that peer's route.
	fqnCases := []struct{ peer, model string }{
		{"openrouter-free", "nex-agi/nex-n2.5-mini:free"},
		{"openrouter-paid", "nex-agi/nex-n2.5-mini:free"},
		{"openrouter-free", "qwen3.5-9b-tool"},
		{"toolcall-local", "qwen3.5-9b-tool"},
		{"openrouter-paid", "anthropic/claude-sonnet-4"},
		{"moonshot", "moonshotai/kimi-k2.6"},
	}
	for _, tc := range fqnCases {
		key := config.PeerModelFQN(tc.peer, tc.model)
		route, ok := pr.peers[key]
		if !ok {
			t.Errorf("FQN %q not registered (regression: qualified model would 404)", key)
			continue
		}
		if route.member.peerID != tc.peer {
			t.Errorf("FQN %q routed to peer %q, want %q", key, route.member.peerID, tc.peer)
		}
		if route.modelID != tc.model {
			t.Errorf("FQN %q route modelID = %q, want %q", key, route.modelID, tc.model)
		}
	}

	// Colliding bare names must NOT resolve bare (ambiguous across peers).
	for _, bare := range []string{"nex-agi/nex-n2.5-mini:free", "qwen3.5-9b-tool"} {
		if _, ok := pr.peers[bare]; ok {
			t.Errorf("colliding bare model %q resolved; want it skipped (upstream semantics)", bare)
		}
	}

	// Unique bare names must resolve to their peer.
	unique := map[string]string{
		"anthropic/claude-sonnet-4": "openrouter-paid",
		"moonshotai/kimi-k2.6":      "moonshot",
	}
	for bare, wantPeer := range unique {
		route, ok := pr.peers[bare]
		if !ok {
			t.Errorf("unique bare model %q not registered", bare)
			continue
		}
		if route.member.peerID != wantPeer {
			t.Errorf("bare %q routed to %q, want %q", bare, route.member.peerID, wantPeer)
		}
	}
}
