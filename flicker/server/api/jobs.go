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

package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"go.woodpecker-ci.org/woodpecker/v3/server/flicker"
	"go.woodpecker-ci.org/woodpecker/v3/server/model"
	"go.woodpecker-ci.org/woodpecker/v3/server/pipeline"
	"go.woodpecker-ci.org/woodpecker/v3/server/store"
)

// jobResponse is the flicker job representation (brand-compatible).
type jobResponse struct {
	ID         int64             `json:"id"`
	Number     int64             `json:"number"`
	Name       string            `json:"name"`
	Status     string            `json:"status"`
	Cached     bool              `json:"cached,omitempty"`
	Hash       string            `json:"hash,omitempty"`
	Created    int64             `json:"created"`
	Started    int64             `json:"started,omitempty"`
	Finished   int64             `json:"finished,omitempty"`
	DurationMs int64             `json:"duration_ms,omitempty"`
	ExitCode   int               `json:"exit_code,omitempty"`
	Message    string            `json:"message,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
}

func toJobResponse(p *model.Pipeline) *jobResponse {
	r := &jobResponse{
		ID:      p.ID,
		Number:  p.Number,
		Status:  string(p.Status),
		Created: p.Created,
		Started: p.Started,
		Finished: p.Finished,
		Message: p.Message,
	}
	if p.Started > 0 && p.Finished > 0 {
		r.DurationMs = (p.Finished - p.Started) * 1000
	}
	if name, ok := p.AdditionalVariables["FLICKER_JOB_NAME"]; ok {
		r.Name = name
	}
	if hash, ok := p.AdditionalVariables["FLICKER_JOB_HASH"]; ok {
		r.Hash = hash
	}
	return r
}

// SubmitJob handles POST /api/jobs — the flicker direct-job submission.
// It accepts the brand-compatible job spec, checks the content-hash cache,
// and creates a pipeline for cache misses.
func SubmitJob(c *gin.Context) {
	_store := store.FromContext(c)

	var spec flicker.JobSpec
	if err := c.ShouldBindJSON(&spec); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid job spec: " + err.Error()})
		return
	}
	if err := spec.Validate(); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hash := spec.Hash()

	// Content-hash cache: identical successful specs return CACHED.
	if hit := flicker.CacheLookup(hash); hit != nil {
		log.Info().Str("hash", hash[:12]).Msg("flicker: job cache hit")
		c.JSON(http.StatusOK, &jobResponse{
			ID:         hit.PipelineID,
			Status:     "success",
			Cached:     true,
			Hash:       hash,
			DurationMs: hit.DurationMs,
			Message:    "CACHED",
		})
		return
	}

	repo, user, err := flicker.EnsureRepoAndUser(_store)
	if err != nil {
		log.Error().Err(err).Msg("flicker: ensure repo/user")
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	yamlData, err := spec.ToYAML()
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "yaml generation: " + err.Error()})
		return
	}

	pl := flicker.NewPipeline(repo, user, &spec, hash)
	pl, err = pipeline.CreateDirect(c.Request.Context(), _store, repo, user, pl, yamlData)
	if err != nil {
		log.Error().Err(err).Msg("flicker: create pipeline")
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Per-job timeout: cancel the pipeline if it runs too long.
	if spec.Timeout > 0 {
		go flicker.EnforceTimeout(_store, repo, user, pl.ID, spec.Timeout)
	}

	resp := toJobResponse(pl)
	resp.Hash = hash
	c.JSON(http.StatusOK, resp)
}

// ListJobs handles GET /api/jobs — recent flicker jobs.
func ListJobs(c *gin.Context) {
	_store := store.FromContext(c)

	repo, _, err := flicker.EnsureRepoAndUser(_store)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	page := 1
	if p := c.Query("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			page = n
		}
	}

	pipelines, err := _store.GetPipelineList(repo, &model.ListOptionsWithAll{
		ListOptions: &model.ListOptions{Page: page, PerPage: 25},
		All:         true,
	}, &model.PipelineFilter{})
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	jobs := make([]*jobResponse, 0, len(pipelines))
	for _, p := range pipelines {
		jobs = append(jobs, toJobResponse(p))
	}
	c.JSON(http.StatusOK, jobs)
}

// GetJob handles GET /api/jobs/:id — a single job's status.
func GetJob(c *gin.Context) {
	_store := store.FromContext(c)

	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid job id"})
		return
	}

	pl, err := _store.GetPipeline(id)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "job not found"})
		return
	}

	c.JSON(http.StatusOK, toJobResponse(pl))
}

// FlickerHealth handles GET /api/health — brand-compatible health.
func FlickerHealth(c *gin.Context) {
	_store := store.FromContext(c)

	repo, _, err := flicker.EnsureRepoAndUser(_store)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	active, err := _store.GetActivePipelineList(repo)
	if err != nil {
		active = nil
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"service":   "flicker",
		"time":      time.Now().UTC().Format(time.RFC3339),
		"running":   len(active),
		"cache":     flicker.CacheStats(),
	})
}
