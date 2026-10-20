// Session id + AST/code detection helpers
export function isAstCode(s: string): boolean {
  return /```|function|class |import |export |def |=>|;\s*$/m.test(s);
}

export async function sessionId(req: Request): Promise<string> {
  try {
    const cloned = req.clone();
    const body = await cloned.json().catch(() => ({}));
    const seed = JSON.stringify(body?.messages?.slice(0, 1) ?? {});
    const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(seed));
    return Array.from(new Uint8Array(buf)).map((x) => x.toString(16)).join("").slice(0, 12);
  } catch {
    return "nosid";
  }
}
