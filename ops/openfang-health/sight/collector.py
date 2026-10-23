#!/usr/bin/env python3
"""mcp-sight collector — runs the mcp_sight bpftrace probes persistently and
writes bounded, ring-buffered JSONL to a state dir, plus a drop-counter and
health sidecar. Read-only observation: attaches bpftrace probes only; never
blocks, throttles, or intercepts syscalls.

Privilege: bpftrace needs elevation on this box (kernel.unprivileged_bpf_disabled=2,
perf_event_paranoid=2, tracefs not world-readable). This collector is launched as
root (see launch-collector.sh / the systemd unit) or via --sudo (capsh). The MCP
reader (mcp_sight.py) runs unprivileged and only reads the state dir.

Fail-soft: on any probe error or missing bpftrace it writes a degraded health
sidecar and falls back to the existing pitchfork poll data rather than silently
reporting "nothing is happening".
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

PROBE_DIR = Path(__file__).resolve().parent / "probes"

# Sensitive-path prefixes for the fs probe. A write/open touching any of these
# is judged "worth recording". Tight on purpose: the ring is small, so only
# genuine config/credential/secret surfaces make the cut. Everything else is
# dropped to keep the ring and the reported output bounded.
SENSITIVE_PREFIXES = [
    "/home/toxic/.config/kappa/auth.json",
    "/home/toxic/.config/tau/auth.json",
    "/home/toxic/.config/kappa/kappa.json",
    "/home/toxic/.secrets",
    "/home/toxic/.aws",
    "/home/toxic/.ssh",
    "/home/toxic/.gnupg",
    "/run/secrets",
    "/etc/environment",
    "/home/toxic/estate/config/keypools.yaml",
    "/home/toxic/estate/config/tau/models.yml",
    "/home/toxic/estate/config/herd.yaml",
    "/home/toxic/estate/delendai.config.json",
    "/home/toxic/.local/share/kappa/",
    "/home/toxic/.kube",
    "/home/toxic/.config/gcloud",
    "/var/lib/mcp-sight",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _bswap16(v: int) -> int:
    return ((v >> 8) | ((v & 0xFF) << 8)) & 0xFFFF


# probe name -> {bt file, parse fn -> dict|None (None = drop/filter)}
def _parse_exec(f):
    # EXEC|ts|pid|tid|uid|comm|exe|argv0
    return (
        {
            "ts": f[1],
            "pid": int(f[2]),
            "tid": int(f[3]),
            "uid": int(f[4]),
            "comm": f[5],
            "exe": f[6],
            "argv0": f[7] if len(f) > 7 else "",
        }
        if len(f) >= 7 and f[0] == "EXEC"
        else None
    )


def _parse_syscall(f):
    # P|ts|pid|comm|request|target_pid
    return (
        {
            "ts": f[1],
            "pid": int(f[2]),
            "comm": f[3],
            "op": "ptrace",
            "request": int(f[4]),
            "target_pid": int(f[5]),
        }
        if len(f) >= 6 and f[0] == "P"
        else None
    )


def _parse_fs(f):
    # FS|ts|pid|comm|dfd|flags|filename
    return (
        {
            "ts": f[1],
            "pid": int(f[2]),
            "comm": f[3],
            "dfd": int(f[4]),
            "flags": int(f[5]),
            "filename": f[6] if len(f) > 6 else "",
        }
        if len(f) >= 6 and f[0] == "FS"
        else None
    )


def _parse_net(f):
    # NET|ts|pid|comm|ipver|dest|port
    base = {
        "ts": f[1],
        "pid": int(f[2]),
        "comm": f[3],
        "ipver": f[4],
        "dest": f[5],
        "port": _bswap16(int(f[6])) if len(f) > 6 else 0,
    }
    return base if len(f) >= 6 and f[0] == "NET" else None


# One combined bpftrace program emits TAG-prefixed lines; a router picks the
# bucket + parser. Tag -> (probe bucket, parser, sensitive?).
TAG_ROUTE = {
    "EXEC": ("exec", _parse_exec, False),
    "P": ("syscall", _parse_syscall, False),
    "FS": ("fs", _parse_fs, True),
    "NET": ("net", _parse_net, False),
}

PROBES = {
    "exec": {"bt": "sight.bt", "parse": _parse_exec, "sensitive": False},
    "syscall": {"bt": "sight.bt", "parse": _parse_syscall, "sensitive": False},
    "fs": {"bt": "sight.bt", "parse": _parse_fs, "sensitive": True},
    "net": {"bt": "sight.bt", "parse": _parse_net, "sensitive": False},
}


class RingStore:
    def __init__(self, state_dir: Path, capacity: int):
        self.state_dir = state_dir
        self.capacity = capacity
        self.events: dict[str, deque] = {}
        self.stats: dict[str, dict] = {}
        self._log_cursor: dict[str, int] = {}
        self.state_dir.mkdir(parents=True, exist_ok=True)
        for name in PROBES:
            self.events[name] = deque(maxlen=capacity)
            self._log_cursor[name] = 0
            self.stats[name] = {
                "seen": 0,
                "kept": 0,
                "dropped_filter": 0,
                "dropped_ring": 0,
                "first_ts": None,
                "last_ts": None,
                "pid": None,
                "bpftrace_ok": False,
                "error": None,
            }

    def apply(self, name: str, ev):
        st = self.stats[name]
        st["seen"] += 1
        if ev is None:
            st["dropped_filter"] += 1
            return
        if ev.get("filename") is not None and name == "fs" and ev["filename"]:
            if not any(ev["filename"].startswith(p) for p in SENSITIVE_PREFIXES):
                st["dropped_filter"] += 1
                return
        q = self.events[name]
        if len(q) == self.capacity:
            st["dropped_ring"] += 1
        q.append(ev)
        st["kept"] += 1
        if st["first_ts"] is None:
            st["first_ts"] = ev["ts"]
        st["last_ts"] = ev["ts"]

    def mark_ok(self, name: str, pid: int):
        self.stats[name]["bpftrace_ok"] = True
        self.stats[name]["pid"] = pid
        self.stats[name]["error"] = None

    def mark_err(self, name: str, err: str):
        self.stats[name]["bpftrace_ok"] = False
        self.stats[name]["error"] = str(err)[:300]

    def flush(self):
        for name, q in self.events.items():
            path = self.state_dir / f"{name}.jsonl"
            tmp = path.with_suffix(".tmp")
            with open(tmp, "w") as fh:
                for ev in q:
                    fh.write(json.dumps(ev) + "\n")
            os.replace(tmp, path)  # atomic

            st = self.stats[name]
            # Append newly-kept events to the queryable daily log (post-hoc).
            self._append_daily_log(name, q, st)

            meta = {
                "probe": name,
                "updated": _now_iso(),
                "capacity": self.capacity,
                "bpftrace_ok": st["bpftrace_ok"],
                "pid": st["pid"],
                "error": st["error"],
                "counts": {
                    "seen": st["seen"],
                    "kept": st["kept"],
                    "dropped_filter": st["dropped_filter"],
                    "dropped_ring": st["dropped_ring"],
                    "ring_current": len(q),
                },
                "window": {"first": st["first_ts"], "last": st["last_ts"]},
            }
            (self.state_dir / f"{name}.meta.json").write_text(
                json.dumps(meta, indent=2)
            )

    def _append_daily_log(self, name: str, q, st):
        """Append newly-kept events to a bounded daily log for post-hoc search.
        Uses a high-water mark on st['kept'] so each event is logged once; the
        daily file is capped to keep the searchable surface bounded."""
        delta = st["kept"] - self._log_cursor[name]
        if delta <= 0:
            return
        newest = list(q)[-delta:] if delta <= len(q) else list(q)
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        log = self.state_dir / f"sight-{day}.jsonl"
        self._log_cursor[name] = st["kept"]
        if not log.exists():
            log.touch()
        size = len(log.read_text())
        with open(log, "a") as fh:
            for ev in newest:
                rec = {"probe": name, **ev}
                fh.write(json.dumps(rec) + "\n")
                size += len(json.dumps(rec)) + 1
            # bounded: keep the daily log under ~16MB; if exceeded, truncate
            # to the tail (drop oldest) so post-hoc search stays cheap.
            if size > 16 * 1024 * 1024:
                lines = log.read_text().splitlines()
                log.write_text("\n".join(lines[-(len(lines) // 2) :]) + "\n")


def _make_bpftrace_cmd(bt_path: str, sudo: bool) -> list[str]:
    # Run bpftrace as root via passwordless sudo. capsh's --caps + -c argv
    # handling is fragile here (hangs / mis-parses when stdin is a pipe), and
    # root bpftrace is the proven, minimal-surprise path: kernel
    # unprivileged_bpf_disabled=2 / perf_event_paranoid=2 make elevation
    # unavoidable for tracepoint attach. bpftrace itself never blocks syscalls.
    if sudo:
        return ["sudo", "-n", "/usr/bin/bpftrace", bt_path]
    return ["/usr/bin/bpftrace", bt_path]


def run_probe_stderr_cleanup(proc, ring, name):
    """Keep a bounded stderr buffer and mark errors on output."""
    # stderr is read via a small background thread so the pipe never fills.
    buf = []
    lock = threading.Lock()

    def _reader():
        assert proc.stderr is not None
        for line in proc.stderr:
            with lock:
                buf.append(line)
                if len(buf) > 8:
                    buf.pop(0)

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    return buf, lock


def run_combined(state_dir: Path, capacity: int, sudo: bool) -> int:
    """Run the single combined bpftrace program (sight.bt), route each tagged
    stdout line to its probe ring, and flush the rings on a timer. A SIGTERM
    triggers a final flush. Never returns on its own (parent terminates it)."""
    ring = RingStore(state_dir, capacity)
    bt_path = str(PROBE_DIR / "sight.bt")
    cmd = _make_bpftrace_cmd(bt_path, sudo)
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    for n in PROBES:
        ring.mark_ok(n, proc.pid)
    buf, lock = run_probe_stderr_cleanup(proc, ring, "combined")
    assert proc.stdout is not None

    def _consume():
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if not line:
                continue
            low = line.lower()
            if low.startswith("attached") or low.startswith("warning"):
                continue
            if low.startswith("error") or low.startswith("stdin:"):
                with lock:
                    for n in PROBES:
                        ring.mark_err(n, line)
                continue
            parts = line.split("|")
            tag = parts[0]
            route = TAG_ROUTE.get(tag)
            if route is None:
                continue
            bucket, parse, _sensitive = route
            try:
                ev = parse(parts)
            except (ValueError, IndexError):
                continue
            ring.apply(bucket, ev)

    reader = threading.Thread(target=_consume, daemon=True)
    reader.start()

    stop = threading.Event()

    def _flush_loop():
        while not stop.wait(2.0):
            ring.flush()

    flusher = threading.Thread(target=_flush_loop, daemon=True)
    flusher.start()

    def _on_term(signum, frame):
        stop.set()
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()
        with lock:
            errs = "".join(buf).strip()
        if proc.returncode not in (None, 0, -signal.SIGTERM, -signal.SIGINT):
            for n in PROBES:
                ring.mark_err(n, errs or f"bpftrace exit {proc.returncode}")
        ring.flush()
        os._exit(0)

    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    reader.join()
    with lock:
        errs = "".join(buf).strip()
    if proc.returncode not in (None, 0, -signal.SIGTERM, -signal.SIGINT):
        for n in PROBES:
            ring.mark_err(n, errs or f"bpftrace exit {proc.returncode}")
    ring.flush()
    try:
        stop.wait(3600)
    except KeyboardInterrupt:
        pass
    return 0


def gen_fallback_sidecars(state_dir: Path):
    """Write a degraded sight state when bpftrace cannot run at all."""
    state_dir.mkdir(parents=True, exist_ok=True)
    poll_path = Path.home() / ".fleet-bus/var/openfang-health/openfang-health.json"
    fallback = {
        "note": "bpftrace unavailable; degraded to pitchfork poll",
        "poll": None,
    }
    if poll_path.exists():
        try:
            fallback["poll"] = json.loads(poll_path.read_text())
        except Exception:
            fallback["poll"] = {"error": "unreadable poll output"}
    for name in PROBES:
        meta = {
            "probe": name,
            "updated": _now_iso(),
            "bpftrace_ok": False,
            "error": "degraded: bpftrace unavailable to this collector",
            "counts": {
                "seen": 0,
                "kept": 0,
                "dropped_filter": 0,
                "dropped_ring": 0,
                "ring_current": len(
                    (state_dir / f"{name}.jsonl").read_text().splitlines()
                )
                if (state_dir / f"{name}.jsonl").exists()
                else 0,
            },
            "fallback": fallback,
        }
        (state_dir / f"{name}.meta.json").write_text(json.dumps(meta, indent=2))
        if not (state_dir / f"{name}.jsonl").exists():
            (state_dir / f"{name}.jsonl").write_text("")


def main() -> int:
    ap = argparse.ArgumentParser(description="mcp-sight collector")
    ap.add_argument(
        "--state-dir",
        default=os.path.expanduser("~/.fleet-bus/var/openfang-health/sight"),
    )
    ap.add_argument("--capacity", type=int, default=256)
    ap.add_argument("--sudo", action="store_true", help="run bpftrace via sudo")
    args = ap.parse_args()

    state = Path(args.state_dir)

    # If bpftrace is missing entirely, degrade now rather than spin.
    if not shutil.which("bpftrace"):
        gen_fallback_sidecars(state)
        print("mcp-sight: bpftrace not found; wrote degraded sidecars", file=sys.stderr)
        return 0

    # Single combined program: all probe categories in one bpftrace instance.
    return run_combined(state, args.capacity, args.sudo)


if __name__ == "__main__":
    sys.exit(main())
