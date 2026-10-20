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
	"time"

	"github.com/rs/zerolog/log"

	"go.woodpecker-ci.org/woodpecker/v3/server/model"
	"go.woodpecker-ci.org/woodpecker/v3/server/store"
)

// StartCompletionWatcher launches a goroutine that watches for finished
// flicker pipelines and records successful ones in the content-hash cache.
// It polls the store; the query is cheap and scoped to the flicker repo.
func StartCompletionWatcher(ctx context.Context, _store store.Store) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		// Track which pipelines we've already processed.
		seen := map[int64]bool{}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				watchOnce(_store, seen)
			}
		}
	}()
	log.Info().Msg("flicker: completion watcher started")
}

func watchOnce(_store store.Store, seen map[int64]bool) {
	repo, _, err := EnsureRepoAndUser(_store)
	if err != nil {
		return
	}

	// Get recent pipelines; filter to unseen finished ones.
	pipelines, err := _store.GetPipelineList(repo, &model.ListOptionsWithAll{
		ListOptions: &model.ListOptions{Page: 1, PerPage: 50},
		All:         true,
	}, &model.PipelineFilter{})
	if err != nil {
		return
	}

	for _, pl := range pipelines {
		if seen[pl.ID] {
			continue
		}
		switch pl.Status {
		case model.StatusSuccess:
			hash, ok := pl.AdditionalVariables["FLICKER_JOB_HASH"]
			if ok && hash != "" {
				var durationMs int64
				if pl.Started > 0 && pl.Finished > 0 {
					durationMs = (pl.Finished - pl.Started) * 1000
				}
				RecordSuccess(hash, pl.ID, durationMs)
				log.Info().
					Int64("pipeline", pl.ID).
					Str("hash", hash[:12]).
					Msg("flicker: cached successful job")
			}
			seen[pl.ID] = true
		case model.StatusFailure, model.StatusError, model.StatusKilled,
			model.StatusSkipped, model.StatusDeclined:
			// Terminal but not successful: don't cache, but don't revisit.
			seen[pl.ID] = true
		}
	}
}
