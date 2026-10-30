# Forge

The mutation plane: codeflux-patchling (deterministic seeded mutation), flock-proxy router, borrow-from-forge patterns

One of the estate's five pens (`pens/{estate,geode,barn,ranch,olympus}`).
Every pen has the same shape: `products/` for peer standalone checkouts,
`docs/` for pen-owned documentation, and a `bin/` entrypoint surface that
is symlinked into `~/.local/bin` and pinned by the estate-ops manifest.

## Products

| Product | Subdir | Port | Language | Notes |
|---|---|---|---|---|
| — | `<product>/` | — | — | — |

## Layout

```text
forge/
  .gitignore    kitchen-sink `*` + whitelist (submoduleless doctrine)
  README.md     this file — role, member table, ports, languages
  LICENSE
  package.json
  mise.toml
  AGENTS.md
  bin/          entrypoint symlink surface -> ~/.local/bin
  products/     peer standalone checkouts (auto-ignored, never tracked)
  docs/         pen-owned documentation
```

## Tooling

- **bin surface**: entrypoints symlinked into `~/.local/bin`, pinned by
  `pens/barn/estate-ops/bin/manifest.yaml` and verified by
  `pens/barn/estate-ops/bin/bin-verify.sh`. A broken link is a FAIL, never a WARN.
- **README**: generated from the pen's own product set by
  `pens/barn/estate-ops/scaffold/bin/readme-gen.ts`; regenerate with
  `bun run readme`.
- **manifest**: regenerate with
  `pens/barn/estate-ops/bin/manifest-gen.py`.

## Conventions

- Products are **peer standalone checkouts**, referenced-not-owned. This repo
  tracks only its own metadata, `bin/`, and `docs/`.
- Daemon ids use **dashes, never underscores** (`config-naming-conventions.md`).
- Ports are declared in the control plane's `config/ports.env` as
  `UPPER_SNAKE_*_PORT=<25xxx>` — that file is the numeric SSOT.
- Runtime language across the estate is **Bun/TypeScript**.

## License

Apache-2.0 unless a product states otherwise. Confidential products keep
their own license and their own visibility.
