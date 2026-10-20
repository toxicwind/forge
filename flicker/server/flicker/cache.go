// Copyright 2026 Flicker Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package flicker

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
)

// CachedResult is what a cache hit returns: the original successful job's
// outcome, keyed by content hash. Mirrors brandd.py's whole-job cache.
type CachedResult struct {
	Hash       string    `json:"hash"`
	Status     string    `json:"status"` // "success"
	ExitCode   int       `json:"exit_code"`
	DurationMs int64     `json:"duration_ms"`
	PipelineID int64     `json:"pipeline_id"`
	CachedAt   time.Time `json:"cached_at"`
	Artifacts  string    `json:"artifacts,omitempty"` // artifact dir, if any
}

// Cache is the flicker content-hash cache. Successful jobs are indexed by
// their spec hash; an identical resubmission returns CACHED without running.
type Cache struct {
	mu    sync.RWMutex
	dir   string // <root>/cache
	index string // <root>/cache/index.json
	byHash map[string]*CachedResult
}

// NewCache opens (or creates) the cache under root.
func NewCache(root string) (*Cache, error) {
	dir := filepath.Join(root, "cache")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("flicker: create cache dir: %w", err)
	}
	c := &Cache{
		dir:    dir,
		index:  filepath.Join(dir, "index.json"),
		byHash: map[string]*CachedResult{},
	}
	if data, err := os.ReadFile(c.index); err == nil {
		_ = json.Unmarshal(data, &c.byHash)
	}
	return c, nil
}

// Lookup returns the cached result for hash, or nil.
func (c *Cache) Lookup(hash string) *CachedResult {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.byHash[hash]
}

// Store records a successful job under its hash.
func (c *Cache) Store(hash string, res *CachedResult) {
	c.mu.Lock()
	defer c.mu.Unlock()
	res.Hash = hash
	res.CachedAt = time.Now().UTC()
	c.byHash[hash] = res
	c.persistLocked()
}

// ArtifactDir returns the artifact directory for a hash, creating it.
func (c *Cache) ArtifactDir(hash string) (string, error) {
	dir := filepath.Join(c.dir, "artifacts", hash)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func (c *Cache) persistLocked() {
	data, err := json.MarshalIndent(c.byHash, "", "  ")
	if err != nil {
		log.Error().Err(err).Msg("flicker: marshal cache index")
		return
	}
	tmp := c.index + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Error().Err(err).Msg("flicker: write cache index")
		return
	}
	if err := os.Rename(tmp, c.index); err != nil {
		log.Error().Err(err).Msg("flicker: replace cache index")
	}
}
