/**
 * Tests for the Copilot credential exchange.
 *
 * The whole provider is one thing that cannot be reached with a static key: an
 * account token is exchanged for a short-lived session credential, and the
 * exchange also names which host this tenant is provisioned for. Both are pure
 * decisions wrapped around one HTTP call, so they are tested without a network.
 */

import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_GRACE_SECS,
  COPILOT_PROVIDER,
  CopilotClient,
  DEFAULT_HOST,
  FALLBACK_TTL_SECS,
  HOST_BY_CLASS,
  MAX_TTL_SECS,
  accountTokenFromEnv,
  copilotHeaders,
  exchangeToken,
  isCredentialValid,
  parseExpiry,
  resolveTtl,
  tenantClassFromEndpoints,
} from "../src/copilot.ts";

/** A stand-in for fetch that answers the credential exchange once. */
function exchangeFetch(body: unknown, calls: { n: number } = { n: 0 }) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.n++;
    if (!init?.headers) throw new Error("exchange must send an Authorization header");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("tenant host discovery", () => {
  test("maps the endpoint map to a host class", () => {
    expect(tenantClassFromEndpoints({ api: "https://api.githubcopilot.com" })).toBe("Standard");
    expect(tenantClassFromEndpoints({ api: "https://api.business.githubcopilot.com" })).toBe("Team");
    expect(tenantClassFromEndpoints({ api: "https://api.enterprise.githubcopilot.com" })).toBe(
      "Organization",
    );
  });

  // Substring, not equality: an exact match would silently downgrade a Business
  // tenant to the Standard pipeline, which reads as a bad token, not a bad host.
  test("a versioned host still resolves to its class", () => {
    expect(tenantClassFromEndpoints({ api: "https://api.enterprise.githubcopilot.com/v2" })).toBe(
      "Organization",
    );
  });

  test("a missing endpoint map degrades to Standard rather than failing", () => {
    expect(tenantClassFromEndpoints(undefined)).toBe("Standard");
    expect(tenantClassFromEndpoints({})).toBe("Standard");
    expect(tenantClassFromEndpoints({ other: "x" })).toBe("Standard");
  });

  test("each class serves its own host", () => {
    expect(HOST_BY_CLASS.Standard).toBe(DEFAULT_HOST);
    expect(HOST_BY_CLASS.Team).toBe("https://api.business.githubcopilot.com");
    expect(HOST_BY_CLASS.Organization).toBe("https://api.enterprise.githubcopilot.com");
  });
});

describe("expiry coercion", () => {
  test("reads RFC3339 and unix seconds alike", () => {
    const now = Date.now();
    expect(parseExpiry("1970-01-01T00:00:00Z", now)).toBe(0);
    // Sub-1e11 is seconds, not milliseconds.
    expect(parseExpiry(1_700_000_000, now)).toBe(1_700_000_000_000);
  });

  test("an unusable value yields undefined so the caller falls back", () => {
    expect(parseExpiry(undefined)).toBeUndefined();
    expect(parseExpiry("not-a-date")).toBeUndefined();
  });
});

describe("credential lifetime", () => {
  test("refresh_in wins, because the server states its own cadence", () => {
    expect(resolveTtl("1970-01-01T00:00:00Z", 900)).toBe(900_000);
  });

  test("an unparseable expiry falls back instead of sticking", () => {
    expect(resolveTtl("not-a-date", undefined)).toBe(FALLBACK_TTL_SECS * 1000);
    expect(resolveTtl(undefined, undefined)).toBe(FALLBACK_TTL_SECS * 1000);
  });

  // A bogus long expiry must not pin a revoked credential in the cache forever.
  test("lifetime is clamped at both ends", () => {
    expect(resolveTtl("9999-01-01T00:00:00Z", undefined)).toBe(MAX_TTL_SECS * 1000);
    expect(resolveTtl(undefined, 0)).toBe(FALLBACK_TTL_SECS * 1000);
    expect(resolveTtl(undefined, 1)).toBe(CREDENTIAL_GRACE_SECS * 1000);
  });

  // The grace window is 60s, so "inside it" means expiring sooner than that.
  // A credential 30s out still reads as expired: dispatching it would race the
  // expiry, which is the 401 this margin exists to prevent.
  test("a credential inside the grace window reads as expired", () => {
    const now = Date.now();
    expect(isCredentialValid({ value: "t", expiresAt: now + 30_000 }, now)).toBe(false);
    expect(isCredentialValid({ value: "t", expiresAt: now + 120_000 }, now)).toBe(true);
  });
});

describe("request headers", () => {
  const headers = copilotHeaders("session-token");

  test("carries the session credential as a bearer", () => {
    expect(headers.Authorization).toBe("Bearer session-token");
  });

  test("carries the editor identity the upstream expects", () => {
    expect(headers["Editor-Version"]).toBe("vscode/1.104.1");
    expect(headers["Editor-Plugin-Version"]).toBe("copilot-chat/0.24.0");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
  });

  // Without openai-intent the chat endpoint lands on the code-completions
  // pipeline and answers a different shape entirely.
  test("pins the conversation-completions pipeline", () => {
    expect(headers["openai-intent"]).toBe("conversation-completions");
  });
});

describe("credential exchange", () => {
  test("returns a credential and the tenant host", async () => {
    const calls = { n: 0 };
    const client = new CopilotClient(
      "gho_test",
      exchangeFetch(
        {
          token: "session-1",
          expires_at: "9999-01-01T00:00:00Z",
          refresh_in: 1200,
          endpoints: { api: "https://api.business.githubcopilot.com" },
        },
        calls,
      ),
    );

    expect(await client.credential()).toBe("session-1");
    expect(await client.tenantClass()).toBe("Team");
    expect(await client.host()).toBe("https://api.business.githubcopilot.com");
    expect(calls.n).toBe(1);
  });

  // The whole point of the single-flight: a cold cache must not fan out N
  // identical authenticated calls at the account console.
  test("concurrent callers share one exchange", async () => {
    const calls = { n: 0 };
    const client = new CopilotClient("gho_test", exchangeFetch({ token: "session-1", refresh_in: 1200 }, calls));

    const results = await Promise.all([
      client.credential(),
      client.credential(),
      client.credential(),
      client.credential(),
    ]);
    expect(results).toEqual(["session-1", "session-1", "session-1", "session-1"]);
    expect(calls.n).toBe(1);
  });

  test("a cached credential is reused until it nears expiry", async () => {
    const calls = { n: 0 };
    const client = new CopilotClient("gho_test", exchangeFetch({ token: "session-1", refresh_in: 1200 }, calls));

    await client.credential();
    await client.credential();
    await client.credential();
    expect(calls.n).toBe(1);
  });

  test("a tokenless response is an error, not an empty credential", async () => {
    const client = new CopilotClient(
      "gho_test",
      exchangeFetch({ expires_at: "9999-01-01T00:00:00Z" }),
    );
    await expect(client.credential()).rejects.toThrow("no token");
  });

  test("a non-2xx exchange surfaces the status", async () => {
    const failing = (async () => new Response("bad scope", { status: 403 })) as unknown as typeof fetch;
    const client = new CopilotClient("gho_test", failing);
    await expect(client.credential()).rejects.toThrow("403");
  });

  test("the account token is never the session credential", async () => {
    const client = new CopilotClient("gho_account", exchangeFetch({ token: "session-1", refresh_in: 1200 }));
    expect(client.accountToken()).toBe("gho_account");
    expect(await client.credential()).toBe("session-1");
  });
});

describe("token discovery", () => {
  test("reads the configured env var", () => {
    expect(accountTokenFromEnv("MY_TOKEN", { MY_TOKEN: "gho_x" })).toBe("gho_x");
  });

  // A blank value sent as an empty credential comes back as an opaque 401.
  test("unset or blank reads as absent", () => {
    expect(accountTokenFromEnv("MY_TOKEN", {})).toBeNull();
    expect(accountTokenFromEnv("MY_TOKEN", { MY_TOKEN: "   " })).toBeNull();
    expect(accountTokenFromEnv("MY_TOKEN", { MY_TOKEN: "" })).toBeNull();
  });

  test("trims surrounding whitespace", () => {
    expect(accountTokenFromEnv("MY_TOKEN", { MY_TOKEN: "  gho_x \n" })).toBe("gho_x");
  });

  test("the provider key matches what the router routes on", () => {
    expect(COPILOT_PROVIDER).toBe("custom/copilot");
  });
});