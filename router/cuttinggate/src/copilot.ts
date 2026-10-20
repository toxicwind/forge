/**
 * GitHub Copilot provider for cuttinggate.
 *
 * Copilot is the one upstream that cannot be reached with a static API key: a
 * long-lived *account* token (`gho_` / `ghu_` / `github_pat_`) must be exchanged
 * for a short-lived *session* credential, and the exchange response names which
 * of three GitHub-operated hosts this tenant is provisioned for. The keypool
 * cannot model this — its cooldown/rotation semantics are about a fixed key, not
 * a token that must be re-minted against the account console.
 *
 * Endpoints:
 *   credential exchange: GET  https://api.github.com/copilot_internal/v2/token
 *   chat completions:    POST <host>/chat/completions
 */

/** Env var consulted when no explicit token env is configured. */
export const COPILOT_TOKEN_ENV = "GITHUB_TOKEN";

/** Registry key. cuttinggate routes on provider ids, so this must match. */
export const COPILOT_PROVIDER = "custom/copilot";
export const COPILOT_LEGACY_PROVIDER = "copilot";

/** Which GitHub-operated API host this tenant is provisioned for. */
export type TenantClass = "Standard" | "Team" | "Organization";

export const HOST_BY_CLASS: Record<TenantClass, string> = {
  Standard: "https://api.githubcopilot.com",
  Team: "https://api.business.githubcopilot.com",
  Organization: "https://api.enterprise.githubcopilot.com",
};

/** Default host before the exchange has told us otherwise. */
export const DEFAULT_HOST = HOST_BY_CLASS.Standard;

/**
 * Seconds of remaining life a credential needs before it is re-minted.
 *
 * A credential that passes this check must still survive the request that is
 * about to use it; without the margin, a token that expires between the check
 * and dispatch fails the request intermittently with a 401.
 */
export const CREDENTIAL_GRACE_SECS = 60;

/** Lifetime assumed when the exchange response carries no usable expiry. */
export const FALLBACK_TTL_SECS = 1500;

/** Upper bound, so a bogus `expires_at` cannot pin a revoked token forever. */
export const MAX_TTL_SECS = 3600;

export interface SessionCredential {
  value: string;
  /** Epoch millis at which this credential stops being usable. */
  expiresAt: number;
  refreshIn?: number;
}

export function isCredentialValid(cred: SessionCredential, now = Date.now()): boolean {
  // The margin is declared in seconds but compared against epoch millis, so it
  // has to be scaled here — subtracting the raw `60` gave a 60 *millisecond*
  // grace, which never fires.
  return cred.expiresAt - CREDENTIAL_GRACE_SECS * 1000 > now;
}

/**
 * Resolves the tenant's host class from the exchange's endpoint map.
 *
 * Substring, not equality: GitHub has shipped versioned hosts, and an exact
 * match against a new shape would silently downgrade a Business tenant to the
 * Standard pipeline — a 401 that reads like a bad token rather than a bad host.
 */
export function tenantClassFromEndpoints(
  endpoints: Record<string, string> | undefined,
): TenantClass {
  const api = endpoints?.api;
  if (!api) return "Standard";
  if (api.includes("business")) return "Team";

  if (api.includes("enterprise")) return "Organization";
  return "Standard";
}

/**
 * Coerces the `expires_at` field, which upstream sends as either an RFC3339
 * string or unix seconds.
 *
 * Returns `undefined` for a value that cannot be read, which makes the caller
 * fall back rather than cache a credential it cannot reason about.
 */
export function parseExpiry(raw: string | number | undefined, now = Date.now()): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    // Upstream sends unix SECONDS; values below 1e11 are far past expiry and are
    // more likely a millisecond timestamp from a future API revision.
    const ms = raw < 1e11 ? raw * 1000 : raw;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Milliseconds of life to grant a credential, clamped at both ends. */
export function resolveTtl(
  expiresAt: string | number | undefined,
  refreshIn: number | undefined,
  now = Date.now(),
): number {
  const fromRefresh = refreshIn && refreshIn > 0 ? refreshIn * 1000 : undefined;
  const fromExpiry = parseExpiry(expiresAt, now);
  const raw = fromRefresh ?? (fromExpiry === undefined ? undefined : fromExpiry - now);
  const secs = raw === undefined ? FALLBACK_TTL_SECS : Math.ceil(raw / 1000);
  return Math.min(MAX_TTL_SECS, Math.max(CREDENTIAL_GRACE_SECS, secs)) * 1000;
}

/**
 * Request headers for chat completions.
 *
 * `Editor-Version`, `Editor-Plugin-Version` and `Copilot-Integration-Id` are what
 * the upstream expects from a first-party editor client. `openai-intent` is
 * required for the chat endpoint to route to the conversation-completions
 * pipeline; without it requests land on code-completions and behave differently.
 */
export function copilotHeaders(sessionCredential: string): Record<string, string> {
  return {
    Authorization: `Bearer ${sessionCredential}`,
    "content-type": "application/json",
    "Editor-Version": "vscode/1.104.1",
    "Editor-Plugin-Version": "copilot-chat/0.24.0",
    "Copilot-Integration-Id": "vscode-chat",
    "openai-intent": "conversation-completions",
  };
}

type TokenResponse = {
  token?: string;
  expires_at?: string | number;
  refresh_in?: number;
  endpoints?: Record<string, string>;
};

/** Exchanges an account token for a session credential and the tenant's host. */
export async function exchangeToken(
  fetchImpl: typeof fetch,
  accountToken: string,
): Promise<{ credential: SessionCredential; tenantClass: TenantClass }> {
  const resp = await fetchImpl("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: { Authorization: `token ${accountToken}`, Accept: "application/json" },
  });

  if (!resp.ok) {
    throw new Error(`credential exchange returned ${resp.status}: ${await resp.text()}`);
  }

  const body = (await resp.json()) as TokenResponse;
  if (!body.token) throw new Error("credential exchange response had no token");

  return {
    credential: {
      value: body.token,
      expiresAt: Date.now() + resolveTtl(body.expires_at, body.refresh_in),
      refreshIn: body.refresh_in,
    },
    tenantClass: tenantClassFromEndpoints(body.endpoints),
  };
}

/**
 * Copilot client with automatic credential refresh.
 *
 * Refreshes are collapsed into one in-flight promise. Without it, a burst of
 * concurrent requests arriving after expiry each run their own exchange — N
 * identical authenticated calls at the account console, which is precisely the
 * pattern that gets a token rate-limited.
 */
export class CopilotClient {
  #fetch: typeof fetch;
  #accountToken: string;
  #credential?: SessionCredential;
  #tenantClass: TenantClass = "Standard";
  #inFlight?: Promise<string>;

  constructor(accountToken: string, fetchImpl: typeof fetch = fetch) {
    this.#accountToken = accountToken;
    this.#fetch = fetchImpl;
  }

  /** Returns a valid session credential, re-minting if needed. */
  async credential(): Promise<string> {
    if (this.#credential && isCredentialValid(this.#credential)) return this.#credential.value;
    this.#inFlight ??= exchangeToken(this.#fetch, this.#accountToken)
      .then(({ credential, tenantClass }) => {
        this.#credential = credential;
        this.#tenantClass = tenantClass;
        return credential.value;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  /**
   * The host this tenant is provisioned for.
   *
   * Ensures discovery has happened: a caller reaching for the host before any
   * exchange would otherwise get the Standard host and dispatch a Business
   * tenant down the wrong pipeline.
   */
  async tenantClass(): Promise<TenantClass> {
    if (!this.#credential) await this.credential();
    return this.#tenantClass;
  }

  /** The API host for this tenant. */
  async host(): Promise<string> {
    return HOST_BY_CLASS[await this.tenantClass()];
  }

  accountToken(): string {
    return this.#accountToken;
  }
}

/** Reads the account token from the environment, or null when unset/blank. */
export function accountTokenFromEnv(
  tokenEnv: string = COPILOT_TOKEN_ENV,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const trimmed = env[tokenEnv]?.trim();
  return trimmed ? trimmed : null;
}