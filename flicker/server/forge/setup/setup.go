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

package setup

import (
	"fmt"

	"go.woodpecker-ci.org/woodpecker/v3/server/forge"
	"go.woodpecker-ci.org/woodpecker/v3/server/forge/local"
	"go.woodpecker-ci.org/woodpecker/v3/server/model"
)

// Forge returns the forge driver for flicker. Only the local no-op forge is
// supported — all remote forge integrations (github, gitlab, gitea,
// forgejo, bitbucket) were stripped. Jobs are submitted directly via
// POST /api/jobs.
func Forge(forge *model.Forge) (forge.Forge, error) {
	switch forge.Type {
	case model.ForgeTypeLocal:
		return local.New(), nil
	default:
		return nil, fmt.Errorf("forge not configured: flicker only supports the local forge (got %q)", forge.Type)
	}
}
