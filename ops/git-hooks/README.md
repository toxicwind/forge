# Global Git Hooks - Autonomous Secret Gate

Box-wide git hook gate that runs gitleaks on every commit and push, in every
repository on this machine, without each repo having to opt in.

## Install

    git config --global core.hooksPath /home/toxic/estate/ops/git-hooks
    git config --global core.excludesFile /home/toxic/estate/ops/gitignore/layers/50-secrets.gitignore

## What runs

| Hook | Gate |
|---|---|
| `pre-commit` | `gitleaks git --staged` over the staged diff. In the estate repo, also re-renders the layered `.gitignore` and stages it when it drifted. |
| `pre-push` | `gitleaks git --log-opts=<range>` over exactly the commits being pushed, computed per ref-update from stdin. |

## Chaining

Every wrapper (`pre-commit`, `pre-push`) execs `dispatch`, which runs the gate
and then delegates to the repository's own hook at
`$(git rev-parse --git-common-dir)/hooks/<name>` if one is executable. A repo
that sets its own `core.hooksPath` (e.g. husky) is the one case the gate cannot
see; those repos must install the gate themselves.

## Bypass

- One command, gate only: `ESTATE_SECRET_GATE=off git commit ...`
- Everything, including the repo's own hook: `git commit --no-verify`

## Enforcement layers

The gate is the second of three layers:

1. `ops/gitignore/layers/50-secrets.gitignore` - declared last in
   `ops/gitignore/manifest.json`, so no earlier negation can re-include
   credential material. Rendered by `ops/bin/gitignore-sync.ts`.
2. These hooks - catch anything staged or pushed in any repo.
3. `git-mutator` (`helpers/git-mutator/cli.ts`) - agent-side `commit-push`
   audit that blocks before the hook is even reached.

## Files

- `dispatch` - the gate logic and chaining.
- `pre-commit`, `pre-push` - thin wrappers that exec `dispatch`.
