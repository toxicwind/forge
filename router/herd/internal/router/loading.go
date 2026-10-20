package router

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mostlygeek/herd/internal/logmon"
	"github.com/mostlygeek/herd/internal/swaputil"
)

var loadingPaths = []string{
	"/v1/chat/completions",
}

func isLoadingPath(path string) bool {
	for _, p := range loadingPaths {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

type loadingWriter struct {
	hasWritten bool
	writer     http.ResponseWriter
	req        *http.Request
	ctx        context.Context
	logger     *logmon.Monitor
	modelName  string
	startTime  time.Time

	// chatID is a unique chatcmpl-xxx identifier shared across all loading chunks
	// so Zed's strict stream parser can correlate them as one response.
	chatID  string
	created int64

	pendingMu     sync.Mutex
	pendingUpdate string

	// writeMu serializes writes to the underlying writer and guards released.
	// Once released is set, the streaming goroutine must not touch the writer
	// again — ServeHTTP has reclaimed it (to run the real handler or to return)
	// and writing/flushing a finalized response panics.
	writeMu  sync.Mutex
	released bool

	// closed by start when the goroutine finishes (after cleanup messages)
	done chan struct{}

	// test-only: closed when start enters its loop
	loopStarted chan struct{}
	// test-only: override the 1s tick interval
	tickDuration time.Duration
	// test-only: override character streaming speed (0 = no delay)
	charPerSecond float64
}

func newLoadingWriter(logger *logmon.Monitor, modelName string, w http.ResponseWriter, req *http.Request) *loadingWriter {
	now := time.Now()
	s := &loadingWriter{
		writer:        w,
		req:           req,
		ctx:           req.Context(),
		logger:        logger,
		modelName:     modelName,
		chatID:        fmt.Sprintf("chatcmpl-%d", now.UnixNano()),
		created:       now.Unix(),
		startTime:     now,
		tickDuration:  750 * time.Millisecond,
		charPerSecond: 75,
		done:          make(chan struct{}),
	}

	s.Header().Set("Content-Type", "text/event-stream")
	s.Header().Set("Cache-Control", "no-cache")
	s.Header().Set("Connection", "keep-alive")
	s.WriteHeader(http.StatusOK)

	// Emit an initial role-assistant chunk so Zed's deserializer sees a
	// well-formed first chunk before any reasoning_content arrives.
	// Without this, the first chunk has role="" which some strict clients
	// (Zed's untagged ResponseStreamResult) can't match.
	s.sendRoleChunk()
	s.sendLine("━━━━━")
	s.sendLine(fmt.Sprintf("herd loading model: %s", modelName))
	return s
}

// sendRoleChunk emits a chunk with delta.role="assistant" and no content.
// This matches the OpenAI streaming spec where the first chunk announces the role.
func (s *loadingWriter) sendRoleChunk() {
	type delta struct {
		Role    string `json:"role,omitempty"`
		Content string `json:"content,omitempty"`
	}
	type choice struct {
		Index        int     `json:"index"`
		Delta        delta   `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	}
	type envelope struct {
		ID      string   `json:"id"`
		Object  string   `json:"object"`
		Created int64    `json:"created"`
		Model   string   `json:"model"`
		Choices []choice `json:"choices"`
	}

	msg := envelope{
		ID:      s.chatID,
		Object:  "chat.completion.chunk",
		Created: s.created,
		Model:   s.modelName,
		Choices: []choice{
			{
				Index:        0,
				Delta:        delta{Role: "assistant"},
				FinishReason: nil,
			},
		},
	}

	jsonData, err := json.Marshal(msg)
	if err != nil {
		s.logger.Errorf("<%s> Failed to marshal role SSE message: %v", s.modelName, err)
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.released {
		return
	}
	if _, err = fmt.Fprintf(s.writer, "data: %s\n\n", jsonData); err != nil {
		s.logger.Debugf("<%s> Failed to write role SSE data: %v", s.modelName, err)
		return
	}
	if flusher, ok := s.writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (s *loadingWriter) setUpdate(msg string) {
	s.pendingMu.Lock()
	s.pendingUpdate = msg
	s.pendingMu.Unlock()
}

func (s *loadingWriter) start(ctx context.Context) {
	defer close(s.done)

	defer func() {
		// Skip cleanup writes if the client disconnected — the connection
		// is being torn down and flushing against it will panic.
		if s.ctx.Err() != nil {
			return
		}
		duration := time.Since(s.startTime)
		s.sendData("\n")
		s.sendLine(fmt.Sprintf("Done! (%.2fs)", duration.Seconds()))
		s.sendLine("━━━━━")
		s.sendLine(" ")
		// NOTE: deliberately NOT sending [DONE] here because the real
		// upstream response follows on the same SSE stream. A [DONE]
		// sentinel would terminate the stream prematurely, leaving the
		// client (Zed) waiting for chunks that never arrive.
	}()

	remarks := make([]string, len(loadingRemarks))
	copy(remarks, loadingRemarks)
	rand.Shuffle(len(remarks), func(i, j int) {
		remarks[i], remarks[j] = remarks[j], remarks[i]
	})
	ri := 0

	nextRemarkIn := time.Duration(2+rand.Intn(4)) * time.Second
	lastRemarkTime := time.Time{}

	ticker := time.NewTicker(s.tickDuration)
	defer ticker.Stop()

	if s.loopStarted != nil {
		close(s.loopStarted)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.pendingMu.Lock()
			update := s.pendingUpdate
			s.pendingUpdate = ""
			s.pendingMu.Unlock()

			if update != "" {
				s.sendData("\n")
				s.sendInline(update)
				s.sendData(" ")
				lastRemarkTime = time.Now()
				nextRemarkIn = time.Duration(5+rand.Intn(5)) * time.Second
			} else if time.Since(lastRemarkTime) >= nextRemarkIn {
				remark := remarks[ri%len(remarks)]
				ri++
				s.sendData("\n")
				s.sendInline(remark)
				s.sendData(" ")
				lastRemarkTime = time.Now()
				nextRemarkIn = time.Duration(5+rand.Intn(5)) * time.Second
			} else {
				s.sendData(".")
			}
		}
	}
}

func (s *loadingWriter) waitForCompletion(timeout time.Duration) bool {
	if s.done == nil {
		return true
	}
	select {
	case <-s.done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (s *loadingWriter) sendInline(text string) {
	chunkSize := 10
	if s.charPerSecond > 0 {
		chunkSize = max(3, int(s.charPerSecond)/15)
	}

	runes := []rune(text)
	for i := 0; i < len(runes); {
		select {
		case <-s.ctx.Done():
			return
		default:
		}

		end := i + chunkSize
		if end > len(runes) {
			end = len(runes)
		}
		chunk := string(runes[i:end])
		s.sendData(chunk)
		i = end

		if i < len(runes) && s.charPerSecond > 0 {
			time.Sleep(time.Duration(float64(time.Second) * float64(len(chunk)) / s.charPerSecond))
		}
	}
}

func (s *loadingWriter) sendLine(line string) {
	if line == "" {
		s.sendData("\n")
		return
	}
	s.sendInline(line)
	s.sendData("\n")
}

// OpenAI streaming chunk envelope types — matches the spec exactly so Zed's
// strict Rust serde deserializer (ResponseStreamResult untagged enum) can
// parse every chunk. All fields required by spec are present:
//   - id, object, created, model (top-level)
//   - choices[].index, choices[].delta, choices[].finish_reason
//
// Without these, Zed's parser returns "data did not match any variant of
// untagged enum ResponseStreamResult".
type sseDelta struct {
	Role             string `json:"role,omitempty"`
	Content          string `json:"content,omitempty"`
	ReasoningContent string `json:"reasoning_content,omitempty"`
}

type sseChoice struct {
	Index        int      `json:"index"`
	Delta        sseDelta `json:"delta"`
	FinishReason *string  `json:"finish_reason"`
}

type sseEnvelope struct {
	ID      string      `json:"id"`
	Object  string      `json:"object"`
	Created int64       `json:"created"`
	Model   string      `json:"model"`
	Choices []sseChoice `json:"choices"`
}

func (s *loadingWriter) sendData(data string) {
	msg := sseEnvelope{
		ID:      s.chatID,
		Object:  "chat.completion.chunk",
		Created: s.created,
		Model:   s.modelName,
		Choices: []sseChoice{
			{
				Index: 0,
				Delta: sseDelta{
					ReasoningContent: data,
				},
				FinishReason: nil,
			},
		},
	}

	jsonData, err := json.Marshal(msg)
	if err != nil {
		s.logger.Errorf("<%s> Failed to marshal SSE message: %v", s.modelName, err)
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	// Once ServeHTTP has reclaimed the writer (release), writing/flushing it
	// races the real handler or panics on a finalized response. Stop here.
	if s.released {
		return
	}

	if _, err = fmt.Fprintf(s.writer, "data: %s\n\n", jsonData); err != nil {
		s.logger.Debugf("<%s> Failed to write SSE data (client likely disconnected): %v", s.modelName, err)
		return
	}
	if flusher, ok := s.writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

// sendError streams err to the client as a terminating SSE error frame
// followed by [DONE].
//
// Once the loading stream has committed its 200, a real status can no longer be
// sent: swaputil.SendError's WriteHeader is dropped and its JSON body lands in
// the stream as a bare line, which every SSE parser discards silently (the text
// before the first colon is read as an unknown field name). The client is left
// with a truncated stream, no [DONE], and no reason — the same
// failure-reported-as-success shape as #1029. Framing the error keeps it
// visible.
//
// The frame carries the same envelope as a non-streamed error body (#1038), so
// a client sees one error shape either way. The status only selects the
// envelope's type/code — 500 matches what this error would have been answered
// with had the stream not already committed a 200.
//
// Must be called before release, while writes still reach the client.
func (s *loadingWriter) sendError(err error) {
	jsonData := swaputil.NewErrorEnvelope(http.StatusInternalServerError, err.Error(), "").JSON()

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.released {
		return
	}

	if _, werr := fmt.Fprintf(s.writer, "data: %s\n\ndata: [DONE]\n\n", jsonData); werr != nil {
		s.logger.Debugf("<%s> Failed to write SSE error (client likely disconnected): %v", s.modelName, werr)
		return
	}
	if flusher, ok := s.writer.(http.Flusher); ok {
		flusher.Flush()
	}
}

// release fences the loadingWriter off from the underlying ResponseWriter.
// After it returns, the streaming goroutine will not write to or flush the
// writer again: any in-flight write completes under writeMu first, and later
// writes short-circuit on released. The caller can then safely hand the writer
// to the real handler or let ServeHTTP return without racing a finalized
// response (a use-after-return Flush panics on the recycled *bufio.Writer).
func (s *loadingWriter) release() {
	s.writeMu.Lock()
	s.released = true
	s.writeMu.Unlock()
}

func (s *loadingWriter) Header() http.Header {
	return s.writer.Header()
}

func (s *loadingWriter) Write(data []byte) (int, error) {
	return s.writer.Write(data)
}

func (s *loadingWriter) WriteHeader(statusCode int) {
	if s.hasWritten {
		return
	}
	s.hasWritten = true
	s.writer.WriteHeader(statusCode)
	s.Flush()
}

func (s *loadingWriter) Flush() {
	if flusher, ok := s.writer.(http.Flusher); ok {
		flusher.Flush()
	}
}
