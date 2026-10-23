# openfang-health — live liveness + provider audit for openfang/coyote on yote

`openfang-health.sh` probes the whole openfang/coyote stack with fail-fast timeouts and writes three artifacts: a machine-readable JSON, an auto-refreshing status page, and a fleet post (only on status transitions or the daily digest — no spam).

<div align="right">

[![license: MIT](https://img.shields.io/badge/license-MIT%20%2B%20upstream-blue?style=for-the-badge)](https://github.com/toxicwind/Estate-projects#license)
[![Estate-projects](https://img.shields.io/badge/Estate--projects-main-6e56cf?style=for-the-badge)](https://github.com/toxicwind/Estate-projects)

</div>

## Why this exists

"Is openfang up?" should be a glance, not an investigation. One script checks the supervisor, every daemon, the kernel, the agents, the audit chain, the inference endpoint, the provider auth posture, memory and GPU — and reduces it all to OK / DEGRADED / FAIL. When something rots (a daemon dies, a provider key dies, memory pressure builds), the fleet hears about it at the transition, not after someone trips over it.

## Features

- **Fail-fast probes** — every check has a timeout; a hung check is data, not a hang.
- **Three artifacts** — JSON (machines), HTML (humans, auto-refresh 300s), fleet post (transitions + daily digest only).
- **Worst-wins rollup** — overall = OK / DEGRADED / FAIL, worst check wins.
- **Checker honesty** — the script exits 1 only when the *checker* errors; a check failure is data, not a crash.
- **Paper-grounded** — checks are designed from AgentSight (eBPF observability), AgentCgroup (memory as the concurrency bottleneck), and HarnessAudit (audit trajectories, not just liveness). See Research lineage.

```mermaid
flowchart TB
    LOOP[loop.sh<br/>pitchfork daemon Estate/openfang-health<br/>every OPENFANG_HEALTH_INTERVAL s (default 300)] --> PROBE[openfang-health.sh<br/>fail-fast probes]
    PROBE --> JSON[/home/toxic/.fleet-bus/var/openfang-health/openfang-health.json]
    PROBE --> HTML[openfang-health.html<br/>auto-refresh 300s]
    PROBE -->|transition or daily digest| FLEET[squawk fleet post]
    PROBE -->|supervisor, daemons, kernel, agents,<br/>audit chain, llama_swap, kimi_auto,<br/>providers, endpoints, memory, GPU| ROLLUP{worst wins}
    ROLLUP --> OK[OK]
    ROLLUP --> DEG[DEGRADED]
    ROLLUP --> FAIL[FAIL]
```

## Checks

| Check | What it verifies |
|---|---|
| supervisor | pitchfork.service active, pid + RSS |
| daemons | every daemon in `pitchfork list` is `running` |
| openfang_kernel | `openfang status` boots, audit trail entry count |
| agents | coyote, shingle-pilot, squawk-relay, assistant all Running |
| audit_chain | openfang audit log chain integrity OK |
| llama_swap | `:25100/v1/models` answers, model count |
| kimi_auto | resolver state.json fresh (<30 min) and healthy |
| provider_* | live/dead auth posture per cloud provider (names only, never key values) |
| yote_ep / meshub_ep / coyote_ep | `:25102/health`, `:25115` tcp, `:25143/health` |
| memory / gpu | free RAM, nvidia-smi one-liner |

## Quick start

```bash
OPENFANG_HEALTH_INTERVAL=300 ./loop.sh   # under pitchfork in production
./openfang-health.sh                     # one-shot probe
cat /home/toxic/.fleet-bus/var/openfang-health/openfang-health.json
```

## Research lineage

- **AgentSight** (arXiv:2508.02736) — *System-Level Observability for AI Agents Using eBPF.* Closes the semantic gap between agent intent and low-level behavior; zero-SDK `top`/`strace`-like observability. Here: we link the agent registry (intent) to OS truth (pitchfork procs, ports, RSS) without touching the agent SDK.
- **AgentCgroup** (arXiv:2602.09345) — *Understanding and Controlling OS Resources of AI Agents.* 144 SWE tasks: OS-level execution is 56–74% of end-to-end latency; **memory, not CPU, is the concurrency bottleneck**; tool-call-driven spikes hit 15.4× peak-to-average; cgroup hierarchies aligned to tool-call boundaries + sched_ext/memcg_bpf_ops enforcement. Here: we monitor supervisor RSS and box memory pressure as first-class signals, and the daemon placement follows the paper's granularity lesson (per-service pitchfork supervision).
- **HarnessAudit** (arXiv:2605.14271) — *Auditing Agent Harness Safety.* Output-level eval can't see mid-trajectory violations; audits boundary compliance, execution fidelity, system stability across full trajectories. Here: we verify the audit-trail chain integrity and registry state, not just "process alive".

Code: AgentSight https://github.com/eunomia-bpf/agentsight · AgentCgroup https://github.com/eunomia-bpf/agentcgroup

## License & security

MIT where marked — [LICENSE](https://github.com/toxicwind/Estate-projects#license). Provider checks report **auth posture by name only** — key values never leave the box, never enter the JSON, never reach the fleet post. The HTML status page and JSON are served from the estate's own paths; don't funnel them publicly without a gate.
