// env_dump.ts — Bun port of env_dump/env_dump.py
import { detectEnv, diffEnv } from "./env.ts";

export function dump(): Record<string, boolean> {
  return detectEnv();
}

export function diffEnvBeforeAfter(before: Record<string, boolean>, after: Record<string, boolean>): string[] {
  const changed: string[] = [];
  for (const k of Object.keys({ ...before, ...after })) {
    if (before[k] !== after[k]) changed.push(k);
  }
  return changed;
}

export { detectEnv, diffEnv };
