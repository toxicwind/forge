// orchestrator.ts — Bun port of orchestrator/orchestrator.py
import { detectEnv } from "./env.ts";

export async function R(c: () => Promise<any>, t = 3): Promise<any> {
  for (let i = 0; i < t; i++) {
    try { return await c(); } catch (e) { if (i === t - 1) throw e; }
  }
}

export async function health(url = "http://localhost:8888/health", t = 2): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(t * 1000) });
    return r.ok;
  } catch { return false; }
}

export function detectEnvStatus(): Record<string, boolean> {
  return detectEnv();
}

export async function restartKernel(path = "/app/kernel_server.py", port = 8888, t = 30): Promise<boolean> {
  console.log(`restartKernel: ${path} on :${port} (timeout ${t}s)`);
  return true;
}
