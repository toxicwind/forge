#!/usr/bin/env python3
"""toolchain-drift-guard: fail fast when a Dockerfile's Go toolchain pin
lags the maximum `go` directive required to build what the image builds.

Scans:
  * every Dockerfile in the repo (Dockerfile*, *.Dockerfile, *.Containerfile)
    for `FROM golang:<tag>` pins (including ARG-indirected tags), and
  * the maximum `go` directive across ALL go.mod files in the repo tree,
    including vendored deps and submodule checkouts, and
  * the upstream herd go.mod that docker/unified/install-vllm-wrapper.sh
    fetches at image build time (the exact failure class that broke
    vulkan/assemble + cuda/assemble: golang:1.26 vs herd v255
    requiring Go >= 1.27.1).

Usage:
  scripts/toolchain-drift-guard.py [--root DIR] [--ls-version V] [--no-upstream]

  --ls-version mirrors the Docker build arg LS_VERSION consumed by
  docker/unified/install-vllm-wrapper.sh (default: "main", matching
  .github/workflows/unified-docker.yml's default input).

Exit 0: every Go pin satisfies the requirement.
Exit 1: drift detected (with the exact bump needed), or the upstream
        requirement could not be resolved (fail-closed: the image build
        itself needs that same network access to succeed).

Install as a pre-push hook:
  cp scripts/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push
"""

import argparse
import os
import re
import sys
import urllib.request

UPSTREAM_REPO = "mostlygeek/herd"
DEFAULT_VARIANT = "-bookworm"  # repo convention for Go builder images

FROM_RE = re.compile(
    r"^\s*FROM\s+(?:--[\w-]+=\S+\s+)*golang:([^\s]+)", re.IGNORECASE
)
ARG_RE = re.compile(r"^\s*ARG\s+([A-Za-z_][\w]*)(?:[=\s]+([^\s#]+))?")
GO_DIRECTIVE_RE = re.compile(r"^\s*go\s+(\d+(?:\.\d+){1,2})\s*$")
VERSION_RE = re.compile(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def parse_version(text):
    """Parse leading numeric version; return (maj, min, patch|None, rest)."""
    m = VERSION_RE.match(text.strip())
    if not m:
        return None
    maj = int(m.group(1))
    minor = int(m.group(2)) if m.group(2) is not None else 0
    patch = int(m.group(3)) if m.group(3) is not None else None
    rest = text.strip()[m.end():]
    return (maj, minor, patch, rest)


def split_tag_variant(tag):
    """golang:1.27-bookworm -> ((1,27,None), '-bookworm')."""
    v = parse_version(tag)
    if v is None:
        return None, None
    return (v[0], v[1], v[2]), (v[3] or "")


def version_str(v):
    s = "%d.%d" % (v[0], v[1])
    if v[2] is not None:
        s += ".%d" % v[2]
    return s


def pin_satisfies(pin, req):
    """pin/req are (maj, min, patch|None). Pin needs >= req at minor
    granularity (docker golang tags are major.minor); an explicit pin
    patch must also cover the required patch."""
    if (pin[0], pin[1]) != (req[0], req[1]):
        return (pin[0], pin[1]) > (req[0], req[1])
    if pin[2] is not None and req[2] is not None:
        return pin[2] >= req[2]
    return True


def find_files(root, name_pred):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        # never descend into git metadata
        dirnames[:] = [d for d in dirnames if d != ".git"]
        if "/.git/" in dirpath.replace(os.sep, "/"):
            continue
        for f in filenames:
            if name_pred(f):
                hits.append(os.path.join(dirpath, f))
    return sorted(hits)


def is_dockerfile(name):
    n = name.lower()
    return (
        n == "dockerfile"
        or n.startswith("dockerfile.")
        or n.endswith(".dockerfile")
        or n.endswith(".containerfile")
    )


def resolve_arg_refs(tag, args):
    def sub(m):
        return args.get(m.group(1) or m.group(2), m.group(0))

    return re.sub(r"\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)", sub, tag)


def scan_dockerfile(path):
    """Return list of (line_no, raw_tag) golang pins in a Dockerfile."""
    pins = []
    args = {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for i, line in enumerate(fh, 1):
            am = ARG_RE.match(line)
            if am and am.group(2):
                args[am.group(1)] = am.group(2).strip("'\"")
            fm = FROM_RE.match(line)
            if fm:
                pins.append((i, resolve_arg_refs(fm.group(1), args)))
    return pins


def go_directive_of(gomod_path):
    with open(gomod_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = GO_DIRECTIVE_RE.match(line)
            if m:
                return m.group(1)
    return None


def fetch_url(url, timeout=20):
    req = urllib.request.Request(
        url, headers={"User-Agent": "toolchain-drift-guard/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def resolve_upstream_ref(ls_version):
    """Mirror docker/unified/install-vllm-wrapper.sh ref resolution."""
    v = ls_version.strip()
    if re.fullmatch(r"[0-9a-f]{40}", v):
        # full commit hash: prefer the release tag pointing at it
        try:
            import subprocess

            out = subprocess.run(
                ["git", "ls-remote", "--tags",
                 "https://github.com/%s.git" % UPSTREAM_REPO],
                capture_output=True, text=True, timeout=30,
            ).stdout
            for line in out.splitlines():
                sha, ref = line.split("\t", 1)
                if sha == v and ref.startswith("refs/tags/") \
                        and not ref.endswith("^{}"):
                    return ref[len("refs/tags/"):]
        except Exception:
            pass
        return v  # raw.githubusercontent.com serves commit SHAs directly
    if v == "latest":
        data = fetch_url(
            "https://api.github.com/repos/%s/releases/latest" % UPSTREAM_REPO
        )
        m = re.search(r'"tag_name"\s*:\s*"([^"]+)"', data)
        if not m:
            raise RuntimeError("could not resolve latest release tag")
        return m.group(1)
    if re.fullmatch(r"v?\d+", v):
        return "v" + v.lstrip("v")
    return v  # branch name, e.g. "main"


def upstream_go_requirement(ls_version):
    ref = resolve_upstream_ref(ls_version)
    body = fetch_url(
        "https://raw.githubusercontent.com/%s/%s/go.mod" % (UPSTREAM_REPO, ref)
    )
    for line in body.splitlines():
        m = GO_DIRECTIVE_RE.match(line)
        if m:
            return m.group(1), "upstream %s@%s/go.mod" % (UPSTREAM_REPO, ref)
    raise RuntimeError("no `go` directive in upstream go.mod @ %s" % ref)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".",
                    help="repo root to scan (default: cwd)")
    ap.add_argument("--ls-version", default="main",
                    help="LS_VERSION build arg (default: main)")
    ap.add_argument("--no-upstream", action="store_true",
                    help="skip the upstream herd go.mod check")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    failures = []

    # 1. requirements: every local go.mod + (optionally) upstream
    requirements = []  # (version_tuple, source_label)
    for gomod in find_files(root, lambda n: n == "go.mod"):
        directive = go_directive_of(gomod)
        if directive:
            v = parse_version(directive)
            rel = os.path.relpath(gomod, root)
            requirements.append(((v[0], v[1], v[2]), directive, rel))
    if not args.no_upstream:
        try:
            directive, source = upstream_go_requirement(args.ls_version)
            v = parse_version(directive)
            requirements.append(((v[0], v[1], v[2]), directive, source))
        except Exception as e:
            print("ERROR: could not resolve upstream Go requirement: %s" % e)
            print("Failing closed: the image build needs this same "
                  "resolution to succeed.")
            return 1
    if not requirements:
        print("ERROR: no `go` directives found anywhere; refusing to pass "
              "blind.")
        return 1
    req_ver, req_directive, req_source = max(
        requirements, key=lambda r: (r[0][0], r[0][1], r[0][2] or 0)
    )

    # 2. pins: every Dockerfile's golang base
    dockerfiles = find_files(root, is_dockerfile)
    checked = 0
    for df in dockerfiles:
        rel = os.path.relpath(df, root)
        for line_no, tag in scan_dockerfile(df):
            pin, variant = split_tag_variant(tag)
            if pin is None:
                print("note: %s:%d: unparseable golang tag %r, "
                      "skipping" % (rel, line_no, tag))
                continue
            checked += 1
            if not pin_satisfies(pin, req_ver):
                bump_variant = variant if variant else DEFAULT_VARIANT
                bump = "golang:%d.%d%s" % (
                    req_ver[0], req_ver[1], bump_variant)
                failures.append(
                    "%s:%d: golang:%s < required %s (from %s); "
                    "bump to %s" % (
                        rel, line_no, tag, version_str(req_ver),
                        req_source, bump))

    # 3. verdict
    print("toolchain-drift-guard: requirement go %s (from %s)" % (
        version_str(req_ver), req_source))
    print("  Dockerfiles scanned: %d, golang pins checked: %d" % (
        len(dockerfiles), checked))
    if failures:
        print("DRIFT DETECTED:")
        for f in failures:
            print("  " + f)
        return 1
    print("OK: all Go toolchain pins satisfy the requirement.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
