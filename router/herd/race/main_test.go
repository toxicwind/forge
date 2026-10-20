package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func bodyWith(content string) []byte {
	b, _ := json.Marshal(map[string]any{
		"choices": []map[string]any{
			{"message": map[string]string{"role": "assistant", "content": content}, "finish_reason": "stop"},
		},
	})
	return b
}

func TestValidCompletion(t *testing.T) {
	if !validCompletion(200, bodyWith("func Reverse(s string) string {\n\tr := []rune(s)\n\treturn string(r)\n}")) {
		t.Error("legit code completion judged invalid")
	}

	// Pollinations shared-budget notice: HTTP 200, 538 chars, must be invalid.
	budget := "The account behind this API key doesn't have enough credits. Please [top up](https://enter.pollinations.ai/top-up?ref=agent_low_balance_topup) or [complete a quest](https://enter.pollinations.ai/quest) " + strings.Repeat("x", 350)
	if len(budget) < 500 {
		t.Fatalf("test budget notice too short: %d", len(budget))
	}
	if validCompletion(200, bodyWith(budget)) {
		t.Error("budget notice judged valid")
	}

	if validCompletion(200, bodyWith("")) {
		t.Error("empty content judged valid")
	}
	if validCompletion(401, []byte(`{"error":"unauthorized"}`)) {
		t.Error("http 401 judged valid")
	}
	if validCompletion(200, []byte(`{"choices":[{"message":{"content":"oops"}`)) {
		t.Error("malformed json judged valid")
	}
	// A long legit answer mentioning "api key" deep in the body stays valid.
	long := strings.Repeat("code line\n", 100) + "note: pass the api key via header"
	if !validCompletion(200, bodyWith(long)) {
		t.Error("long legit answer with late 'api key' mention judged invalid")
	}
	// Same mention in the head is rejected.
	if validCompletion(200, bodyWith("the api key goes in the Authorization header\n"+strings.Repeat("code\n", 100))) {
		t.Error("head 'api key' mention judged valid")
	}
}
