package astmatrix

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeLiveFile(t *testing.T, dir, body string) string {
	t.Helper()
	p := filepath.Join(dir, "catalog.live.json")
	if err := os.WriteFile(p, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	return p
}

const liveDoc = `{
  "contract": "estate-pinax/live-catalog/v1",
  "generatedAt": "2026-09-30T00:00:00Z",
  "generator": "test",
  "deadIds": ["dead-1"],
  "providers": {
    "groq": {"serving": ["m-a", "m-b"], "quarantined": ["m-q"], "discovered": true},
    "openrouter": {"serving": [], "quarantined": [], "discovered": true}
  }
}`

func TestLiveReaderAbsentFile(t *testing.T) {
	r := NewLiveCatalogReader(filepath.Join(t.TempDir(), "nope.live.json"))
	if _, ok := r.ServingModels("groq"); ok {
		t.Fatal("absent file should report no live data")
	}
	provs := map[string]*provider{"groq": {models: []string{"seed"}}}
	r.SyncProviderModels(provs)
	if len(provs["groq"].models) != 1 || provs["groq"].models[0] != "seed" {
		t.Fatalf("absent file must leave providers untouched, got %v", provs["groq"].models)
	}
}

func TestLiveReaderServesAnswer(t *testing.T) {
	p := writeLiveFile(t, t.TempDir(), liveDoc)
	r := NewLiveCatalogReader(p)
	models, ok := r.ServingModels("groq")
	if !ok {
		t.Fatal("expected live data")
	}
	if len(models) != 2 || models[0] != "m-a" || models[1] != "m-b" {
		t.Fatalf("unexpected serving list: %v", models)
	}
	if _, ok := r.ServingModels("unknown-provider"); ok {
		t.Fatal("unknown provider should report no live data")
	}
}

func TestLiveReaderSyncOverlays(t *testing.T) {
	p := writeLiveFile(t, t.TempDir(), liveDoc)
	r := NewLiveCatalogReader(p)
	provs := map[string]*provider{
		"groq":       {models: []string{"seed-a"}},
		"openrouter": {models: []string{"seed-b"}},
		"nvidia":     {models: []string{"seed-c"}}, // not in live doc: keeps seeds
	}
	r.SyncProviderModels(provs)
	if len(provs["groq"].models) != 2 || provs["groq"].models[0] != "m-a" {
		t.Fatalf("groq not overlaid: %v", provs["groq"].models)
	}
	if len(provs["openrouter"].models) != 0 {
		t.Fatalf("empty live serving should clear seeds: %v", provs["openrouter"].models)
	}
	if len(provs["nvidia"].models) != 1 || provs["nvidia"].models[0] != "seed-c" {
		t.Fatalf("nvidia should keep seeds: %v", provs["nvidia"].models)
	}
}

func TestLiveReaderRejectsBadContract(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"badjson":       `{not json`,
		"wrongcon":      `{"contract": "something/else/v9", "providers": {}}`,
		"nullproviders": `{"contract": "estate-pinax/live-catalog/v1"}`,
	} {
		p := writeLiveFile(t, dir, body)
		_ = name
		r := NewLiveCatalogReader(p)
		if _, ok := r.ServingModels("groq"); ok {
			t.Fatalf("%s: invalid doc should report no live data", name)
		}
	}
}

func TestLiveReaderPicksUpMtimeChange(t *testing.T) {
	dir := t.TempDir()
	p := writeLiveFile(t, dir, liveDoc)
	r := NewLiveCatalogReader(p)
	if _, ok := r.ServingModels("groq"); !ok {
		t.Fatal("expected live data")
	}
	// Rewrite with a quarantined model re-admitted.
	updated := `{
  "contract": "estate-pinax/live-catalog/v1",
  "generatedAt": "2026-09-30T01:00:00Z",
  "deadIds": [],
  "providers": {
    "groq": {"serving": ["m-a", "m-b", "m-q"], "quarantined": [], "discovered": true}
  }
}`
	// Ensure the mtime actually advances (some filesystems have coarse granularity).
	time.Sleep(1100 * time.Millisecond)
	writeLiveFile(t, dir, updated)
	models, ok := r.ServingModels("groq")
	if !ok || len(models) != 3 {
		t.Fatalf("expected re-read after mtime change, got %v ok=%v", models, ok)
	}
}

func TestReportServe404PostsEvent(t *testing.T) {
	var gotPath, gotProvider, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath = req.URL.Path
		var body map[string]string
		_ = json.NewDecoder(req.Body).Decode(&body)
		gotProvider, gotModel = body["provider"], body["model"]
		w.WriteHeader(200)
	}))
	defer srv.Close()

	t.Setenv("estate-scripts_CATALOG_404_URL", srv.URL+"/admin/catalog/serve-404")
	reportServe404("groq", "m-gone")
	if gotPath != "/admin/catalog/serve-404" || gotProvider != "groq" || gotModel != "m-gone" {
		t.Fatalf("unexpected report: path=%q provider=%q model=%q", gotPath, gotProvider, gotModel)
	}
}

func TestDefaultProvidersSkipRouterLocal(t *testing.T) {
	provs := defaultProviders()
	if _, ok := provs["nim-local"]; ok {
		t.Fatal("router-local nim-local must be skipped by flag")
	}
	if _, ok := provs["kimi-auto"]; ok {
		t.Fatal("router-local kimi-auto must be skipped by flag")
	}
	if _, ok := provs["groq"]; !ok {
		t.Fatal("groq should be present")
	}
	for _, id := range provs["groq"].models {
		if deadIDSet()[id] {
			t.Fatalf("dead id %q served at cold start", id)
		}
	}
}

func TestAliasTargetServable(t *testing.T) {
	provs := map[string]*provider{
		"groq": {models: []string{"m-a"}},
	}
	if !aliasTargetServable(provs, "groq", "m-a") {
		t.Fatal("serving model should be servable")
	}
	if aliasTargetServable(provs, "groq", "m-q") {
		t.Fatal("non-serving model must not be servable (quarantine guard)")
	}
	if aliasTargetServable(provs, "nope", "m-a") {
		t.Fatal("unknown provider must not be servable")
	}
	for _, dead := range ProviderCatalogDeadIDs {
		if aliasTargetServable(provs, "groq", dead) {
			t.Fatalf("dead id %q must never be servable", dead)
		}
	}
}
