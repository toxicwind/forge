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

// Package local implements a no-op forge for flicker. Flicker submits jobs
// directly via POST /api/jobs with an in-memory pipeline definition — there
// is no git forge to talk to. This forge satisfies the server's forge
// interface so the server boots and the pipeline machinery (which expects a
// forge for netrc/metadata calls) works, while every forge-specific
// operation is a documented no-op.
package local

import (
	"context"
	"net/http"

	"github.com/rs/zerolog/log"

	"go.woodpecker-ci.org/woodpecker/v3/server/forge"
	forge_types "go.woodpecker-ci.org/woodpecker/v3/server/forge/types"
	"go.woodpecker-ci.org/woodpecker/v3/server/model"
)

var _ forge.Forge = (*client)(nil)

type client struct {
	url string
}

// New returns the flicker local (no-op) forge.
func New() forge.Forge {
	return &client{url: "local://flicker"}
}

func (c *client) Name() string {
	return "local"
}

func (c *client) URL() string {
	return c.url
}

func (c *client) Login(_ context.Context, _ *forge_types.OAuthRequest) (*model.User, string, error) {
	return nil, "", forge_types.ErrNotImplemented
}

func (c *client) Teams(_ context.Context, _ *model.User, _ *model.ListOptions) ([]*model.Team, error) {
	return []*model.Team{}, nil
}

func (c *client) Repo(_ context.Context, _ *model.User, _ model.ForgeRemoteID, _, _ string) (*model.Repo, error) {
	return nil, forge_types.ErrNotImplemented
}

func (c *client) Repos(_ context.Context, _ *model.User, _ *model.ListOptions) ([]*model.Repo, error) {
	return []*model.Repo{}, nil
}

func (c *client) File(_ context.Context, _ *model.User, r *model.Repo, b *model.Pipeline, fileName string) ([]byte, error) {
	// Flicker never fetches pipeline configs from a forge; they are
	// generated in-memory from the submitted job spec.
	return nil, &forge_types.ErrConfigNotFound{Configs: []string{fileName}}
}

func (c *client) Dir(_ context.Context, _ *model.User, _ *model.Repo, _ *model.Pipeline, _ string) ([]*forge_types.FileMeta, error) {
	return nil, forge_types.ErrNotImplemented
}

func (c *client) Status(_ context.Context, _ *model.User, r *model.Repo, b *model.Pipeline, p *model.Workflow) error {
	log.Debug().
		Str("repo", r.FullName).
		Int64("pipeline", b.Number).
		Str("workflow", p.Name).
		Str("state", string(p.State)).
		Msg("flicker local forge: status update (no-op)")
	return nil
}

func (c *client) Netrc(_ *model.User, _ *model.Repo) (*model.Netrc, error) {
	return &model.Netrc{}, nil
}

func (c *client) Activate(_ context.Context, _ *model.User, _ *model.Repo, _ string) error {
	return forge_types.ErrNotImplemented
}

func (c *client) Deactivate(_ context.Context, _ *model.User, _ *model.Repo, _ string) error {
	return nil
}

func (c *client) Branches(_ context.Context, _ *model.User, _ *model.Repo, _ *model.ListOptions) ([]string, error) {
	return []string{"main"}, nil
}

func (c *client) BranchHead(_ context.Context, _ *model.User, _ *model.Repo, branch string) (*model.Commit, error) {
	return &model.Commit{
		SHA: "flicker-local",
	}, nil
}

func (c *client) PullRequests(_ context.Context, _ *model.User, _ *model.Repo, _ *model.ListOptions) ([]*model.PullRequest, error) {
	return []*model.PullRequest{}, nil
}

func (c *client) Hook(_ context.Context, _ *http.Request) (*model.Repo, *model.Pipeline, error) {
	return nil, nil, &forge_types.ErrIgnoreEvent{Event: "flicker-local-no-webhooks"}
}

func (c *client) OrgMembership(_ context.Context, _ *model.User, _ string) (*model.OrgPerm, error) {
	return &model.OrgPerm{Member: false, Admin: false}, nil
}

func (c *client) Org(_ context.Context, _ *model.User, _ string) (*model.Org, error) {
	return nil, forge_types.ErrNotImplemented
}
