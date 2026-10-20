package astmatrix

// liveCatalogReader — thin reader for the live catalog JSON exported by the
// TS package (@ranch/roost ModelCatalog.writeLiveCatalog).
//
// This file contains NO catalog logic. It does not discover, prune, or
// quarantine anything. The TS package is the brain: it owns the provider
// definitions, the /models adapters, live discovery, and the two-strike
// quarantine state machine. It writes the ANSWER (derived serving sets) to a
// JSON file; this reader loads that file and hands the serving sets to the
// provider table. Transpiling the logic into Go is a trap (Tern's
// 2026-09-30 verdict); the JSON catalog is the contract, the TS package is
// the brain.
//
// Contract: ranch-roost/live-catalog/v1
//   { "contract": ..., "generatedAt": ..., "deadIds": [...],
//     "providers": { "<name>": { "serving": [...], "quarantined": [...],
//                               "discovered": bool } } }
//
// When the live file is absent or unreadable, providers fall back to their
// generated cold-start seeds (dead-filtered). The file is re-read whenever
// its mtime changes, so a TS-side quarantine propagates to herd without a
// restart and without any polling timer on our side.

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

// LiveCatalogPath resolves the live catalog file path: env override first,
// then the TS router's default state location.
func LiveCatalogPath() string {
	if p := os.Getenv("estate-scripts_LIVE_CATALOG"); p != "" {
		return p
	}
	return "/home/toxic/estate/.state/provider-catalog.live.json"
}

type liveCatalogProvider struct {
	Serving     []string `json:"serving"`
	Quarantined []string `json:"quarantined"`
	Discovered  bool     `json:"discovered"`
}

const (
	liveCatalogContract       = "ranch-roost/live-catalog/v1"
	legacyLiveCatalogContract = "estate-scripts-providers/live-catalog/v1"
)

type liveCatalogData struct {
	Contract    string                         `json:"contract"`
	GeneratedAt string                         `json:"generatedAt"`
	DeadIDs     []string                       `json:"deadIds"`
	Providers   map[string]liveCatalogProvider `json:"providers"`
}

// LiveCatalogReader reads the TS-exported live catalog file. Pure data.
type LiveCatalogReader struct {
	path  string
	mu    sync.RWMutex
	mtime time.Time
	data  *liveCatalogData
}

func NewLiveCatalogReader(path string) *LiveCatalogReader {
	if path == "" {
		path = LiveCatalogPath()
	}
	return &LiveCatalogReader{path: path}
}

// Path returns the file this reader watches.
func (r *LiveCatalogReader) Path() string { return r.path }

// refreshIfStale re-reads the file when its mtime changed. Returns the
// current data, or nil when the file is absent/unreadable/invalid. Never
// returns an error: a bad file is simply treated as "no live data".
func (r *LiveCatalogReader) refreshIfStale() *liveCatalogData {
	fi, err := os.Stat(r.path)
	if err != nil {
		return nil
	}
	mt := fi.ModTime()

	r.mu.RLock()
	cached := r.data
	cachedMt := r.mtime
	r.mu.RUnlock()
	if cached != nil && !mt.After(cachedMt) {
		return cached
	}

	raw, err := os.ReadFile(r.path)
	if err != nil {
		return nil
	}
	var d liveCatalogData
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil
	}
	if d.Contract != liveCatalogContract && d.Contract != legacyLiveCatalogContract {
		// Silently returning nil here is what let a pre-rename contract file sit
		// on disk while every consumer quietly fell back to cold-start seeds.
		// The mismatch is now loud, and the legacy name is accepted on read so
		// the estate keeps working across the roost rename.
		log.Printf("[live-catalog] %s declares unknown contract %q; expected %s", r.path, d.Contract, liveCatalogContract)
		return nil
	}
	if d.Contract == legacyLiveCatalogContract {
		log.Printf("[live-catalog] %s declares the pre-rename contract %s; accepting it, but rewrite with %s", r.path, legacyLiveCatalogContract, liveCatalogContract)
	}
	if d.Providers == nil {
		d.Providers = map[string]liveCatalogProvider{}
	}

	r.mu.Lock()
	r.data = &d
	r.mtime = mt
	r.mu.Unlock()
	return &d
}

// ServingModels returns the live serving list for a provider.
// ok=false means no live data (file absent/invalid or provider not listed);
// callers fall back to generated cold-start seeds.
func (r *LiveCatalogReader) ServingModels(provider string) (models []string, ok bool) {
	d := r.refreshIfStale()
	if d == nil {
		return nil, false
	}
	p, found := d.Providers[provider]
	if !found {
		return nil, false
	}
	out := make([]string, len(p.Serving))
	copy(out, p.Serving)
	return out, true
}

// SyncProviderModels overlays the live serving sets onto a provider table.
// Providers with live data get their models replaced verbatim; providers
// without live data keep whatever they had (generated seeds). Pure data
// overlay — no discovery, no quarantine decisions here.
func (r *LiveCatalogReader) SyncProviderModels(providers map[string]*provider) {
	d := r.refreshIfStale()
	if d == nil {
		return
	}
	for name, p := range providers {
		live, ok := d.Providers[name]
		if !ok {
			continue
		}
		p.models = append([]string(nil), live.Serving...)
	}
}

// ------------------------------------------------------------------
// 404 event reporting — herd reports, the TS brain decides.
// ------------------------------------------------------------------

// serve404Endpoint is the TS router's 404 intake. Override with
// estate-scripts_CATALOG_404_URL. Empty disables reporting.
func serve404Endpoint() string {
	if u := os.Getenv("estate-scripts_CATALOG_404_URL"); u != "" {
		return u
	}
	return "http://127.0.0.1:25104/admin/catalog/serve-404"
}

// reportServe404 posts a serve-time 404 to the TS catalog brain. Best-effort:
// short timeout, failures are logged and dropped, never retried, never
// blocking. The TS side quarantines the id and rewrites the live catalog
// file; herd picks the new serving set up on its next read.
func reportServe404(provider, model string) {
	url := serve404Endpoint()
	if url == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"provider": provider, "model": model})
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if tok := os.Getenv("estate-scripts_CATALOG_ADMIN_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}
