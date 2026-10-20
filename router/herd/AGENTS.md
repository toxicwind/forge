# AGENTS.md — Herd / herd (`/home/toxic/projects/herd`)

**Role**: Lightweight, transparent proxy server providing dynamic model swapping to llama.cpp and estate backends.
**Stack**: Go (1.23+), TypeScript / Vite / Svelte 5 (`ui-svelte/`).

---

## Project Description:

herd is a light weight, transparent proxy server that provides automatic model swapping to llama.cpp's server.

## Tech stack

- golang
- typescript, vite and svelte 5 for UI (located in ui-svelte/)

## Workflow Tasks

- when summarizing changes only include details that require further action
- Rules for creating pull requests:
  - keep them short and focused on changes
  - skip the test plan
  - write the summary using the same style rules as commit message

## Testing

- Follow test naming conventions like `TestProxyManager_<test name>`, `TestProcessGroup_<test name>`, etc.
- Use `go test -v -run <name pattern for new tests>` to run any new tests you've written.
- Run `gofmt -w <file>` before committing to fix any formatting
- Build go binaries into the ./build/ subdirectory
- Use `make test-dev` after running new tests for a quick over all test run. This runs `go test` and `staticcheck`. Fix any static checking errors. Use this only when changes are made to any code under the `proxy/` directory
- Use `make test-all` before completing work. This includes long running concurrency tests.
- Use `make test-ui` after making changes to the UI in ui-svelte/

### Commit message example format:

```
internal/server: add new feature

Add new feature that implements functionality X and Y.

- key change 1
- key change 2
- key change 3

fixes #123
```

## Code Reviews

- use three levels High, Medium, Low severity
- label each discovered issue with a label like H1, M2, L3 respectively
- High severity are must fix issues (security, race conditions, critical bugs)
- Medium severity are recommended improvements (coding style, missing functionality, inconsistencies)
- Low severity are nice to have changes and nits
- Include a suggestion with each discovered item
- Limit your code review to three items with the highest priority first
- Double check your discovered items and recommended remediations


---


## 🔧 Hard Rules (universal)

1. **Verify live, then claim.** No "done" without `curl` / `lsof` / `nvidia-smi` / `npx tsgo --noEmit`.
2. **Fail loud.** Never `2>/dev/null`, never `|| true`. Errors are diagnostic.
3. **No commit without explicit user request.** Fork stays private under `toxicwind`.
4. **Multi-strategy.** Non-trivial work → 3+ approaches, benchmark, keep runner-up.
5. **TDD/BDD.** Failing assertion first, then fix. `npx tsgo --noEmit` for type-check.
6. **Use emergence tools first.** GHAS (`:25113`) → ast-grep (`ast-grep` binary) → Tombi for TOML.
7. **call_tool_destructive is DEFAULT for state changes.** Write/edit/modify = destructive. Read-only = inspection only.
8. **No `/dev/null`, no banner `echo`.** Both waste tokens.
8b. **BANNED/SLOW TOOLS — do NOT use, ever:** `find`, `head`, `tail`, `/dev/null`, and system-wide `lsof`.
    - `find` over a large/full disk is slow + wasteful -> use `fd` (fast, gitignore-aware)
      or scope `du`/`fd` to a SPECIFIC directory, never the whole `/home`/`/`.
    - `head`/`tail` truncation -> read full files with the `read` tool (1M context).
    - `/dev/null` -> fail loud; never silence errors.
    - `lsof` (esp. system-wide) is INSANELY SLOW -> use INSTANT `/proc/<pid>/fd` symlink
      reads (`readlink /proc/$PID/fd/*`) to see what a process has open. Scope to known PIDs.
9. **Fix bashrc nested quote issue.** The `pi-check` alias had nested double quotes inside single quotes, causing `unexpected EOF while looking for matching '"'` errors. Use functions instead of aliases for complex commands.
9. **CUDA-aware.** RTX 3090 — validate with `nvidia-smi`. Never assume upstream defaults.
10. **Stop stacking long commands.** Sub-second probes. Reserve `60|120` for intentional jobs.
11. **No `head` truncation.** You have 1M context. Read full files. No `| head -20`.
12. **Timeout/failfast/high-frequency is FIRST-CLASS everywhere** (retry, provider-retry, worker-limits, MCP calls, scripts). NO insane monolithic timeouts — use failfast + high-frequency liveness probes + per-attempt deadlines.
13. **Dynamic `${ENV_VAR}` interpolation is first-class** in configs/scripts (settings.json, config.yaml, mcpproxy config, launch scripts). Prefer `${...}` over hardcoded values.
14. **Lint + test after EVERY code change; coverage floor 82%.** Pre-existing type errors in unrelated test files do NOT block the change under review — isolate + report.
15. **BACKGROUNDING IS FIRST-CLASS.** Any op that can run long (downloads, builds, scans,
   npm/pip/apt, model fetches) MUST be launched in background (`cmd &`, capture `$!`), tracked
   by PID, and CANCELLED if it overruns a per-attempt deadline (`timeout`, `kill` on a watchdog
   loop). Never block on a monolithic synchronous command. Keep a live PID ledger.
16. **GOAL = ENDLESS TODO.** TODO.md is a CONTINUOUS improvement loop, not a finite list.
   Re-audit constantly; new findings always append; done items cycle back as deeper waves.
   No "finished" — only "next wave". Mutate TODO after every meaningful step.

---

## 🛠️ Tool Reference

### ✅ INSTALLED (use these)

| Tool | Binary | Purpose |
|---|---|---|
| `fd` | `/usr/bin/fd` | Fast find (respects .gitignore) |
| `rg` | `/usr/bin/rg` | Fast grep (respects .gitignore) |
| `ast-grep` | `~/.local/share/mise/shims/ast-grep` | AST structural search/rewrite |
| `eza` | `/usr/bin/eza` | Modern ls (git-aware) |
| `mise` | `~/.local/bin/mise` | Runtime manager |
| `bun` | mise shim | Fast JS runtime |
| `node` | mise shim | JS runtime |
| `cargo` | mise shim | Rust build |
| `jq` | mise shim | JSON processing |

### ❌ NOT INSTALLED (don't use, install first if needed)

| Tool | Install Command | Purpose |
|---|---|---|
| `tombi` | `mise use -g tombi` | TOML toolkit |
| `tsgo` | `npx tsgo` | TypeScript type-check (use via npx) |
| `vitest` | `npx vitest` | Test runner (use via npx) |

### 🚫 NEVER USE (removed/confusing)

| Name | Why |
|---|---|
| `sg` | That's SGLang, NOT ast-grep. Removed shim. Use `ast-grep`. |

---

## 📝 AST-Grep Patterns

### Rule YAML
```yaml
id: my-rule
language: typescript
rule:
  pattern: 'console.log($MSG)'
fix: 'logger.info($MSG)'
```

### Commands
```bash
ast-grep scan -p 'pattern' -l ts src/
ast-grep scan -p 'pattern' --rewrite 'replacement' src/
ast-grep scan -p 'pattern' --json=stream src/
ast-grep scan -p 'pattern' --interactive src/
ast-grep scan --rule rule.yaml src/
```

---

## 📡 Live-verify commands

```bash
for p in 25100 25109 25112 25115; do
  fuser -s $p/tcp 2>/dev/null && echo "✅ :$p" || echo "❌ :$p DOWN"
done

curl -s http://127.0.0.1:25100/v1/models | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']),'models')"

cd /home/toxic/projects/pi-agent/packages/ai && npx tsgo --noEmit

ast-grep scan -p 'NVIDIA_MODELS' -l ts --json=stream /home/toxic/projects/pi-agent/packages/ai/src/
```

---

## ⏱️ Timeout / Failfast / Dynamic / Env-Var (first-class, 2026-08-13)

- **Failfast + high-frequency**: every retry/timeout path uses per-attempt deadlines, failfast
  on fatal errors, and high-frequency liveness probes. No `timeout 420` monoliths.
- **Dynamic `${ENV_VAR}`**: configs and launch scripts interpolate env vars (`${NVIDIA_API_KEY}`,
  `${HOME}`, etc.). Hardcoded secrets/paths are an anti-pattern — interpolate.
- **Coverage floor 82%**: `npx vitest run --coverage --bail` after code. Lint (`biome`) + typecheck.
- See TODO Wave 5 for the worker-limit `/32` redo + timeout/failfast threading.

## 🔌 MCP / mcpproxy (estate-owned)

- **mcpproxy** is the single MCP federation gateway: `http://127.0.0.1:25109/mcp`, owned by
estate (`pitchfork start mcpproxy` / `mise run restart-mcpproxy` -> `mcpproxy serve
--config=/home/toxic/.mcpproxy/mcp_config.json`). 43 real upstreams (ghas + 42 others).
- **pi MUST list ONLY `mcpproxy`** in `~/.pi/agent/mcp.json` (no duplicate direct `ghas`/
  `nvidia-nim` entries). All MCP tools reach pi through the proxy via `retrieve_tools`.
- **nvidia-nim is NOT an MCP server.** It is a herd/estate-router **completions API**
  (OpenAI-compatible, on `:25100`). NVIDIA models are first-class via pi-agent's `nvidia`
  provider (`packages/ai/src/providers/`) -> estate-router/herd, not an MCP upstream.
- **Subagents**: `config.yaml` `can_spawn_subagents:true` + whitelist + `subagents.defaultModel:
  opencode/hy3-free`. The `subagent` spawn tool is a LIVE-PI builtin (not callable from a
  plain assistant context) — fanout only works inside an interactive pi session.

## 🔌 Port SSOT

`/home/toxic/estate/config/ports.env` — all 25xxx, never invent.

---

## 📁 Directory Structure

```
/home/toxic/estate/
├── agents/              # Agent profiles & identities
├── audit/               # Session deltas, fix history, AGENTS.md inventory
├── docs/                # Architecture docs
├── profiles/            # User/subagent profiles
├── src/                 # Estate source code
├── config/              # All configs (ports.env, etc.)
├── mise.toml            # Mise tool config + tasks
├── pitchfork.toml       # Pitchfork daemon definitions
└── package.json         # Bun package config

/home/toxic/.pi/agent/
├── static_prompt.txt    # Agent persona (replaces generic "helpful assistant")
├── config.yaml          # Allowed tools
└── skills/              # Skill definitions
```

---

## Known outstanding (not blockers)

- **`applyReportedCost` missing** in `packages/ai/src/models.ts`
- 4 services down: `:25106 hf-downloader`, `:25116 kimi-audit-dash`, `:25120 mcp-gateway`, `:25121 byte-vision`

---

**Maintainer**: toxic (`toxicwind@gmail.com`) · **Last Updated**: 2026-08-13 (C2 takeover — mcpproxy correct-use, NVIDIA first-class [98/102], timeout/failfast/${ENV} first-class)

# Emergent findings (2026-09-02 session)
- Estate deployment: kafka listener 25144 still 0 (Java/permission limitation accepted); G502 sensitivity 0.1 verified (lua 190); subagent tracking (PreviousPelican/UglyCod/VoluntaryCat) completed; plan mode preserved; read-only enforced.
- Pi-metaharness: native build bg_51 completed (189MB .node); benchmark reports 0% rate (2 reports at tau/runs/); models.yml configured (discovery + overrides + dead disable); CI spec at .github/workflows/benchmark.yml.
- Emergent-finder: installed (emergent-finder-v1.0.0.tar.gz → /home/toxic/projects/emergent-finder-package); binary /mnt block documented (symlink workaround at ~/.local/share/agents-output/); install.sh executed (exit 0).

# Emergent findings (2026-09-03 session — Firefox Nightly & Web UI Launcher)
- Firefox Nightly SSOT: `firefox-nightly` standardized as primary Wayland browser (`BROWSER=firefox-nightly`, `MOZ_ENABLE_WAYLAND=1`, `SUPER + W` in `~/.config/hypr/custom/variables.lua`, default MIME `firefox-nightly.desktop`).
- Port 9222 SSOT: Dedicated strictly to Chromium CDP sandbox (`/tmp/chrome-headed`, Kataware-Doki WebGPU `cdp-node.ts`, Playwright CDP `helpers.mjs`). `firefox-bidi.service` remains disabled to avoid profile lock collisions (`g304xzha.default-release`) and WebDriver BiDi vs CDP protocol mismatches.
- Estate Web UI Launcher: `scripts/open-web-uis.ts` / `scripts/open-web-uis.sh` (`mise run open-uis`, `mise run list-uis`) probes active listening services with failfast timeouts, reads SSOT ports from `config/ports.env`, and cleanly opens tabs into running Firefox Nightly via native IPC. Anonymous admin auto-login added to `stack/services/grafana-mesh.sh`.
