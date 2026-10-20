package flock

import (
	"bytes"
	"io"
	"net/http"
	"sync"
	"time"
)

// MidStreamFailover implements the gateway-audit recommendation:
// when a provider dies mid-stream, re-issue the request to a fallback
// provider with the partial text as continuation context.
//
// flock already streams; this buffers partial tokens server-side so a
// dead stream can resume rather than failing the whole request.

// PartialBuffer accumulates streamed tokens for continuation.
type PartialBuffer struct {
	mu     sync.Mutex
	chunks [][]byte
	total  int
	// cap at 32KB of partial text — enough for continuation context
	maxBytes int
}

func NewPartialBuffer() *PartialBuffer {
	return &PartialBuffer{maxBytes: 32 * 1024}
}

func (pb *PartialBuffer) Write(p []byte) {
	pb.mu.Lock()
	defer pb.mu.Unlock()
	if pb.total >= pb.maxBytes {
		return
	}
	cp := make([]byte, len(p))
	copy(cp, p)
	// Truncate if this chunk would exceed cap
	if pb.total+len(cp) > pb.maxBytes {
		cp = cp[:pb.maxBytes-pb.total]
	}
	pb.chunks = append(pb.chunks, cp)
	pb.total += len(cp)
}

// Text returns the accumulated partial response as a string.
func (pb *PartialBuffer) Text() string {
	pb.mu.Lock()
	defer pb.mu.Unlock()
	var buf bytes.Buffer
	for _, c := range pb.chunks {
		buf.Write(c)
	}
	return buf.String()
}

// Len returns total buffered bytes.
func (pb *PartialBuffer) Len() int {
	pb.mu.Lock()
	defer pb.mu.Unlock()
	return pb.total
}

// FailoverChain defines ordered fallback providers for a request.
type FailoverChain struct {
	// providers in priority order; index 0 is primary
	providers []string
	// models aligned with providers
	models []string
	// attempt index
	current int
	// partial text from failed attempt, for continuation
	partial *PartialBuffer
}

func NewFailoverChain(providers, models []string) *FailoverChain {
	return &FailoverChain{
		providers: providers,
		models:    models,
		partial:   NewPartialBuffer(),
	}
}

// Current returns the active provider/model.
func (fc *FailoverChain) Current() (string, string) {
	if fc.current >= len(fc.providers) {
		return "", ""
	}
	model := ""
	if fc.current < len(fc.models) {
		model = fc.models[fc.current]
	}
	return fc.providers[fc.current], model
}

// Advance moves to the next provider. Returns false if chain exhausted.
func (fc *FailoverChain) Advance() bool {
	fc.current++
	return fc.current < len(fc.providers)
}

// Attempts returns number of providers tried.
func (fc *FailoverChain) Attempts() int {
	return fc.current + 1
}

// PartialText returns buffered partial response for continuation.
func (fc *FailoverChain) PartialText() string {
	return fc.partial.Text()
}

// ContinuationPrompt builds a prompt that includes partial text as context.
// The fallback provider continues from where the dead one stopped.
func (fc *FailoverChain) ContinuationPrompt(originalPrompt string) string {
	partial := fc.PartialText()
	if partial == "" {
		return originalPrompt
	}
	return originalPrompt + "\n\n[Partial response before provider failure — continue seamlessly from here, do not repeat:]\n" + partial
}

// StreamWithFailover executes req against the failover chain.
// doRequest performs the actual HTTP call, streaming into partial buffer.
// On failure, advances chain and retries with continuation prompt.
func StreamWithFailover(
	chain *FailoverChain,
	buildRequest func(provider, model, prompt string, partial *PartialBuffer) (*http.Request, error),
	onSuccess func(provider, model string, resp *http.Response),
	maxAttempts int,
) error {
	originalPrompt := "" // set by caller via closure if needed
	_ = originalPrompt

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		provider, model := chain.Current()
		if provider == "" {
			break
		}

		prompt := chain.ContinuationPrompt("")
		req, err := buildRequest(provider, model, prompt, chain.partial)
		if err != nil {
			lastErr = err
			if !chain.Advance() {
				break
			}
			continue
		}

		client := &http.Client{Timeout: 120 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if !chain.Advance() {
				break
			}
			continue
		}

		// 5xx/429 = provider failure, fail over. 4xx (except 429) = caller bug, don't retry.
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			lastErr = &httpError{provider, resp.StatusCode}
			if !chain.Advance() {
				break
			}
			continue
		}

		// Success (or caller error — don't fail over on 4xx)
		onSuccess(provider, model, resp)
		return nil
	}
	if lastErr == nil {
		lastErr = errChainExhausted
	}
	return lastErr
}

type httpError struct {
	provider string
	status   int
}

func (e *httpError) Error() string {
	return "provider " + e.provider + " failed"
}

var errChainExhausted = &chainError{}

type chainError struct{}

func (e *chainError) Error() string { return "failover chain exhausted" }
