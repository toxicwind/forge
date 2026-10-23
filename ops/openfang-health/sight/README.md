# mcp-sight — kernel-observed "what is happening right now" eBPF observability

`mcp-sight` surface real kernel events (exec / syscall / fs / network) as MCP
tools, replacing pid-polls with ground truth. It lives inside
`ops/openfang-health/sight/` because openfang-health is the estate's existing
ops/health home and already owns the health surface.

## Why this exists

The rest of openfang-health polls process tables, ports, and RSS. Polls can
only show _what is running_; they cannot attest to _what ran_, _what touched a
credential path_, or _what a process reached out to_. `mcp-sight` attaches
bpftrace probes so those answers come from the kernel, not an inference.

Grounded in the same lineage as openfang-health: AgentSight (arXiv:2508.02736)
"system-level observability for AI agents using eBPF" — zero-SDK, OS-truth.

## Architecture

```
        collector.py (ROOT)                 mcp_sight.py (unprivileged MCP reader)
  runs bpftrace probes/sight.bt   ──────▶  reads ~/.fleet-bus/var/openfang-health/sight/
  one process, all probe types              · exec.jsonl / net.jsonl / fs.jsonl / syscall.jsonl
  ring-buffers to JSONL + sidecar           · {file}.meta.json  (drop counters + health)
  appends queryable sight-YYYYMMDD.jsonl    · fails soft to the pitchfork poll
```

- **Privilege split.** bpftrace needs elevation on this box
  (`kernel.unprivileged_bpf_disabled=2`, `perf_event_paranoid=2`, tracefs not
  world-readable), so the **collector runs as root**. The systemd _user_
  manager cannot raise ambient capabilities here, so the collector service is a
  **root** unit (`/etc/systemd/system`). The MCP server runs **unprivileged** —
  it only reads the state dir.
- **Read-only.** Observation only. No syscall interception, no blocking, no
  throttling. The only privilege used is the ability to attach probes.
- **Bounded.** Event rings are capped (`--capacity`, default 256) and every
  probe's output is elapsed-time/ring-bounded. The `fs` probe filters opens to a
  tight sensitive-path allowlist server-side so a chatty `~/.cache` write never
  floods anything. Drop counters are in every sidecar.
- **Fail soft.** If bpftrace is down or a ring is stale, `mcp_sight_*` reports
  `DEGRADED`/`STALE` and falls back to the existing pitfork poll — **never**
  silently returns "nothing is happening".

## Layout

| File                  | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `probes/sight.bt`     | Single combined bpftrace program (tracepoint + fentry), TAG-prefixed      |
| `collector.py`        | Runs `sight.bt` as root, routes tags, writes rings + sidecars + daily log |
| `mcp_sight.py`        | Unprivileged stdio MCP server exposing `mcp_sight_*` tools                |
| `launch-collector.sh` | Start the collector (escalates via `sudo -n`, or exec as root)            |

## Probes

| Tag    | What is observed                                            | Line  |
| ------ | ----------------------------------------------------------- | ----- |
| `EXEC` | every `execve`/`execveat` (pid, tid, uid, comm, exe, argv0) | `EXEC | ts  | pid | tid  | uid     | comm        | exe       | argv0` |
| `P`    | every `ptrace` (request, target pid)                        | `P    | ts  | pid | comm | request | target_pid` |
| `FS`   | `openat`/`openat2` matching a sensitive-path allowlist      | `FS   | ts  | pid | comm | dfd     | flags       | filename` |
| `NET`  | outbound TCP `tcp_v4/v6_connect` (ipver, dest, port)        | `NET  | ts  | pid | comm | ipver   | dest        | port`     |

ts is wall-clock ISO UTC; net port is byte-swapped by the collector.

## MCP tools

```
mcp_sight_exec    recent execve events        (limit, default 20)
mcp_sight_syscall recent ptrace events        (limit)
mcp_sight_fs      sensitive-path opens        (limit)
mcp_sight_net     outbound connects, correlated to the pitchfork daemon map (limit)
```

Each returns the events plus a status header (`sight: live` / `DEGRADED` /
`STALE`) with drop counters and, on degradation, the fallback poll summary.

## Run

```bash
# collector (root). Escalates via passwordless sudo; run under a root unit in prod.
sudo ./launch-collector.sh

# one-shot probe test (privileged), overwriting the sight dir
rm -rf ~/.fleet-bus/var/openfang-health/sight
python3 collector.py --sudo   # Ctrl-C to stop

# MCP server (unprivileged) — register as a local MCP in kappa.json:
#   {"mcp": {"mcp_sight": {"type": "local",
#           "command": ["python3", "<repo>/sight/mcp_sight.py"]}}}
python3 mcp_sight.py           # stdio; drive with an MCP client
```

### Durable root unit (production)

```ini
# /etc/systemd/system/mcp-sight.service
[Unit]
Description=mcp-sight eBPF collector
After=network.target
[Service]
Type=simple
ExecStart=/home/toxic/pens/ranch/forge/ops/openfang-health/sight/launch-collector.sh --as-root
Restart=always
[Install]
WantedBy=multi-user.target
sudo systemctl daemon-reload && sudo systemctl enable --now mcp-sight
```

## Validation

- `mcp_sight_exec` returns a real exec event (pid/comm/exe) cross-checked by
  running the same binary; drop counters appear in the sidecar when the ring
  overflows.
- With bpftrace stopped, `mcp_sight_*` reports `STALE`/`DEGRADED` and the
  pitchfork-poll fallback — never an empty "nothing happening".

## Notes

- The `fs` allowlist is deliberately tight (credential/config/secret surfaces).
  Add a path to `SENSITIVE_PREFIXES` to observe it; the ring stays small.
- Full argv (beyond argv0) is intentionally out of scope for a high-volume live
  probe; if you need it, use a dedicated low-rate trace.
- Ports/privileges: the collector needs `sudo -n`; if that is removed, it writes
  degraded sidecars instead of failing noisily.
