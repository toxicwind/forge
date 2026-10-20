package main

import (
	"encoding/json"
	"strings"
)

// validCompletion reports whether an upstream response is a usable completion:
// HTTP 200, well-formed JSON, non-empty message content, and not a provider
// budget/quota notice. Mentions of "api key" in the head of the content are
// treated as provider notices; a late mention inside an otherwise long,
// code-bearing answer stays valid.
func validCompletion(status int, body []byte) bool {
	if status != 200 {
		return false
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	if len(payload.Choices) == 0 {
		return false
	}
	content := strings.TrimSpace(payload.Choices[0].Message.Content)
	if content == "" {
		return false
	}
	lower := strings.ToLower(content)
	head := lower
	if len(head) > 256 {
		head = head[:256]
	}
	noticeMarkers := []string{
		"doesn't have enough credits",
		"don't have enough credits",
		"not enough credits",
		"insufficient credits",
		"insufficient_quota",
		"quota exceeded",
		"please [top up]",
		"top up](http",
		"low_balance",
		"balance_topup",
	}
	for _, marker := range noticeMarkers {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	// "api key" in the opening of the content is a provider auth notice;
	// deep in a long answer it is ordinary prose. The 256-char head window
	// above already encodes that distinction; gating on total length let a
	// head mention through whenever the body was long.
	if strings.Contains(head, "api key") {
		return false
	}
	return true
}
