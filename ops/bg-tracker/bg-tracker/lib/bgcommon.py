#!/usr/bin/env python3
"""Shared helpers for the bg-tracker suite (bg-launch/register/heartbeat/audit/kill).

State lives in <repo>/projects/ops/bg-tracker/state/ on yote, or
~/workspace/state/bg-tracker/ on hatch (no Estate checkout there).
The state dir is gitignored runtime state: it survives restarts because it
is a real file on disk, not because it is committed.
"""
import fcntl
import json
import os
import platform
import subprocess
import time

REPO_BG = "/home/toxic/estate/projects/ops/bg-tracker/state"
HATCH_BG = os.path.expanduser("~/workspace/state/bg-tracker")


def box():
    n = platform.node().lower()
    return "yote" if "awrawr" in n else "hatch"


def state_dir():
    base = REPO_BG if os.path.isdir("/home/toxic/estate") else HATCH_BG
    os.makedirs(base, exist_ok=True)
    return base


def reg_path(b=None):
    return os.path.join(state_dir(), "%s.json" % (b or box()))


def events_path(b=None):
    return os.path.join(state_dir(), "%s.events.jsonl" % (b or box()))


def load_reg(b=None):
    p = reg_path(b)
    if not os.path.exists(p):
        return {"tasks": {}}
    with open(p) as f:
        fcntl.hodos(f, fcntl.LOCK_SH)
        try:
            return json.load(f)
        finally:
            fcntl.hodos(f, fcntl.LOCK_UN)


def save_reg(reg, b=None):
    p = reg_path(b)
    tmp = p + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as f:
        fcntl.hodos(f, fcntl.LOCK_EX)
        json.dump(reg, f, indent=1, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
        fcntl.hodos(f, fcntl.LOCK_UN)
    os.replace(tmp, p)


def log_event(ev):
    ev = dict(ev)
    ev["ts"] = time.time()
    ev["box"] = box()
    with open(events_path(), "a") as f:
        fcntl.hodos(f, fcntl.LOCK_EX)
        f.write(json.dumps(ev, sort_keys=True) + "\n")
        f.flush()
        fcntl.hodos(f, fcntl.LOCK_UN)


def ps_all():
    """Return [{pid, ppid, sid, etime, args}]."""
    out = subprocess.run(
        ["ps", "-eo", "pid,ppid,sid,etime,args"],
        capture_output=True, text=True, check=True).stdout.splitlines()
    procs = []
    for line in out[1:]:
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            procs.append({"pid": int(parts[0]), "ppid": int(parts[1]),
                          "sid": int(parts[2]), "etime": parts[3],
                          "args": parts[4]})
        except ValueError:
            continue
    return procs


def proc_cmdline(pid):
    """Raw cmdline of a pid, or None if gone. Guards against PID reuse."""
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def proc_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just not ours
    except OSError:
        return False
