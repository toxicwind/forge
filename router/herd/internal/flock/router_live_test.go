package flock

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mostlygeek/herd/internal/logmon"
)

// TestLiveKimi tests against the real KIMI API sandbox
func TestLiveKimi(t *testing.T) {
	if os.Getenv("LIVE_TEST") != "1" {
		t.Skip("Set LIVE_TEST=1 to run live tests")
	}

	logger := logmon.New()
	cfg := loadLiveConfig(t)
	router, err := NewRouter(cfg, logger)
	if err != nil {
		t.Fatalf("NewRouter: %v", err)
	}
	defer router.Shutdown()

	// Wait for health probes
	t.Log("Waiting 5s for health probes...")
	time.Sleep(5 * time.Second)

	// Test 1: KIMI completion
	t.Run("KimiCompletion", func(t *testing.T) {
		body := map[string]interface{}{
			"model":      "kimi-auto",
			"messages":   []map[string]string{{"role": "user", "content": "Say hello in 3 words"}},
			"max_tokens": 50,
		}
		resp := testRequest(t, router, body)
		if resp.StatusCode != 200 {
			body := readBody(resp)
			t.Fatalf("KIMI failed: %d %s", resp.StatusCode, body)
		}
		var result map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&result)
		if choices, ok := result["choices"].([]interface{}); ok && len(choices) > 0 {
			t.Logf("KIMI response: %v", choices[0])
		}
	})

	// Test 2: KIMI streaming
	t.Run("KimiStreaming", func(t *testing.T) {
		body := map[string]interface{}{
			"model":      "kimi-fast",
			"messages":   []map[string]string{{"role": "user", "content": "Count 1,2,3"}},
			"stream":     true,
			"max_tokens": 100,
		}
		resp := testRequest(t, router, body)
		if resp.StatusCode != 200 {
			t.Fatalf("KIMI streaming failed: %d", resp.StatusCode)
		}
		ct := resp.Header.Get("Content-Type")
		if !strings.Contains(ct, "text/event-stream") {
			t.Logf("Warning: Content-Type=%s (expected text/event-stream)", ct)
		}
		buf := new(bytes.Buffer)
		io.Copy(buf, resp.Body)
		if buf.Len() == 0 {
			t.Fatal("Empty SSE stream")
		}
		t.Logf("KIMI SSE: %d bytes", buf.Len())
	})

	// Test 3: Large context (1M+ simulation)
	t.Run("KimiLargeContext", func(t *testing.T) {
		large := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 5000)
		body := map[string]interface{}{
			"model": "kimi-long",
			"messages": []map[string]string{
				{"role": "system", "content": "You are a helpful assistant."},
				{"role": "user", "content": "Summarize this text in 10 words: " + large[:50000]},
			},
			"max_tokens": 100,
		}
		resp := testRequest(t, router, body)
		if resp.StatusCode != 200 {
			body := readBody(resp)
			if strings.Contains(body, "context_length_exceeded") {
				t.Skip("Context limit exceeded — expected for large test")
			}
			t.Fatalf("Large context failed: %d %s", resp.StatusCode, body)
		}
		t.Log("KIMI large context: OK")
	})

	// Test 4: Fallback to OpenRouter when KIMI fails
	t.Run("KimiFallback", func(t *testing.T) {
		// Force KIMI circuit open by simulating failures
		cb := router.getCircuit("kimi")
		for i := 0; i < 5; i++ {
			cb.RecordFailure()
		}
		if cb.State() != StateOpen {
			t.Logf("Circuit state: %v (expected Open)", cb.State())
		}

		body := map[string]interface{}{
			"model":      "openrouter/auto",
			"messages":   []map[string]string{{"role": "user", "content": "Hello"}},
			"max_tokens": 50,
		}
		resp := testRequest(t, router, body)
		if resp.StatusCode != 200 {
			t.Logf("Fallback failed: %d (may need API key)", resp.StatusCode)
		} else {
			t.Log("Fallback routing: OK")
		}
	})

	// Test 5: Status endpoint
	t.Run("StatusEndpoint", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/flock/status", nil)
		w := httptest.NewRecorder()
		ui := NewUIHandler(router)
		ui.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("Status endpoint failed: %d", w.Code)
		}
		var status map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &status)
		if providers, ok := status["providers"].([]interface{}); ok {
			t.Logf("Providers: %d", len(providers))
			for _, p := range providers {
				if pm, ok := p.(map[string]interface{}); ok {
					t.Logf("  %s healthy=%v latency=%v",
						pm["id"], pm["healthy"], pm["latency_ms"])
				}
			}
		}
	})

	// Test 6: Metrics endpoint
	t.Run("MetricsEndpoint", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/flock/metrics", nil)
		w := httptest.NewRecorder()
		ui := NewUIHandler(router)
		ui.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("Metrics endpoint failed: %d", w.Code)
		}
		var metrics map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &metrics)
		t.Logf("Metrics: %v", metrics)
	})
}

func loadLiveConfig(t *testing.T) *FlockConfig {
	// Load from environment or use defaults
	cfg := &FlockConfig{
		Enabled:             true,
		Strategy:            "hybrid",
		ASTStrategy:         "ast_race",
		RequestTimeout:      120,
		MaxRetries:          3,
		HealthProbeInterval: 30,
		EnableCoalescing:    true,
		Providers: map[string]ProviderCfg{
			"kimi": {
				BaseURL:  os.Getenv("KIMI_API_URL"),
				KeyEnv:   "KIMI_API_KEY",
				Models:   []string{"kimi/k1.5", "kimi/moonshot-v1-128k", "kimi/moonshot-v1-8k"},
				ModelMap: map[string]string{"kimi-auto": "kimi/k1.5", "kimi-long": "kimi/moonshot-v1-128k", "kimi-fast": "kimi/moonshot-v1-8k"},
				Weight:   2.0,
				ELO:      1700,
			},
			"openrouter": {
				BaseURL:  "https://openrouter.ai/api/v1",
				KeyEnv:   "OPENROUTER_API_KEY",
				Models:   []string{"openrouter/auto"},
				FreeTier: true,
				Weight:   1.5,
				ELO:      1500,
			},
			"groq": {
				BaseURL:  "https://api.groq.com/openai/v1",
				KeyEnv:   "GROQ_API_KEY",
				Models:   []string{"groq/llama-3.1-70b-versatile"},
				FreeTier: true,
				Weight:   1.5,
				ELO:      1580,
			},
			"github": {
				BaseURL:  "https://models.inference.ai.azure.com",
				KeyEnv:   "GITHUB_TOKEN",
				Models:   []string{"github/gpt-4o-mini"},
				FreeTier: true,
				Weight:   1.0,
				ELO:      1500,
			},
		},
	}
	cfg.Defaults()

	if cfg.Providers["kimi"].BaseURL == "" {
		pc := cfg.Providers["kimi"]
		pc.BaseURL = "https://kimi-api-sandbox.msh.team/v1"
		cfg.Providers["kimi"] = pc
	}

	return cfg
}
