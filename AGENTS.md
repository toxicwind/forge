# AGENTS.md — Forge (`pens/forge`)

> **Part of the estate's pens family** (`pens/{estate,geode,barn,ranch,olympus}`).
> A pens repo is a **thin coordinator**, not a product monorepo. It owns only
> its own metadata, `bin/`, and `docs/`. Products are peer standalone
> checkouts, referenced-not-owned.

## This repo is submoduleless by design

There are **no submodules** here. The repo's `.gitignore` is the kitchen-sink:
`*` with a whitelist. Any product checkout dropped into `products/` is
**auto-ignored** — nothing to register, no gitlink, no nested `.git` in the
index.

```
*
!.gitignore
!README.md
!LICENSE
!package.json
!mise.toml
!AGENTS.md
!bin/
!bin/**
!docs/
!docs/**
```

## Rules

1. **Never** `git submodule add` and never commit a gitlink (mode 160000).
2. A product is a peer clone: `git clone <url> products/<name>`. It brings
   its own history and its own remote.
3. The pen repo's `git status` must stay clean regardless of what the
   products are doing.
4. `bin/` entries are symlinked into `~/.local/bin` and pinned by the
   estate-ops manifest; `bin-verify.sh` treats a broken link as FAIL.
5. Runtime language is **Bun/TypeScript**.
6. Secrets never live in this repo. They live in the secretsmith keyring.

## Where things go

- **A new product** → `products/<name>/`, plus a row in this pen's README
  member table and an entry in the estate-ops bin manifest.
- **Pen-owned documentation** → `docs/`.
- **Estate-wide documentation** (architecture, daemons, conventions) →
  `pens/estate/docs/`.
