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
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"

	"go.woodpecker-ci.org/woodpecker/v3/server"
	"go.woodpecker-ci.org/woodpecker/v3/server/store"
)

// GetJobLogs handles GET /api/jobs/:id/logs — plain-text logs for a job.
// Brand-compatible: returns the combined step output as text.
func GetJobLogs(c *gin.Context) {
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

	workflows, err := _store.WorkflowGetTree(pl)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	_logs := server.Config.Services.LogStore

	var sb strings.Builder
	for _, wf := range workflows {
		steps, err := _store.StepListFromWorkflowFind(wf)
		if err != nil {
			log.Error().Err(err).Msg("flicker: list steps")
			continue
		}
		for _, step := range steps {
			entries, err := _logs.LogFind(step)
			if err != nil {
				log.Error().Err(err).Msg("flicker: find logs")
				continue
			}
			for _, e := range entries {
				sb.Write(e.Data)
			}
		}
	}

	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.String(http.StatusOK, sb.String())
}
