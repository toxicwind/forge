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

package pipeline

import (
	"context"
	"errors"
	"fmt"

	"github.com/rs/zerolog/log"

	forge_types "go.woodpecker-ci.org/woodpecker/v3/server/forge/types"
	"go.woodpecker-ci.org/woodpecker/v3/server/forge/local"
	"go.woodpecker-ci.org/woodpecker/v3/server/model"
	"go.woodpecker-ci.org/woodpecker/v3/server/store"
	"go.woodpecker-ci.org/woodpecker/v3/version"
)

// CreateDirect creates and starts a pipeline from an in-memory YAML config,
// without any forge interaction. This is flicker's direct-job path:
// POST /api/jobs generates the YAML from the job spec and calls this.
//
// It mirrors Create() but skips the forge config fetch — the YAML is
// supplied by the caller instead of being fetched from a git forge.
func CreateDirect(ctx context.Context, _store store.Store, repo *model.Repo, user *model.User, pipeline *model.Pipeline, yamlData []byte) (*model.Pipeline, error) {
	_forge := local.New()

	// persist the pipeline row
	pipeline.RepoID = repo.ID
	pipeline.Status = model.StatusCreated
	pipeline.Version = version.String()
	setApprovalState(repo, pipeline)
	if err := _store.CreatePipeline(pipeline); err != nil {
		return nil, fmt.Errorf("flicker: failed to save pipeline for %s: %w", repo.FullName, err)
	}

	// persist the in-memory config for historical correctness / restarts
	yamlFile := &forge_types.FileMeta{
		Name: ".flicker.yaml",
		Data: yamlData,
	}
	config, err := findOrPersistPipelineConfig(_store, pipeline, yamlFile)
	if err != nil {
		return nil, fmt.Errorf("flicker: failed to persist pipeline config: %w", err)
	}
	if err := linkPipelineConfigs(_store, []*model.Config{config}, pipeline.ID); err != nil {
		return nil, fmt.Errorf("flicker: failed to link pipeline config: %w", err)
	}

	currentPipeline, pipelineItems, parseErr, err := createPipelineItems(ctx, _forge, _store, pipeline, user, repo, []*forge_types.FileMeta{yamlFile}, nil, false)
	*pipeline = *currentPipeline
	if handleParseErrors(pipeline, parseErr) {
		log.Debug().Str("repo", repo.FullName).Err(parseErr).Msg("flicker: failed to parse generated yaml")
		return pipeline, updatePipelineWithErr(ctx, _forge, _store, pipeline, repo, user, parseErr)
	}
	if err != nil {
		return nil, fmt.Errorf("flicker: createPipelineItems failed: %w", err)
	}

	if len(pipelineItems) == 0 {
		log.Debug().Str("repo", repo.FullName).Msg(ErrFiltered.Error())
		if err := _store.DeletePipeline(pipeline); err != nil {
			log.Error().Str("repo", repo.FullName).Err(err).Msg("flicker: failed to delete empty pipeline")
		}
		return nil, ErrFiltered
	}

	publishPipeline(ctx, _forge, pipeline, repo, user)

	if pipeline.Status == model.StatusBlocked {
		return pipeline, nil
	}

	if err := updatePipelinePending(ctx, _forge, _store, pipeline, repo, user); err != nil {
		return nil, err
	}

	pipeline, err = start(ctx, _forge, _store, pipeline, user, repo, pipelineItems)
	if err != nil {
		return nil, errors.New(fmt.Sprintf("flicker: failed to start pipeline for %s", repo.FullName))
	}

	return pipeline, nil
}
