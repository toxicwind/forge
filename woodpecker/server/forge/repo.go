// Copyright 2026 Forge Authors
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

package forge

import (
	"fmt"
	"time"

	"github.com/rs/zerolog/log"

	"go.woodpecker-ci.org/woodpecker/v3/server/model"
	"go.woodpecker-ci.org/woodpecker/v3/server/store"
)

// ForgeRepoFullName is the synthetic repo all direct jobs live under.
const ForgeRepoFullName = "forge/jobs"

// ForgeUserLogin is the synthetic job-submitter user.
const ForgeUserLogin = "forge"

// EnsureRepoAndUser creates the synthetic forge repo and user if missing.
// It is idempotent and safe to call at every server boot.
func EnsureRepoAndUser(_store store.Store) (*model.Repo, *model.User, error) {
	user, err := _store.GetUserByLogin(0, ForgeUserLogin)
	if err != nil {
		user = &model.User{
			Login:  ForgeUserLogin,
			Email:  "forge@localhost",
			Admin:  true,
		}
		if err := _store.CreateUser(user); err != nil {
			return nil, nil, fmt.Errorf("forge: create user: %w", err)
		}
		log.Info().Msg("forge: created synthetic user")
	}

	repo, err := _store.GetRepoName(ForgeRepoFullName)
	if err != nil {
		repo = &model.Repo{
			ForgeID:   1, // local forge, created by setupForgeService
			UserID:    user.ID,
			Owner:     "forge",
			Name:      "jobs",
			FullName:  ForgeRepoFullName,
			Branch:    "main",
			Timeout:   60 * 60, // 1h default, per-job timeout overrides
			AllowPull: true,
			Config:    ".forge.yaml",
			Trusted: model.TrustedConfiguration{
				Network: true,
				Volumes: true,
			},
		}
		if err := _store.CreateRepo(repo); err != nil {
			return nil, nil, fmt.Errorf("forge: create repo: %w", err)
		}
		log.Info().Msg("forge: created synthetic repo")
	}

	return repo, user, nil
}

// NewPipeline builds the model.Pipeline for a direct job.
func NewPipeline(repo *model.Repo, user *model.User, spec *JobSpec, hash string) *model.Pipeline {
	name := spec.Name
	if name == "" {
		name = "forge job"
	}
	return &model.Pipeline{
		RepoID:   repo.ID,
		Event:    model.EventManual,
		Commit:   hash[:12], // content hash as the "commit"
		Branch:   "main",
		Ref:      "refs/heads/main",
		Message:  fmt.Sprintf("forge: %s", name),
		Author:   user.Login,
		Email:    user.Email,
		Sender:   user.Login,
		Avatar:   "",
		Timestamp: time.Now().UTC().Unix(),
		AdditionalVariables: map[string]string{
			"FORGE_JOB_HASH": hash,
			"FORGE_JOB_NAME": name,
		},
	}
}
