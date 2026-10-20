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

// Package flicker implements the ranch build daemon's direct-job layer on
// top of the pipeline engine. Jobs are submitted via POST /api/jobs with a
// plain spec (command, workdir, env, ...); flicker generates an equivalent
// pipeline YAML in-memory, runs it through the local backend, and provides
// brand-compatible content-hash caching.
package flicker

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// JobSpec is the flicker direct-job submission format. It is a superset of
// the old brandd.py job spec: every brand field is accepted so existing
// callers keep working.
type JobSpec struct {
	// Command is the shell command to run (brand: command).
	Command string `json:"command,omitempty"`
	// Script is an alias for Command (multi-line scripts allowed).
	Script string `json:"script,omitempty"`
	// Workdir is the working directory (brand: workdir).
	Workdir string `json:"workdir,omitempty"`
	// Env holds extra environment variables (brand: env).
	Env map[string]string `json:"env,omitempty"`
	// CacheKey is an optional caller-provided cache discriminator
	// (brand: cache_key). Empty means derive from content only.
	CacheKey string `json:"cache_key,omitempty"`
	// Repo is a label for the source repo (brand: repo). Informational only;
	// flicker does not clone.
	Repo string `json:"repo,omitempty"`
	// Toolchain selects a toolchain preflight (brand: toolchain).
	// Informational in flicker; the login shell resolves toolchains via mise.
	Toolchain string `json:"toolchain,omitempty"`
	// Artifacts lists paths (relative to workdir) to preserve on success
	// (brand: artifacts).
	Artifacts []string `json:"artifacts,omitempty"`
	// Timeout is the max job runtime in seconds (brand: timeout).
	// 0 means no timeout.
	Timeout int64 `json:"timeout,omitempty"`
	// Name is a human-readable job name (brand: name).
	Name string `json:"name,omitempty"`
}

// command returns the effective shell command.
func (s *JobSpec) command() string {
	if s.Command != "" {
		return s.Command
	}
	return s.Script
}

// stepName returns a safe step name derived from the job name.
func (s *JobSpec) stepName() string {
	name := s.Name
	if name == "" {
		name = "job"
	}
	// woodpecker step names: lowercase alnum + dash/underscore
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == ' ':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "job"
	}
	return out
}

// ToYAML generates the equivalent woodpecker pipeline YAML for this job.
// The local backend runs each step's commands with the step's image as the
// shell; flicker uses bash as a login shell so mise toolchains resolve.
func (s *JobSpec) ToYAML() ([]byte, error) {
	env := map[string]any{}
	for k, v := range s.Env {
		env[k] = v
	}
	// Flicker job identity, visible to the running command.
	env["FLICKER_JOB_NAME"] = s.stepName()

	step := map[string]any{
		"image":      "bash",
		"commands":   []string{s.command()},
		"environment": env,
	}
	if s.Workdir != "" {
		step["directory"] = s.Workdir
	}

	pipeline := map[string]any{
		"skip_clone": true,
		"steps": map[string]any{
			s.stepName(): step,
		},
	}

	return yaml.Marshal(pipeline)
}

// Hash computes the content hash for caching. It covers the same fields
// brandd.py hashed: repo, workdir, toolchain, command, env, artifacts,
// plus the caller cache key.
func (s *JobSpec) Hash() string {
	h := sha256.New()
	fmt.Fprintf(h, "repo=%s\n", s.Repo)
	fmt.Fprintf(h, "workdir=%s\n", s.Workdir)
	fmt.Fprintf(h, "toolchain=%s\n", s.Toolchain)
	fmt.Fprintf(h, "command=%s\n", s.command())
	fmt.Fprintf(h, "cache_key=%s\n", s.CacheKey)

	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(h, "env.%s=%s\n", k, s.Env[k])
	}

	arts := append([]string{}, s.Artifacts...)
	sort.Strings(arts)
	for _, a := range arts {
		fmt.Fprintf(h, "artifact=%s\n", a)
	}

	return hex.EncodeToString(h.Sum(nil))
}

// Validate checks the spec has a runnable command.
func (s *JobSpec) Validate() error {
	if s.command() == "" {
		return fmt.Errorf("flicker: job needs a command (or script)")
	}
	return nil
}
