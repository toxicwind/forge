// Provider env + key detection (port of router.py detect_env/diff_env/key_ok)
export const PROVIDERS = ["openrouter", "groq", "google", "mistral"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function keyOk(p: string): boolean {
  switch (p) {
    case "openrouter": return !!Bun.env.OPENROUTER_API_KEY;
    case "groq": return !!Bun.env.GROQ_API_KEY;
    case "google": return !!Bun.env.GOOGLE_API_KEY;
    case "mistral": return !!Bun.env.MISTRAL_API_KEY;
    default: return false;
  }
}

export function detectEnv(): Record<string, boolean> {
  return Object.fromEntries(PROVIDERS.map((p) => [p, keyOk(p)]));
}

export function diffEnv(): string[] {
  return PROVIDERS.filter((p) => !keyOk(p));
}
