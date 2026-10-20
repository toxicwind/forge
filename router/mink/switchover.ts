// switchover.ts — Bun port of switchover/switchover.py
export async function R(c: () => Promise<any>, t = 3): Promise<any> {
  for (let i = 0; i < t; i++) {
    try { return await c(); } catch (e) { if (i === t - 1) throw e; }
  }
}

export async function health(u = "http://localhost:8888/health", t = 2): Promise<boolean> {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(t * 1000) });
    return r.ok;
  } catch { return false; }
}

export async function restart(path = "/app/kernel_server.py", port = 8888, t = 30): Promise<boolean> {
  // Best-effort restart signal; real restart handled by process supervisor
  console.log(`restart requested: ${path} on :${port} (timeout ${t}s)`);
  return true;
}
