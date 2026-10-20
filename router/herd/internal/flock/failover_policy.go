package flock

import (
	"strings"
	"sync"
)

// FailoverPolicy implements declarative failover rules.
// Borrowed from ENTERPILOT/GoModel (Go) — config/failover_policy.go.
//
// Flock's failover is status-code-only. The real world is messier:
// providers return 200-with-error-text, or 4xx for upstream failures.
// This handles both with two rule types:
//
// 1. retry_on_statuses: ["429", "5xx"] (with "5xx" class expansion)
// 2. retry_on_errors: phrase list ("model not found", "upstream timed out",
//    "404 retired"...) where each phrase is AND-words plus optional status
//    constraints.
//
// The "404 retired" vs plain-404 distinction is critical for the
// phantom-model problem: a retired-model 404 should fail over to the next
// provider, but a plain endpoint 404 (wrong URL) should not.

type FailoverPolicy struct {
	mu sync.RWMutex
	// Statuses that trigger failover. "5xx" expands to 500-599.
	retryStatuses []string
	// Error phrases that trigger failover. Each phrase is a set of
	// words that must ALL appear (case-insensitive) in the error text.
	// Optional status constraint: phrase only applies to that status.
	retryPhrases []failoverPhrase
}

type failoverPhrase struct {
	words  []string // all must match (AND)
	status string   // optional: only applies to this status ("", "429", "5xx", "404")
}

func NewFailoverPolicy() *FailoverPolicy {
	fp := &FailoverPolicy{}
	// Sensible defaults for LLM providers
	fp.retryStatuses = []string{"429", "5xx"}
	fp.retryPhrases = []failoverPhrase{
		// Retired/dead models: fail over, don't poison
		{words: []string{"model", "not", "found"}},
		{words: []string{"model", "retired"}},
		{words: []string{"404", "retired"}},
		// Upstream failures masquerading as other codes
		{words: []string{"upstream", "timed", "out"}},
		{words: []string{"upstream", "unavailable"}},
		{words: []string{"provider", "error"}},
		{words: []string{"overloaded"}},
		// Rate limits in body text
		{words: []string{"rate", "limit"}},
		{words: []string{"too", "many", "requests"}},
	}
	return fp
}

// SetRetryStatuses replaces the status list.
func (fp *FailoverPolicy) SetRetryStatuses(statuses []string) {
	fp.mu.Lock()
	defer fp.mu.Unlock()
	fp.retryStatuses = append([]string{}, statuses...)
}

// AddPhrase adds a failover phrase. words are AND-matched (case-insensitive).
// status constrains to a specific status code/class ("", "404", "429", "5xx").
func (fp *FailoverPolicy) AddPhrase(words []string, status string) {
	fp.mu.Lock()
	defer fp.mu.Unlock()
	lower := make([]string, len(words))
	for i, w := range words {
		lower[i] = strings.ToLower(w)
	}
	fp.retryPhrases = append(fp.retryPhrases, failoverPhrase{
		words:  lower,
		status: status,
	})
}

// ShouldFailover decides if this failure warrants trying the next provider.
// statusCode: HTTP status (0 = no response / timeout).
// bodyText: response body or error message text (may be empty).
func (fp *FailoverPolicy) ShouldFailover(statusCode int, bodyText string) bool {
	fp.mu.RLock()
	defer fp.mu.RUnlock()

	// Check status rules first
	if fp.matchStatus(statusCode) {
		return true
	}

	// Check phrase rules against body text
	if bodyText != "" {
		lowerBody := strings.ToLower(bodyText)
		for _, phrase := range fp.retryPhrases {
			if phrase.status != "" && !fp.matchStatusPattern(statusCode, phrase.status) {
				continue
			}
			if matchAllWords(lowerBody, phrase.words) {
				return true
			}
		}
	}

	return false
}

// matchStatus checks if statusCode matches any retry status rule.
func (fp *FailoverPolicy) matchStatus(statusCode int) bool {
	for _, s := range fp.retryStatuses {
		if fp.matchStatusPattern(statusCode, s) {
			return true
		}
	}
	return false
}

// matchStatusPattern matches a status code against a pattern.
// Patterns: "429" (exact), "5xx" (class), "404" (exact).
func (fp *FailoverPolicy) matchStatusPattern(statusCode int, pattern string) bool {
	if pattern == "" {
		return true // no constraint
	}
	if strings.HasSuffix(pattern, "xx") {
		// Class match: "5xx" -> 500-599
		class := pattern[0] - '0'
		return statusCode/100 == int(class)
	}
	// Exact match
	var code int
	for _, c := range pattern {
		if c < '0' || c > '9' {
			return false
		}
		code = code*10 + int(c-'0')
	}
	return statusCode == code
}

func matchAllWords(text string, words []string) bool {
	for _, w := range words {
		if !strings.Contains(text, w) {
			return false
		}
	}
	return true
}

// IsRetiredModel checks specifically for retired/dead model signals.
// Use this to decide whether to mark a model as dead (vs transient failure).
func (fp *FailoverPolicy) IsRetiredModel(statusCode int, bodyText string) bool {
	lowerBody := strings.ToLower(bodyText)
	retiredSignals := [][]string{
		{"model", "not", "found"},
		{"model", "retired"},
		{"model", "deprecated"},
		{"404", "retired"},
		{"no", "such", "model"},
	}
	for _, words := range retiredSignals {
		if matchAllWords(lowerBody, words) {
			return true
		}
	}
	// 404 with model-ish body is likely retired (not wrong endpoint)
	if statusCode == 404 && strings.Contains(lowerBody, "model") {
		return true
	}
	return false
}
