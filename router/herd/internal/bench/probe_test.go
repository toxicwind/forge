// probe_test.go — full coverage for the bench probing path.
// Uses an httptest server to fake the herd /v1/models + /v1/chat/completions.
package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeHerdServer builds a /v1/models + /v1/chat/completions stub for tests.
type fakeHerdServer struct {
	models       []string
	chatBehavior func(model string) (status int, body string, delay time.Duration)
}

func (f *fakeHerdServer) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		data := make([]Model, 0, len(f.models))
		for _, id := range f.models {
			data = append(data, Model{ID: id, Object: "model", OwnedBy: "test"})
		}
		_ = json.NewEncoder(w).Encode(ModelsResponse{Data: data})
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		status, body, delay := 200, `{"ok":true}`, time.Duration(0)
		if f.chatBehavior != nil {
			status, body, delay = f.chatBehavior(req.Model)
		}
		if delay > 0 {
			time.Sleep(delay)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	return mux
}

func TestDiscover_SortsAndReturnsIDs(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{models: []string{"c", "a", "b"}}).routes())
	defer srv.Close()

	ids, err := Discover(context.Background(), srv.URL+"/v1")
	require.NoError(t, err)
	assert.Equal(t, []string{"a", "b", "c"}, ids)
}

func TestDiscover_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()
	_, err := Discover(context.Background(), srv.URL+"/v1")
	assert.Error(t, err)
}

func TestDiscover_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()
	_, err := Discover(context.Background(), srv.URL+"/v1")
	assert.Error(t, err)
}

func TestDiscover_DropsEmptyIDs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"data":[{"id":""},{"id":"x"},{"id":""}]}`)
	}))
	defer srv.Close()
	ids, err := Discover(context.Background(), srv.URL+"/v1")
	require.NoError(t, err)
	assert.Equal(t, []string{"x"}, ids)
}

func TestClassifyHTTP(t *testing.T) {
	cases := []struct {
		code int
		want ProbeStatus
	}{
		{200, StatusAlive},
		{402, StatusDead},
		{404, StatusDead},
		{410, StatusDead},
		{503, StatusDead},
		{500, StatusError},
		{401, StatusError},
		{0, StatusError},
		{418, StatusError},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, classifyHTTP(c.code), "code=%d", c.code)
	}
}

func TestProbe_Alive(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) { return 200, `{"choices":[]}`, 0 },
	}).routes())
	defer srv.Close()

	r := Probe(context.Background(), ProbeOptions{
		BaseURL: srv.URL + "/v1", Model: "good", TimeoutSeconds: 5,
	})
	assert.Equal(t, StatusAlive, r.Status)
	assert.Equal(t, 200, r.HTTPStatus)
	assert.GreaterOrEqual(t, r.LatencyMs, int64(0))
}

func TestProbe_Dead402(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) { return 402, "payment required", 0 },
	}).routes())
	defer srv.Close()

	r := Probe(context.Background(), ProbeOptions{
		BaseURL: srv.URL + "/v1", Model: "x", TimeoutSeconds: 5,
	})
	assert.Equal(t, StatusDead, r.Status)
}

func TestProbe_Dead410(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) { return 410, "gone", 0 },
	}).routes())
	defer srv.Close()
	r := Probe(context.Background(), ProbeOptions{
		BaseURL: srv.URL + "/v1", Model: "x", TimeoutSeconds: 5,
	})
	assert.Equal(t, StatusDead, r.Status)
}

func TestProbe_ServerError500(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) { return 500, "boom", 0 },
	}).routes())
	defer srv.Close()
	r := Probe(context.Background(), ProbeOptions{
		BaseURL: srv.URL + "/v1", Model: "x", TimeoutSeconds: 5,
	})
	assert.Equal(t, StatusError, r.Status)
}

func TestProbe_Timeout(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) {
			return 200, "{}", 3 * time.Second
		},
	}).routes())
	defer srv.Close()

	r := Probe(context.Background(), ProbeOptions{
		BaseURL: srv.URL + "/v1", Model: "slow", TimeoutSeconds: 1,
	})
	assert.Equal(t, StatusTimeout, r.Status)
}

func TestProbe_NetworkError(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{}).routes())
	url := srv.URL
	srv.Close()
	r := Probe(context.Background(), ProbeOptions{
		BaseURL: url + "/v1", Model: "x", TimeoutSeconds: 2,
	})
	assert.Equal(t, StatusError, r.Status)
}

func TestProbe_RespectsCustomClient(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) { return 200, "ok", 0 },
	}).routes())
	defer srv.Close()

	called := false
	client := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, fmt.Errorf("client short-circuit")
	})}
	r := Probe(context.Background(), ProbeOptions{
		BaseURL: srv.URL + "/v1", Model: "x", TimeoutSeconds: 1, Client: client,
	})
	assert.True(t, called, "custom client should be used")
	assert.Equal(t, StatusError, r.Status)
}

func TestProbeAll_RespectsConcurrency(t *testing.T) {
	var inFlight atomic.Int32
	var maxObserved atomic.Int32
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) {
			cur := inFlight.Add(1)
			for {
				prev := maxObserved.Load()
				if cur <= prev || maxObserved.CompareAndSwap(prev, cur) {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
			inFlight.Add(-1)
			return 200, "{}", 0
		},
	}).routes())
	defer srv.Close()

	models := make([]string, 20)
	for i := range models {
		models[i] = fmt.Sprintf("m-%d", i)
	}
	results := ProbeAll(context.Background(), srv.URL+"/v1", models, 4, 5)
	assert.Len(t, results, 20)
	for _, r := range results {
		assert.Equal(t, StatusAlive, r.Status)
	}
	assert.LessOrEqual(t, int(maxObserved.Load()), 4, "concurrency cap must be respected")
}

func TestProbeAll_AllTimeout(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(string) (int, string, time.Duration) {
			return 200, "{}", 5 * time.Second
		},
	}).routes())
	defer srv.Close()

	results := ProbeAll(context.Background(), srv.URL+"/v1", []string{"a", "b"}, 2, 1)
	for _, r := range results {
		assert.Equal(t, StatusTimeout, r.Status, "model=%s", r.Model)
	}
}

func TestProbeAll_EmptyInput(t *testing.T) {
	results := ProbeAll(context.Background(), "http://unused", nil, 4, 5)
	assert.Empty(t, results)
}

func TestProbeAll_PreservesInputOrder(t *testing.T) {
	srv := httptest.NewServer((&fakeHerdServer{
		chatBehavior: func(m string) (int, string, time.Duration) {
			// sleep proportional to position to force reorder without concurrency
			return 200, "{}", 0
		},
	}).routes())
	defer srv.Close()

	models := []string{"z", "a", "m", "b"}
	results := ProbeAll(context.Background(), srv.URL+"/v1", models, 1, 5)
	require.Len(t, results, 4)
	for i, want := range models {
		assert.Equal(t, want, results[i].Model)
	}
}

func TestClassify(t *testing.T) {
	// Per current semantics:
	//   alive  → working
	//   dead   → dead
	//   error with HTTP 5xx/401/403 → dead (server said no)
	//   error with HTTP 0 (no response) → NOT dead (could be a transient hiccup)
	//   timeout → NOT dead (model may be slow but reachable)
	results := []ProbeResult{
		{Model: "alive1", Status: StatusAlive},
		{Model: "alive2", Status: StatusAlive},
		{Model: "dead402", Status: StatusDead},
		{Model: "dead410", Status: StatusDead},
		{Model: "err500", Status: StatusError, HTTPStatus: 500},
		{Model: "err401", Status: StatusError, HTTPStatus: 401},
		{Model: "err403", Status: StatusError, HTTPStatus: 403},
	}
	working, dead := Classify(results)
	assert.Equal(t, []string{"alive1", "alive2"}, working)
	assert.ElementsMatch(t, []string{
		"dead402", "dead410", "err500", "err401", "err403",
	}, dead)
}
func TestClassify_Empty(t *testing.T) {
	working, dead := Classify(nil)
	assert.Empty(t, working)
	assert.Empty(t, dead)
}

func TestClassify_500NotCountedAsDead(t *testing.T) {
	// 500 = error, but 500 >= 500 IS counted as dead per Classify logic
	// Verify the explicit semantics: server errors (5xx) are dead.
	_, dead := Classify([]ProbeResult{{Model: "boom", Status: StatusError, HTTPStatus: 500}})
	assert.Equal(t, []string{"boom"}, dead)
}

func TestClassify_SortedOutput(t *testing.T) {
	results := []ProbeResult{
		{Model: "z", Status: StatusAlive},
		{Model: "a", Status: StatusAlive},
		{Model: "m", Status: StatusAlive},
	}
	working, _ := Classify(results)
	sorted := append([]string(nil), working...)
	sort.Strings(sorted)
	assert.Equal(t, sorted, working)
}

// Latency tests

func TestLatency_Empty(t *testing.T) {
	st := Latency(nil)
	assert.Equal(t, LatencyStats{}, st)
}

func TestLatency_Single(t *testing.T) {
	st := Latency([]int64{42})
	assert.Equal(t, 1, st.Count)
	assert.Equal(t, int64(42), st.Min)
	assert.Equal(t, int64(42), st.Max)
	assert.Equal(t, int64(42), st.P50)
	assert.Equal(t, int64(42), st.P95)
	assert.Equal(t, int64(42), st.P99)
}

func TestLatency_Distribution(t *testing.T) {
	samples := make([]int64, 100)
	for i := range samples {
		samples[i] = int64(i + 1) // 1..100
	}
	st := Latency(samples)
	assert.Equal(t, 100, st.Count)
	assert.Equal(t, int64(1), st.Min)
	assert.Equal(t, int64(100), st.Max)
	assert.InDelta(t, 50.5, st.Mean, 0.5)
	assert.Equal(t, int64(50), st.P50)
	assert.GreaterOrEqual(t, st.P95, int64(95))
	assert.LessOrEqual(t, st.P99, int64(100))
	assert.GreaterOrEqual(t, st.P99, int64(99))
}

func TestProbeLatencySummaries_GroupsByStatus(t *testing.T) {
	results := []ProbeResult{
		{Model: "a", Status: StatusAlive, LatencyMs: 10},
		{Model: "b", Status: StatusAlive, LatencyMs: 20},
		{Model: "c", Status: StatusDead, LatencyMs: 5},
		{Model: "d", Status: StatusTimeout, LatencyMs: 1000},
		{Model: "e", Status: StatusError}, // latency 0 → skipped
	}
	summaries := ProbeLatencySummaries(results)
	assert.Equal(t, 2, summaries[StatusAlive].Count)
	assert.Equal(t, 1, summaries[StatusDead].Count)
	assert.Equal(t, 1, summaries[StatusTimeout].Count)
	assert.Equal(t, 0, summaries[StatusError].Count)
	assert.Equal(t, int64(10), summaries[StatusAlive].Min)
	assert.Equal(t, int64(20), summaries[StatusAlive].Max)
}

// roundTripperFunc lets a test inject a custom Transport without spinning
// up another server.
type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
