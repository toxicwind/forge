/**
 * forge-nl-lib — shared NativeLink (REAPI) remote-cache wrapper.
 *
 * Every build script in the estate should route through here so builds hit the
 * NativeLink cache plane (grpc :25155, http :25157) by default. Falls back to
 * a plain local invocation when the cache plane is offline — never blocks a build.
 *
 * Usage (bun):
 *   import { nlEnv, nlStatus, runWithCache } from "forge-nl-lib";
 *
 *   const status = await nlStatus();
 *   // bazel:
 *   await runWithCache("bazel", ["build", "//..."]);
 *   // cargo (sccache-style via REAPI is bazel-only today; cargo gets cache env):
 *   await runWithCache("cargo", ["build"], { tool: "cargo" });
 */

import { spawn } from "node:child_process";

export const NATIVELINK_GRPC = process.env.FORGE_REMOTE_CACHE ?? "grpc://127.0.0.1:25155";
export const NATIVELINK_HTTP = process.env.FORGE_REMOTE_HTTP ?? "http://127.0.0.1:25157";

export type NlStatus = {
  grpc: string;
  http: string;
  httpUp: boolean;
  grpcUp: boolean;
};

async function probeTcp(port: number, timeoutMs = 750): Promise<boolean> {
  try {
    const conn = Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    const timer = setTimeout(() => { try { conn.end(); } catch {} }, timeoutMs);
    const ok = await Promise.race([
      conn.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    clearTimeout(timer);
    try { conn.end(); } catch { /* already closed */ }
    return ok;
  } catch {
    return false;
  }
}

export async function nlStatus(): Promise<NlStatus> {
  const [httpUp, grpcUp] = await Promise.all([
    fetch(`${NATIVELINK_HTTP}/status`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false),
    probeTcp(25155),
  ]);
  return { grpc: NATIVELINK_GRPC, http: NATIVELINK_HTTP, httpUp, grpcUp };
}

/** Env vars that point each toolchain at the NativeLink cache. */
export type NlTool = "bazel" | "cargo" | "bun" | "python" | "go" | "bash" | "perl";

export function nlEnv(tool: NlTool = "bazel"): Record<string, string> {
  const base: Record<string, string> = {
    FORGE_REMOTE_CACHE: NATIVELINK_GRPC,
    FORGE_REMOTE_HTTP: NATIVELINK_HTTP,
  };
  switch (tool) {
    case "bazel":
      return {
        ...base,
        BAZEL_REMOTE_CACHE: NATIVELINK_GRPC,
      };
    case "cargo":
      // cargo builds go through bazel/toolchain wrappers; expose standard vars.
      return {
        ...base,
        CARGO_TARGET_DIR: "/home/toxic/var/runtime/nativelink/work/cargo-target",
      };
    case "bun":
      return base;
    case "python":
      return { ...base, FORGE_PY_CACHE_DIR: "/home/toxic/var/runtime/nativelink/work/py-cache" };
    case "go":
      return { ...base, GOCACHE: "/home/toxic/var/runtime/nativelink/work/go-cache", GOFLAGS: [process.env.GOFLAGS, "-mod=mod"].filter(Boolean).join(" ") };
    case "bash":
      return base;
    case "perl":
      return { ...base, PERL5LIB: "/home/toxic/var/runtime/nativelink/work/perl-lib" };
  }
}

/** Language servers per toolchain, for LSP wiring (tau/kappa tool shells). */
export const NL_LANGUAGE_SERVERS: Record<string, string> = {
  typescript: "tsserver", // tsgo banned: microsoft/typescript-go#2239 memory leak
  rust: "rust-analyzer",
  python: "pyright",
  go: "gopls",
  bash: "bash-language-server",
  perl: "perl-language-server",
};

export function nlLanguageServer(lang: string): string | undefined {
  return NL_LANGUAGE_SERVERS[lang];
}

export type RunResult = { ok: boolean; code: number | null; cached: boolean };

/**
 * Run a build command with NativeLink cache routing. bazel gets
 * --remote_cache injected (unless already present); other tools get the
 * cache env vars. If the cache plane is offline, runs locally — never fails
 * the build because of the cache.
 */
export async function runWithCache(
  bin: string,
  args: string[],
  opts: { tool?: NlTool; cwd?: string } = {},
): Promise<RunResult> {
  const status = await nlStatus();
  const tool = opts.tool ?? (bin === "bazel" ? "bazel" : "cargo");
  let finalArgs = args;
  let env = { ...process.env, ...nlEnv(tool) };
  let cached = false;

  if (status.grpcUp && tool === "bazel" && !args.some((a) => a.startsWith("--remote_cache"))) {
    finalArgs = [...args, `--remote_cache=${NATIVELINK_GRPC}`];
    cached = true;
  } else if (status.grpcUp) {
    cached = true;
  } else if (tool === "go") {
    // GOCACHE to local fallback dir so go builds never block on cache offline.
    env = { ...env, GOCACHE: env.GOCACHE ?? "/home/toxic/.cache/go-build" };
  } else {
    console.warn(`[forge-nl-lib] NativeLink offline at ${NATIVELINK_GRPC} — building locally`);
  }

  const proc = spawn(bin, finalArgs, {
    cwd: opts.cwd,
    env,
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
  return { ok: code === 0, code, cached };
}
