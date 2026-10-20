#!/bin/bash
# =============================================================================
# MAXIMAL DEV SANDBOX — KIMI + ALL MODELS
# Run: bash scripts/sandbox_test.sh
# =============================================================================
set -euo pipefail

REPO="${HOME}/estate/ranch/mesh/router/herd"
cd "$REPO"

echo "=== [1/5] BUILD ==="
go build ./...

echo ""
echo "=== [2/5] UNIT TESTS (fast) ==="
go test ./internal/astmatrix/... -v -run TestCircuitBreaker 2>&1 | tail -5
go test ./internal/astmatrix/... -v -run TestRateLimiting 2>&1 | tail -5
go test ./internal/astmatrix/... -v -run TestCoalescing 2>&1 | tail -5
go test ./internal/astmatrix/... -v -run TestHealthDB 2>&1 | tail -5

echo ""
echo "=== [3/5] MOCK SERVER ==="
cat > /tmp/mock_server.go << 'GOEOF'
package main
import (
    "encoding/json"
    "net/http"
)
func main() {
    http.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
        var req map[string]interface{}
        json.NewDecoder(r.Body).Decode(&req)
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]interface{}{
            "id": "mock-123",
            "model": req["model"],
            "choices": []map[string]interface{}{
                {"message": map[string]string{"role": "assistant", "content": "Hello from mock"}},
            },
        })
    })
    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(200)
        w.Write([]byte(`{"status":"ok"}`))
    })
    println("Mock server on :9999")
    http.ListenAndServe(":9999", nil)
}
GOEOF
go run /tmp/mock_server.go &
MOCK_PID=$!
sleep 2

echo ""
echo "=== [4/5] LIVE TEST (needs API keys) ==="
if [ -n "${KIMI_API_KEY:-}" ] || [ -n "${OPENROUTER_API_KEY:-}" ] || [ -n "${GROQ_API_KEY:-}" ]; then
    LIVE_TEST=1 go test ./internal/astmatrix/... -v -run TestLiveKimi -timeout 300s 2>&1 | tail -20
else
    echo "SKIP: No API keys. Export KIMI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY"
fi

kill $MOCK_PID 2>/dev/null || true

echo ""
echo "=== [5/5] BENCHMARK ==="
go test ./internal/astmatrix/... -bench=. -benchmem 2>&1 | tail -10

echo ""
echo "=== SANDBOX COMPLETE ==="
