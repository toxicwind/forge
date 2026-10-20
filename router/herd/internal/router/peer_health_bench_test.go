package router

import (
	"testing"
	"time"
)

// BenchmarkAdmit measures the per-request admission overhead on a healthy
// peer: one mutex, a state switch, and (usually) an immediate admit.
func BenchmarkAdmit(b *testing.B) {
	h := NewPeerHealth("bench", testHealthConfig(), testLogger)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		admit, _, _ := h.Admit()
		if !admit {
			b.Fatal("healthy peer denied admission")
		}
	}
}

// BenchmarkReportSuccess measures the per-request outcome-reporting overhead
// for the common case: a successful proxied response (EWMA update, ring
// push, recovery credit, degraded evaluation).
func BenchmarkReportSuccess(b *testing.B) {
	h := NewPeerHealth("bench", testHealthConfig(), testLogger)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.Report(OutcomeSuccess, time.Millisecond, "")
	}
}

// BenchmarkClassifyOutcome measures the taxonomy classification cost for a
// typical chat-completions 200 with a small body.
func BenchmarkClassifyOutcome(b *testing.B) {
	body := []byte(`{"choices":[{"message":{"content":"hello"}}]}`)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if c := ClassifyOutcome(200, "/v1/chat/completions", body, false, 0, true, false); c != OutcomeSuccess {
			b.Fatalf("class = %s, want success", c)
		}
	}
}
