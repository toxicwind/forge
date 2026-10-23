#!/usr/bin/env python3
"""mcp-sight MCP server — kernel-sourced "what is happening right now".

Unprivileged reader. Reads the bounded ring buffers + sidecars written by the
mcp-sight collector (collector.py, which runs bpftrace under elevation).
Exposes mcp_sight_* tools that answer live kernel-observed questions.

Fail-soft: if a probe ring is stale or bpftrace is down, the tool reports the
degradation and the last known pitchfork-poll health rather than silently
returning empty ("unreliable narrator" guard).

Register in kappa.json:
  {"mcp": {"mcp_sight": {"type": "local",
          "command": ["python3", ".../sight/mcp_sight.py"]}}}
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(
    os.environ.get(
        "MCP_SIGHT_STATE",
        Path.home() / ".fleet-bus/var/openfang-health/sight",
    )
)
STALE_MS = 10_000  # a ring not updated in 10s is considered stale/degraded
PITCHFORK_POLL = Path.home() / ".fleet-bus/var/openfang-health/openfang-health.json"

TOOLSPECS = {
    "exec": {
        "name": "mcp_sight_exec",
        "description": "Kernel-attested exec events: every execve/execveat on the box "
        "(pid, comm, exe, argv0). Bounded ring; includes drop counters. "
        "Cross-check a pid against ps/ss for the same instant.",
        "default_limit": 20,
    },
    "syscall": {
        "name": "mcp_sight_syscall",
        "description": "Kernel-observed ptrace syscalls (request, target pid). "
        "Bounded ring; includes drop counters.",
        "default_limit": 20,
    },
    "fs": {
        "name": "mcp_sight_fs",
        "description": "Kernel-observed opens/writes into sensitive config/credential "
        "paths (flagged by an allowlist). Bounded ring with drop counters.",
        "default_limit": 20,
    },
    "net": {
        "name": "mcp_sight_net",
        "description": "Kernel-observed outbound TCP connects per pid (ipver, dest, "
        "port), correlated to the pitchfork daemon map where pid matches. "
        "Bounded ring with drop counters.",
        "default_limit": 20,
    },
}

_DAEMON_PID_MAP = None
_DAEMON_MAP_AT = 0.0


def _daemon_map():
    """pid -> daemon-name map from the pitchfork supervisor state.toml, cached ~15s."""
    global _DAEMON_PID_MAP, _DAEMON_MAP_AT
    now = time.time()
    if _DAEMON_PID_MAP is not None and now - _DAEMON_MAP_AT < 15:
        return _DAEMON_PID_MAP
    m = {}
    st = Path.home() / ".local/state/pitchfork/state.toml"
    try:
        cur = None
        for ln in st.read_text().splitlines():
            ln = ln.strip()
            if ln.startswith("[daemons."):
                # [daemons."estate/name"] -> estate/name
                cur = ln[len('[daemons."') :].rstrip('"]')
                continue
            if cur is not None and ln.startswith("pid") and "=" in ln:
                val = ln.split("=", 1)[1].strip().strip('"')
                if val.isdigit():
                    m[val] = cur
    except Exception:
        pass
    _DAEMON_PID_MAP = m
    _DAEMON_MAP_AT = now
    return m


def _is_ok(meta):
    return meta.get("bpftrace_ok") is True and meta.get("error") is None


def _age_ms(meta):
    try:
        upd = datetime.fromisoformat(meta["updated"].replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - upd).total_seconds() * 1000
    except Exception:
        return 10**9


def _read_ring(name):
    """Return (events:list, meta:dict). Empty events if ring file missing."""
    evs = []
    jl = STATE_DIR / f"{name}.jsonl"
    meta_path = STATE_DIR / f"{name}.meta.json"
    meta = {"bpftrace_ok": False, "error": "missing sidecar", "counts": {}}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except Exception:
            pass
    if jl.exists():
        for ln in jl.read_text().splitlines():
            try:
                evs.append(json.loads(ln))
            except Exception:
                continue
    return evs, meta


def _fallback_poll():
    if PITCHFORK_POLL.exists():
        try:
            return json.loads(PITCHFORK_POLL.read_text())
        except Exception:
            return {"error": "unreadable poll output"}
    return None


def _status_block(meta, events, daemon_map=None):
    """Build the shared degraded/sight status + drop-counter header."""
    ok = _is_ok(meta)
    stale = _age_ms(meta) > STALE_MS
    counts = meta.get("counts", {})
    lines = []
    if ok and not stale:
        lines.append("sight: live")
    elif ok and stale:
        lines.append(
            "sight: STALE (ring not updated in %.0fs)" % (_age_ms(meta) / 1000)
        )
    else:
        lines.append(
            "sight: DEGRADED (bpftrace down: %s)" % (meta.get("error") or "unknown")
        )
    lines.append(
        "counts: seen=%s kept=%s drop_filter=%s drop_ring=%s ring=%s"
        % (
            counts.get("seen", 0),
            counts.get("kept", 0),
            counts.get("dropped_filter", 0),
            counts.get("dropped_ring", 0),
            len(events),
        )
    )
    if not ok or stale:
        fb = _fallback_poll()
        if fb is not None:
            lines.append(
                "fallback(pitchfork poll): overall=%s checks=%s"
                % (fb.get("overall", "?"), len(fb.get("checks", [])))
            )
    if daemon_map is not None:
        lines.append("daemons_resolved=%d" % len(daemon_map))
    return "\n".join(lines)


def _correlate_daemon(events):
    dm = _daemon_map()
    out = []
    for ev in events:
        e = dict(ev)
        pid = str(e.get("pid", ""))
        e["daemon"] = dm.get(pid)
        out.append(e)
    return out, dm


def _tool_reply(name, args):
    limit = int(args.get("limit", TOOLSPECS[name]["default_limit"]))
    limit = max(1, min(limit, 200))  # bounded output
    events, meta = _read_ring(name)
    # newest-first by file order is time order; take the tail, reverse for newest-first
    evs = events[-limit:][::-1]

    if name == "net":
        evs, dm = _correlate_daemon(evs)
        head = _status_block(meta, events, dm)
    else:
        head = _status_block(meta, events)

    if not evs and (not _is_ok(meta) or _age_ms(meta) > STALE_MS):
        body = "No events captured and the ring is not healthy — see status below."
    elif not evs:
        body = "No events captured in the current window (nothing matched / no such syscall)."
    else:
        body = json.dumps(evs, indent=2)

    return {"content": [{"type": "text", "text": head + "\n" + body}]}


_TOOL_HANDLERS = {spec["name"]: n for n, spec in TOOLSPECS.items()}


def build_tools_list():
    tools = []
    for _, spec in TOOLSPECS.items():
        tools.append(
            {
                "name": spec["name"],
                "description": spec["description"],
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "limit": {
                            "type": "integer",
                            "description": "max events to return (1-200, default %d)"
                            % spec["default_limit"],
                        }
                    },
                },
            }
        )
    return tools


def _reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method", "")
        msg_id = req.get("id")
        if method == "initialize":
            _reply(
                msg_id,
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "mcp_sight", "version": "1.0.0"},
                },
            )
        elif method.startswith("notifications/"):
            continue
        elif method == "tools/list":
            _reply(msg_id, {"tools": build_tools_list()})
        elif method == "tools/call":
            name = (req.get("params") or {}).get("name", "")
            args = (req.get("params") or {}).get("arguments") or {}
            bucket = _TOOL_HANDLERS.get(name)
            if bucket is None:
                _reply(
                    msg_id, error={"code": -32602, "message": f"unknown tool {name}"}
                )
                continue
            try:
                _reply(msg_id, _tool_reply(bucket, args))
            except Exception as e:  # noqa: BLE001
                _reply(
                    msg_id,
                    {
                        "content": [{"type": "text", "text": f"error: {e}"}],
                        "isError": True,
                    },
                )
        elif msg_id is not None:
            _reply(
                msg_id, error={"code": -32601, "message": f"unknown method {method}"}
            )


if __name__ == "__main__":
    main()
