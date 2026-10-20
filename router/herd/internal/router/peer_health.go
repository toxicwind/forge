package router

// Event-driven per-peer health state machine for the herd router.
//
// Design notes (borrowed, not invented):
//   - The state discipline (closed / half-open / open, two-step admit-then-report,
//     admission identity — probe flag plus generation — so stale outcomes can
//     never be mistaken for the half-open probe) follows the sony/gobreaker
//     pattern: admission is checked before the request, the outcome is reported
//     exactly once when the response completes or the transport fails.
//   - Routing signals follow HACO / SkyWalker / the vLLM semantic router literature:
//     decisions are made on observed latency and reliability at the binding point,
//     never on nominal/static health.
//   - Failure impact is confined to the failing peer (Tarragon): an open circuit
//     fails fast for that peer only; nothing restarts, nothing poisons the rest.
//
// Event-driven means exactly that: there are no timers, no polling loops, no
// background goroutines here. Transitions happen when a real outcome is reported.
// Half-open recovery is demand-driven — after the configured cool-off has elapsed,
// the next real request is admitted as a single-flight probe (checked lazily at
// request time). Concurrent requests while a probe is in flight are rejected.
//
// Outcome classes reuse the herd reliability taxonomy: 402-not-entitled,
// 404-dead-id, 429-throttled, 200-empty, 403-refused, plus 5xx, transport
// failures, success, and client-cancelled (neutral).

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mostlygeek/herd/internal/config"
	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/tidwall/gjson"
)

// OutcomeClass is one bucket of the herd reliability taxonomy, observed at the
// peer binding point.
type OutcomeClass string

const (
	OutcomeSuccess     OutcomeClass = "success"
	OutcomeEmpty200    OutcomeClass = "200-empty"
	OutcomeThrottled   OutcomeClass = "429-throttled"
	OutcomeNotEntitled OutcomeClass = "402-not-entitled"
	OutcomeDeadID      OutcomeClass = "404-dead-id"
	OutcomeRefused     OutcomeClass = "403-refused"
	OutcomeServerError OutcomeClass = "5xx"
	OutcomeTransport   OutcomeClass = "transport"
	// OutcomeCancelled means the client went away mid-request. It is neutral:
	// it updates latency signal but never moves the failure score.
	OutcomeCancelled OutcomeClass = "cancelled"
)

// HealthState is the externally visible health of a peer.
type HealthState string

const (
	HealthHealthy     HealthState = "healthy"
	HealthDegraded    HealthState = "degraded"
	HealthCircuitOpen HealthState = "circuit-open"
	// HealthHalfOpen is the single-flight recovery probe state. It is real and
	// observable: exactly one real request is admitted while half-open.
	HealthHalfOpen HealthState = "half-open"
)

// healthRingSize is the rolling outcome window used for the error-rate signal.
const healthRingSize = 32

// healthRingMinSamples gates the error-rate degraded signal so a lone early
// failure cannot mark a fresh peer degraded.
const healthRingMinSamples = 8

// maxClassifyBody bounds how much response body is retained for 200-empty
// classification (empty choices detection). Streams are classified from
// incrementally counted SSE data payloads instead.
const maxClassifyBody = 32 * 1024

// ClassifyOutcome maps an observed proxy result onto the reliability taxonomy.
// Exactly one of: clientGone (neutral), !completed (transport), HTTP status
// classes, or — for completed 2xx — the 200-empty honesty check.
func ClassifyOutcome(status int, path string, body []byte, streamed bool, dataPayloads int, completed bool, clientGone bool) OutcomeClass {
	if clientGone {
		return OutcomeCancelled
	}
	if !completed {
		return OutcomeTransport
	}
	switch status {
	case http.StatusTooManyRequests:
		return OutcomeThrottled
	case 402:
		return OutcomeNotEntitled
	case http.StatusNotFound:
		return OutcomeDeadID
	case http.StatusForbidden:
		return OutcomeRefused
	}
	if status >= 500 && status <= 599 {
		return OutcomeServerError
	}
	if status < 200 || status >= 300 {
		// Any other non-2xx (400, 401, 405, 422, 3xx, ...): the peer refused
		// the request in some form.
		return OutcomeRefused
	}
	if streamed {
		if dataPayloads == 0 && completionPathRelevant(path) {
			return OutcomeEmpty200
		}
		return OutcomeSuccess
	}
	if len(bytes.TrimSpace(body)) == 0 {
		if completionPathRelevant(path) {
			return OutcomeEmpty200
		}
		return OutcomeSuccess
	}
	if isChatCompletionsPath(path) && emptyChoices(body) {
		return OutcomeEmpty200
	}
	return OutcomeSuccess
}

// completionPathRelevant reports whether the path is a completion-type
// endpoint where an empty 200 is evidence of an unusable peer (200-empty).
// Unrelated successful endpoints — model lists, health checks — may
// legitimately return empty bodies and must never trip the empty class.
func completionPathRelevant(path string) bool {
	for _, seg := range []string{
		"chat/completions",
		"/completions",
		"/embeddings",
		"/audio/",
		"/images/",
	} {
		if strings.Contains(path, seg) {
			return true
		}
	}
	return false
}

func isChatCompletionsPath(path string) bool {
	return strings.Contains(path, "chat/completions")
}

// emptyChoices reports whether body is a chat-completions payload whose choices
// array is present but empty — the canonical 200-empty shape from probes.
func emptyChoices(body []byte) bool {
	choices := gjson.GetBytes(body, "choices")
	return choices.Exists() && choices.IsArray() && len(choices.Array()) == 0
}

// PeerHealth is the per-peer health tracker: EWMA latency, rolling error rate,
// weighted failure score, and the healthy/degraded/circuit-open (+ half-open)
// state machine. The zero value is not usable; use NewPeerHealth.
type PeerHealth struct {
	peerID string
	cfg    config.HealthConfig
	log    *logmon.Monitor

	mu             sync.Mutex
	state          HealthState
	probeInFlight  bool
	openedAt       time.Time
	generation     uint64
	failureScore   float64
	consecFailure  int
	consecSuccess  int
	probeSuccesses int
	ewmaMs         float64
	ewmaSamples    uint64
	ring           []OutcomeClass
	ringPos        int
	ringCount      int
}

// NewPeerHealth builds a tracker for one peer. Defaults are applied to cfg.
func NewPeerHealth(peerID string, cfg config.HealthConfig, log *logmon.Monitor) *PeerHealth {
	cfg.ApplyDefaults()
	h := &PeerHealth{
		peerID: peerID,
		cfg:    cfg,
		log:    log,
		state:  HealthHealthy,
		ring:   make([]OutcomeClass, healthRingSize),
	}
	if log != nil {
		log.Infof("peer-health peer=%s initialized state=healthy failure_threshold=%.1f cool_off=%ds ewma_alpha=%.2f weights=%v",
			peerID, cfg.FailureThreshold, int64(cfg.CoolOffSeconds), cfg.EWMAAlpha, cfg.Weights)
	}
	return h
}

// Admit decides whether a request may use the peer right now. The second return
// value marks the request as the single-flight half-open probe; the third is
// the current generation — the admission identity the request must present when
// it reports its outcome. Denied callers must fail fast (503) — the peer is
// ejected from rotation.
func (h *PeerHealth) Admit() (admit bool, probe bool, gen uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch h.state {
	case HealthCircuitOpen:
		if h.probeInFlight {
			return false, false, h.generation
		}
		if time.Since(h.openedAt) >= h.coolOff() {
			h.probeInFlight = true
			h.transitionLocked(HealthHalfOpen, OutcomeSuccess, "cool-off elapsed; admitting single real-traffic probe")
			return true, true, h.generation
		}
		return false, false, h.generation
	case HealthHalfOpen:
		if h.probeInFlight {
			return false, false, h.generation
		}
		h.probeInFlight = true
		return true, true, h.generation
	default:
		return true, false, h.generation
	}
}

// Report records exactly one outcome for an admitted request. It is safe for
// concurrent use and idempotent per request only if the caller reports once
// (the response observer enforces exactly-once with sync.Once).
//
// Report carries no admission identity, so it is treated as an ordinary
// request: it feeds telemetry and the failure score but can never drive
// half-open probe accounting. The probe path uses reportOutcome with the
// identity Admit returned, so a late outcome from a pre-trip request can never
// be mistaken for the probe — stale success must never readmit, stale failure
// must never steal the probe slot.
func (h *PeerHealth) Report(class OutcomeClass, latency time.Duration, detail string) {
	h.reportOutcome(class, latency, detail, false, 0)
}

// reportOutcome records one outcome. probe/gen are the admission identity from
// Admit: probe is true only for the request admitted as the single-flight
// half-open probe, gen is the generation Admit returned. Only an outcome whose
// identity matches the live probe (same generation, still half-open, still the
// in-flight probe) drives probe accounting. Every other outcome — including
// stale ones from before the last transition — still feeds latency/error
// telemetry, but during half-open it must not move the failure score or probe
// state: its failure evidence was already priced into the trip that opened the
// circuit, and the probe is the only new information.
func (h *PeerHealth) reportOutcome(class OutcomeClass, latency time.Duration, detail string, probe bool, gen uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.observeLatencyLocked(latency)
	h.ringPushLocked(class)

	weight := h.cfg.WeightFor(string(class))
	isProbe := probe && gen == h.generation && h.state == HealthHalfOpen && h.probeInFlight

	if h.state == HealthHalfOpen && !isProbe {
		// Controlled experiment in progress: telemetry only.
		return
	}

	switch {
	case class == OutcomeCancelled:
		// Neutral: never moves the score. A cancelled probe must not wedge
		// half-open — re-open so the next real request can probe again.
		if isProbe {
			h.probeInFlight = false
			h.transitionLocked(HealthCircuitOpen, class, "half-open probe cancelled by client; circuit re-opened")
		}
	case class == OutcomeSuccess:
		h.consecSuccess++
		h.consecFailure = 0
		h.failureScore -= h.cfg.RecoveryCredit
		if h.failureScore < 0 {
			h.failureScore = 0
		}
		if isProbe {
			h.probeSuccesses++
			if h.probeSuccesses >= h.cfg.SuccessThreshold {
				h.probeInFlight = false
				h.probeSuccesses = 0
				h.transitionLocked(HealthHealthy, class, "half-open probe succeeded; peer readmitted to rotation")
			} else {
				// Threshold not yet met: release single-flight so the next
				// real request becomes the next probe.
				h.probeInFlight = false
			}
		}
	default:
		h.consecFailure++
		h.consecSuccess = 0
		h.failureScore += weight
		if isProbe {
			h.probeInFlight = false
			h.probeSuccesses = 0
			h.transitionLocked(HealthCircuitOpen, class,
				fmt.Sprintf("half-open probe failed class=%s; circuit re-opened", class))
		} else if h.state != HealthCircuitOpen && h.failureScore >= h.cfg.FailureThreshold {
			h.transitionLocked(HealthCircuitOpen, class,
				fmt.Sprintf("failure score %.1f >= threshold %.1f (%s)", h.failureScore, h.cfg.FailureThreshold, detail))
		}
	}

	if h.state == HealthHealthy || h.state == HealthDegraded {
		h.evalDegradedLocked(class)
	}
}

// State returns the current health state.
func (h *PeerHealth) State() HealthState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.state
}

// RetryAfter reports how long until a half-open probe may be admitted. Zero
// when the circuit is not open.
func (h *PeerHealth) RetryAfter() time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state != HealthCircuitOpen {
		return 0
	}
	rem := h.coolOff() - time.Since(h.openedAt)
	if rem < 0 {
		return 0
	}
	return rem
}

// HealthSnapshot is the JSON-serializable view served by /peer-health.
type HealthSnapshot struct {
	Peer             string      `json:"peer"`
	State            HealthState `json:"state"`
	HalfOpenProbe    bool        `json:"half_open_probe,omitempty"`
	FailureScore     float64     `json:"failure_score"`
	FailureThreshold float64     `json:"failure_threshold"`
	ConsecutiveFails int         `json:"consecutive_failures"`
	ConsecutiveOK    int         `json:"consecutive_successes"`
	EWMALatencyMs    float64     `json:"ewma_latency_ms"`
	EWMASamples      uint64      `json:"ewma_samples"`
	ErrorRate        float64     `json:"error_rate"`
	Transitions      uint64      `json:"transitions"`
	OpenedAt         *time.Time  `json:"opened_at,omitempty"`
	RetryAfterMs     int64       `json:"retry_after_ms,omitempty"`
}

// Snapshot captures the current health view.
func (h *PeerHealth) Snapshot() HealthSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	snap := HealthSnapshot{
		Peer:             h.peerID,
		State:            h.state,
		HalfOpenProbe:    h.probeInFlight,
		FailureScore:     h.failureScore,
		FailureThreshold: h.cfg.FailureThreshold,
		ConsecutiveFails: h.consecFailure,
		ConsecutiveOK:    h.consecSuccess,
		EWMALatencyMs:    h.ewmaMs,
		EWMASamples:      h.ewmaSamples,
		ErrorRate:        h.errorRateLocked(),
		Transitions:      h.generation,
	}
	if h.state == HealthCircuitOpen {
		t := h.openedAt
		snap.OpenedAt = &t
		snap.RetryAfterMs = int64(h.RetryAfterLocked() / time.Millisecond)
	}
	return snap
}

func (h *PeerHealth) coolOff() time.Duration {
	return time.Duration(h.cfg.CoolOffSeconds * float64(time.Second))
}

// RetryAfterLocked is RetryAfter assuming h.mu is held.
func (h *PeerHealth) RetryAfterLocked() time.Duration {
	if h.state != HealthCircuitOpen {
		return 0
	}
	rem := h.coolOff() - time.Since(h.openedAt)
	if rem < 0 {
		return 0
	}
	return rem
}

func (h *PeerHealth) observeLatencyLocked(latency time.Duration) {
	ms := float64(latency) / float64(time.Millisecond)
	if h.ewmaSamples == 0 {
		h.ewmaMs = ms
	} else {
		a := h.cfg.EWMAAlpha
		h.ewmaMs = a*ms + (1-a)*h.ewmaMs
	}
	h.ewmaSamples++
}

func (h *PeerHealth) ringPushLocked(class OutcomeClass) {
	h.ring[h.ringPos] = class
	h.ringPos = (h.ringPos + 1) % healthRingSize
	if h.ringCount < healthRingSize {
		h.ringCount++
	}
}

// errorRateLocked is the fraction of the rolling window with failure weight > 0.
func (h *PeerHealth) errorRateLocked() float64 {
	if h.ringCount == 0 {
		return 0
	}
	bad := 0
	for i := 0; i < h.ringCount; i++ {
		if h.cfg.WeightFor(string(h.ring[i])) > 0 {
			bad++
		}
	}
	return float64(bad) / float64(h.ringCount)
}

func (h *PeerHealth) evalDegradedLocked(class OutcomeClass) {
	latBad := h.cfg.DegradedLatencyMs > 0 && h.ewmaSamples > 0 && h.ewmaMs >= h.cfg.DegradedLatencyMs
	errBad := h.cfg.DegradedErrorRate > 0 && h.ringCount >= healthRingMinSamples &&
		h.errorRateLocked() >= h.cfg.DegradedErrorRate
	reason := ""
	switch {
	case latBad && errBad:
		reason = fmt.Sprintf("ewma latency %.0fms >= %.0fms and error rate above threshold", h.ewmaMs, h.cfg.DegradedLatencyMs)
	case latBad:
		reason = fmt.Sprintf("ewma latency %.0fms >= %.0fms", h.ewmaMs, h.cfg.DegradedLatencyMs)
	case errBad:
		reason = fmt.Sprintf("rolling error rate %.2f >= %.2f", h.errorRateLocked(), h.cfg.DegradedErrorRate)
	}
	if h.state == HealthHealthy && reason != "" {
		h.transitionLocked(HealthDegraded, class, reason)
	} else if h.state == HealthDegraded && reason == "" {
		h.transitionLocked(HealthHealthy, class, "latency and error rate recovered below degraded thresholds")
	}
}

// transitionLocked moves the state machine, bumps the generation (so stale
// outcomes can never undo a transition), and emits the structured audit log.
// The log line carries no URLs, credentials, headers, or bodies.
func (h *PeerHealth) transitionLocked(to HealthState, class OutcomeClass, reason string) {
	from := h.state
	if from == to {
		return
	}
	h.state = to
	h.generation++
	if to == HealthCircuitOpen {
		h.openedAt = time.Now()
		h.probeSuccesses = 0
		// Entering open retires any probe slot: no transition into open may
		// leave single-flight admission wedged — the next cool-off expiry
		// admits a fresh probe.
		h.probeInFlight = false
	}
	if from == HealthHalfOpen && to == HealthHealthy {
		// A successful probe is proven health: the peer rejoins with a clean
		// failure slate. Re-ejection needs the full configured threshold of
		// fresh evidence - a recovered peer must not sit one failure away
		// from the circuit reopening.
		h.failureScore = 0
	}
	if h.log == nil {
		return
	}
	line := fmt.Sprintf("peer-health peer=%s gen=%d %s->%s class=%s score=%.1f/%.1f ewma_ms=%.0f err_rate=%.2f reason=%q",
		h.peerID, h.generation, from, to, class,
		h.failureScore, h.cfg.FailureThreshold, h.ewmaMs, h.errorRateLocked(), reason)
	if to == HealthCircuitOpen {
		h.log.Warnf("%s", line)
	} else {
		h.log.Infof("%s", line)
	}
}

// ---------------------------------------------------------------------------
// Request observation: exactly-once outcome reporting per proxied request.
// ---------------------------------------------------------------------------

// healthObserverKey is the request-context key carrying the *healthObserver.
type healthObserverKey struct{}

func healthObserverFrom(ctx context.Context) *healthObserver {
	obs, _ := ctx.Value(healthObserverKey{}).(*healthObserver)
	return obs
}

// healthObserver tracks one admitted request from admission to completion and
// reports exactly one outcome to its PeerHealth.
type healthObserver struct {
	health    *PeerHealth
	ctx       context.Context
	path      string
	streaming bool
	status    int
	start     time.Time
	// probe/gen are the admission identity from Admit, reported back with the
	// outcome so only the real probe drives half-open accounting.
	probe bool
	gen   uint64

	once         sync.Once
	bodyBuf      []byte
	truncated    bool
	lineBuf      []byte
	dataPayloads int
}

func newHealthObserver(health *PeerHealth, r *http.Request, streaming bool, probe bool, gen uint64) *healthObserver {
	return &healthObserver{
		health:    health,
		ctx:       r.Context(),
		path:      r.URL.Path,
		streaming: streaming,
		start:     time.Now(),
		probe:     probe,
		gen:       gen,
	}
}

// finishTransport records a proxy transport failure (ErrorHandler path).
func (o *healthObserver) finishTransport(err error) {
	o.once.Do(func() {
		class := OutcomeTransport
		if o.ctx.Err() != nil {
			class = OutcomeCancelled
		}
		msg := ""
		if err != nil {
			msg = firstLine(err.Error(), 200)
		}
		o.health.reportOutcome(class, time.Since(o.start), "transport: "+msg, o.probe, o.gen)
	})
}

// finishStatus records an immediately-classifiable non-2xx response.
func (o *healthObserver) finishStatus(status int) {
	o.status = status
	o.once.Do(func() {
		class := ClassifyOutcome(status, o.path, nil, false, 0, true, false)
		o.health.reportOutcome(class, time.Since(o.start), fmt.Sprintf("status=%d", status), o.probe, o.gen)
	})
}

func (o *healthObserver) noteBytes(p []byte) {
	if o.streaming {
		o.scanSSE(p)
		return
	}
	if len(o.bodyBuf) < maxClassifyBody {
		o.bodyBuf = append(o.bodyBuf, p...)
		if len(o.bodyBuf) > maxClassifyBody {
			o.bodyBuf = o.bodyBuf[:maxClassifyBody]
			o.truncated = true
		}
	}
}

// scanSSE incrementally counts SSE data payloads (excluding [DONE]).
func (o *healthObserver) scanSSE(p []byte) {
	o.lineBuf = append(o.lineBuf, p...)
	if len(o.lineBuf) > 65536 {
		// Pathological line without newline: drop the buffer rather than grow.
		o.lineBuf = o.lineBuf[:0]
		return
	}
	for {
		i := bytes.IndexByte(o.lineBuf, '\n')
		if i < 0 {
			break
		}
		o.countSSELine(o.lineBuf[:i])
		o.lineBuf = o.lineBuf[i+1:]
	}
}

// countSSELine counts one raw SSE line as a data payload unless it is empty
// or the [DONE] terminator.
func (o *healthObserver) countSSELine(raw []byte) {
	line := bytes.TrimSpace(raw)
	if bytes.HasPrefix(line, []byte("data:")) {
		payload := bytes.TrimSpace(line[len("data:"):])
		if len(payload) > 0 && !bytes.Equal(payload, []byte("[DONE]")) {
			o.dataPayloads++
		}
	}
}

// flushSSELine counts a final data line that arrived without a trailing
// newline, so a cleanly-terminated stream is never misread as 200-empty.
func (o *healthObserver) flushSSELine() {
	if !o.streaming || len(o.lineBuf) == 0 {
		return
	}
	o.countSSELine(o.lineBuf)
	o.lineBuf = o.lineBuf[:0]
}

// finishAtEOF records a fully-read response body.
func (o *healthObserver) finishAtEOF() {
	o.once.Do(func() {
		o.flushSSELine()
		class := ClassifyOutcome(o.status, o.path, o.bodyBuf, o.streaming, o.dataPayloads, true, false)
		o.health.reportOutcome(class, time.Since(o.start),
			fmt.Sprintf("status=%d streamed=%v payloads=%d", o.status, o.streaming, o.dataPayloads),
			o.probe, o.gen)
	})
}

// finishAtClose records a body closed before EOF (early disconnect / error).
func (o *healthObserver) finishAtClose() {
	o.once.Do(func() {
		clientGone := o.ctx.Err() != nil
		class := ClassifyOutcome(o.status, o.path, o.bodyBuf, o.streaming, o.dataPayloads, false, clientGone)
		o.health.reportOutcome(class, time.Since(o.start), "body closed before EOF", o.probe, o.gen)
	})
}

// observingReadCloser wraps the upstream response body so the outcome is
// classified from the actual bytes observed — including the 200-empty honesty
// check — without buffering the stream.
type observingReadCloser struct {
	io.ReadCloser
	obs *healthObserver
}

func (w *observingReadCloser) Read(p []byte) (int, error) {
	n, err := w.ReadCloser.Read(p)
	if n > 0 {
		w.obs.noteBytes(p[:n])
	}
	if err == io.EOF {
		w.obs.finishAtEOF()
	}
	return n, err
}

func (w *observingReadCloser) Close() error {
	err := w.ReadCloser.Close()
	w.obs.finishAtClose()
	return err
}

func firstLine(s string, max int) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

func expireCoolOff(h *PeerHealth) {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.openedAt = time.Now().Add(-2 * h.coolOff())
	h.mu.Unlock()
}
