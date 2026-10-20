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
	"context"
	"os"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"go.woodpecker-ci.org/woodpecker/v3/server/forge/local"
	"go.woodpecker-ci.org/woodpecker/v3/server/model"
	"go.woodpecker-ci.org/woodpecker/v3/server/pipeline"
	"go.woodpecker-ci.org/woodpecker/v3/server/store"
)

var (
	cacheOnce sync.Once
	cacheInst *Cache
	cacheErr  error
)

// Root returns the flicker state root (FLICKER_ROOT or /home/toxic/flicker).
func Root() string {
	if r := os.Getenv("FLICKER_ROOT"); r != "" {
		return r
	}
	return "/home/toxic/flicker"
}

// Init initializes the flicker service (cache). Call once at server boot.
func Init() error {
	cacheOnce.Do(func() {
		cacheInst, cacheErr = NewCache(Root())
	})
	return cacheErr
}

// CacheLookup returns the cached result for a job hash, or nil.
func CacheLookup(hash string) *CachedResult {
	if cacheInst == nil {
		return nil
	}
	return cacheInst.Lookup(hash)
}

// CacheStats returns cache statistics for health endpoints.
func CacheStats() map[string]any {
	if cacheInst == nil {
		return map[string]any{"entries": 0}
	}
	cacheInst.mu.RLock()
	defer cacheInst.mu.RUnlock()
	return map[string]any{"entries": len(cacheInst.byHash)}
}

// RecordSuccess stores a successful pipeline in the content-hash cache.
// Called by the completion watcher.
func RecordSuccess(hash string, pipelineID int64, durationMs int64) {
	if cacheInst == nil {
		return
	}
	cacheInst.Store(hash, &CachedResult{
		Status:     "success",
		ExitCode:   0,
		DurationMs: durationMs,
		PipelineID: pipelineID,
	})
}

// EnforceTimeout cancels a pipeline if it runs longer than timeoutSecs.
// Runs in its own goroutine per job. Cancellation goes through the
// pipeline package so the agent stops the running steps.
func EnforceTimeout(_store store.Store, repo *model.Repo, user *model.User, pipelineID int64, timeoutSecs int64) {
	if timeoutSecs <= 0 {
		return
	}
	deadline := time.Now().Add(time.Duration(timeoutSecs) * time.Second)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		pl, err := _store.GetPipeline(pipelineID)
		if err != nil {
			return
		}
		// Terminal states: stop watching.
		switch pl.Status {
		case model.StatusSuccess, model.StatusFailure, model.StatusError,
			model.StatusKilled, model.StatusSkipped, model.StatusDeclined:
			return
		}
		if time.Now().After(deadline) {
			log.Warn().Int64("pipeline", pipelineID).Msg("flicker: job timeout, cancelling")
			forge := local.New()
			cancelErr := pipeline.Cancel(context.Background(), forge, _store, repo, user, pl, &model.CancelInfo{
				CanceledByUser: "flicker-timeout",
			})
			if cancelErr != nil {
				log.Error().Err(cancelErr).Int64("pipeline", pipelineID).Msg("flicker: timeout cancel failed")
			}
			return
		}
	}
}
