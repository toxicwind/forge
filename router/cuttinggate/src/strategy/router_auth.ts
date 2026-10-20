#!/usr/bin/env bun
/**
 * Operator auth for estate-scripts-router-ts — TypeScript port of flock's
 * proxy/src/auth.rs (role/session semantics).
 *
 * What this ports, faithfully:
 *  - constant-time comparison for every secret comparison (ctEq)
 *  - SHA-256 helpers (sha256Hex)
 *  - PBKDF2-HMAC-SHA256 password hashes: `pbkdf2-sha256$<iters>$<salt>$<hash>`
 *    (hex); 600_000 iterations for new hashes; verification honors the
 *    iteration count stored in each hash. Async (libuv threadpool) so logins
 *    never block the event loop.
 *  - HMAC-signed session tokens binding expiry + username + a fingerprint of
 *    the *current* password hash. The fingerprint is what invalidates sessions
 *    on password change; the username is re-resolved against the live user
 *    store on every request, so deleting a user kills their sessions too.
 *  - Per-boot random 32-byte signing key (never persisted — sessions die on
 *    restart, deliberately).
 *  - 12-hour session TTL.
 *  - Fixed-window failed-login throttle: 60s window, >10 failures = throttled.
 *  - Scraper-credential memo: stores HMAC(signing_key, "user:pass") digests
 *    only — raw credentials are never retained.
 *  - Session cookie: HttpOnly, SameSite=Strict, Path=/, Secure only behind a
 *    trusted https proxy (config-driven).
 *  - Identity resolution: valid session cookie, else `Authorization: Bearer
 *    user:pass`, else HTTP Basic — verified against the live store.
 *
 * What this deliberately does NOT port: the axum login HTML pages, the setup
 * wizard, and pre-setup redirects (no setup flow exists in the router). The
 * router exposes POST /auth/login + POST /auth/logout (JSON or form) instead.
 *
 * Deliberate deviations from auth.rs (documented, all fail-closed):
 *  - Cookie name is `estate_session` (flock used `flock_session`).
 *  - A scraper-memo hit re-validates that the user still exists in the store
 *    before returning an identity; flock trusts the memo until the caller
 *    invokes clearScraperMemo(). Deletion therefore kills header-credential
 *    sessions immediately even if the caller forgot to clear the memo.
 *  - identify() returns { username, role } instead of a bare username so
 *    downstream role checks are possible. Roles are carried on the user
 *    record (default "user"); no endpoint gates on role yet.
 *
 * Activation: the operator gate is OFF unless users are configured, via
 * ESTATE_AUTH_USERS_FILE (JSON: {"users":[{"username","password_hash",
 * "role"}]}) or ESTATE_AUTH_USERS (same JSON inline). With no users
 * configured the router behaves exactly as before. /v1/* keeps the
 * ESTATE_CLIENT_KEYS gate in router.ts untouched; /health stays open.
 *
 * Mint a hash for the users file:
 *   bun router_auth.ts --hash 'your-password'
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  pbkdf2 as pbkdf2Cb,
} from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";

const pbkdf2Async = promisify(pbkdf2Cb);

export const COOKIE_NAME = "estate_session";
export const SESSION_TTL_SECS = 12 * 3600;
export const THROTTLE_WINDOW_SECS = 60;
export const THROTTLE_MAX_FAILURES = 10;
export const PBKDF2_ITERS = 600_000;
export const PBKDF2_KEYLEN = 32;
export const PBKDF2_SALT_LEN = 16;

/** Burner hash for unknown-user logins: same cost as a real verification so
 *  response time doesn't reveal which usernames exist (mirrors auth.rs). */
export const BURNER_HASH =
  "pbkdf2-sha256$600000$00000000000000000000000000000000$" +
  "0000000000000000000000000000000000000000000000000000000000000000";

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Constant-time string equality. Like Rust's subtle::ct_eq, a length
 *  mismatch short-circuits (leaks the length only, which is acceptable); the
 *  bytes themselves are always compared in full via timingSafeEqual. */
export function ctEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function hexEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Strict hex decode; null on odd length or non-hex input (fail closed). */
export function hexDecode(s: string): Uint8Array | null {
  if (s.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(s)) return null;
  return Buffer.from(s, "hex");
}

/** One PBKDF2-HMAC-SHA256 block (dkLen 32). Async: runs on the libuv
 *  threadpool, never blocks the event loop. */
export async function pbkdf2Sha256(
  password: string | Uint8Array,
  salt: Uint8Array,
  iters: number,
): Promise<Buffer> {
  return pbkdf2Async(password, salt, iters, PBKDF2_KEYLEN, "sha256");
}

/** Hash a password for storage: `pbkdf2-sha256$<iters>$<salt>$<hash>` (hex).
 *  New hashes always use PBKDF2_ITERS (600_000); the iters parameter exists
 *  so tests can mint cheap fixtures — production callers leave the default. */
export async function hashPassword(
  password: string,
  iters: number = PBKDF2_ITERS,
): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_LEN);
  const dk = await pbkdf2Sha256(password, salt, iters);
  return `pbkdf2-sha256$${iters}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

/** Verify a password against a stored hash string; malformed strings fail
 *  closed. Honors the hash's own iteration count. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [scheme = "", itersS = "", saltHex = "", hashHex = ""] = parts;
  if (scheme !== "pbkdf2-sha256") return false;
  if (!/^\d+$/.test(itersS)) return false;
  const iters = parseInt(itersS, 10);
  if (!Number.isSafeInteger(iters) || iters < 1) return false;
  const salt = hexDecode(saltHex);
  if (!salt) return false;
  if (!/^[0-9a-fA-F]+$/.test(hashHex)) return false;
  const dk = await pbkdf2Sha256(password, salt, iters);
  return ctEq(dk.toString("hex"), hashHex);
}

/** Minimal strict base64 decoder (standard alphabet, optional padding) —
 *  rejects garbage instead of silently skipping it. */
export function base64DecodeStrict(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const unpadded = clean.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  return Buffer.from(clean, "base64");
}

function hexVal(b: number | undefined): number | undefined {
  if (b === undefined) return undefined; // out-of-range index read
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return undefined;
}

/** Percent-decode a form field byte-wise (never splits multibyte chars),
 *  mirroring auth.rs's url_decode. */
export function urlDecode(s: string): string {
  const bytes = Buffer.from(s.replace(/\+/g, " "), "utf8");
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const cur = bytes[i];
    if (cur === undefined) break; // unreachable: i < bytes.length
    if (cur === 0x25 && i + 2 < bytes.length) {
      const h = hexVal(bytes[i + 1]);
      const l = hexVal(bytes[i + 2]);
      if (h !== undefined && l !== undefined) {
        out.push((h << 4) | l);
        i += 3;
        continue;
      }
    }
    out.push(cur);
    i++;
  }
  return Buffer.from(out).toString("utf8");
}

/** Parse one field from an application/x-www-form-urlencoded body. */
export function formField(body: string, field: string): string | null {
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) === field) return urlDecode(pair.slice(eq + 1));
  }
  return null;
}

// ---------------------------------------------------------------------------
// User store
// ---------------------------------------------------------------------------

export interface AuthUser {
  username: string;
  passwordHash: string;
  role?: string;
}

export interface UserStore {
  getUser(username: string): AuthUser | undefined;
  userCount(): number;
}

export class MemoryUserStore implements UserStore {
  private m = new Map<string, AuthUser>();
  constructor(users: AuthUser[] = []) {
    for (const u of users) this.m.set(u.username, u);
  }
  getUser(username: string): AuthUser | undefined {
    return this.m.get(username);
  }
  userCount(): number {
    return this.m.size;
  }
  upsert(u: AuthUser): void {
    this.m.set(u.username, u);
  }
  remove(username: string): void {
    this.m.delete(username);
  }
}

function coerceUsers(raw: unknown): AuthUser[] {
  const arr = Array.isArray(raw) ? raw : (raw as { users?: unknown })?.users;
  if (!Array.isArray(arr)) return [];
  const out: AuthUser[] = [];
  for (const u of arr) {
    if (
      u &&
      typeof (u as AuthUser).username === "string" &&
      typeof (u as AuthUser).passwordHash === "string"
    ) {
      out.push({
        username: (u as AuthUser).username,
        passwordHash: (u as AuthUser).passwordHash,
        role:
          typeof (u as AuthUser).role === "string"
            ? (u as AuthUser).role
            : "user",
      });
    }
  }
  return out;
}

export interface AuthSetup {
  admin: Admin;
  store: MemoryUserStore;
}

/** Build auth from the environment, or null when no users are configured
 *  (operator gate stays off — today's behavior is preserved). */
export function loadAuthFromEnv(): AuthSetup | null {
  let users: AuthUser[] = [];
  const file = process.env.ESTATE_AUTH_USERS_FILE || "";
  const inline = process.env.ESTATE_AUTH_USERS || "";
  if (file && existsSync(file)) {
    try {
      users = coerceUsers(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      console.error(`[auth] failed to parse ${file}:`, e);
    }
  } else if (inline) {
    try {
      users = coerceUsers(JSON.parse(inline));
    } catch (e) {
      console.error("[auth] failed to parse ESTATE_AUTH_USERS:", e);
    }
  }
  if (!users.length) return null;
  const tp = (process.env.ESTATE_AUTH_TRUST_PROXY || "").toLowerCase();
  const trustProxy = tp === "1" || tp === "true" || tp === "yes";
  return { admin: new Admin(trustProxy), store: new MemoryUserStore(users) };
}

// ---------------------------------------------------------------------------
// Admin: sessions, throttle, scraper memo, cookies
// ---------------------------------------------------------------------------

export class Admin {
  /** Random per-boot signing key. Never persisted — sessions die on restart
   *  (deliberate, mirrors flock's auth-posture). */
  readonly signingKey: Buffer;
  readonly trustProxy: boolean;
  /** Fixed-window failed-login limiter state (per process, a cheap backstop;
   *  a reverse proxy should do IP-level limiting). Public for tests. */
  throttle = { windowStart: nowSecs(), failures: 0 };
  /** (HMAC(signing_key, "user:pass"), username) of the last verified header
   *  credential. Digests only — raw credentials are never retained. Cleared
   *  whenever users change. */
  private scraperMemo: { tag: Buffer; username: string } | null = null;

  constructor(trustProxy = false) {
    this.signingKey = randomBytes(32);
    this.trustProxy = trustProxy;
  }

  private hmac(parts: Uint8Array[]): Buffer {
    const h = createHmac("sha256", this.signingKey);
    for (const p of parts) {
      const len = Buffer.alloc(8);
      len.writeBigUInt64BE(BigInt(p.length)); // length-prefix each part
      h.update(len);
      h.update(p);
    }
    return h.digest();
  }

  /** First 8 hex chars of SHA-256(password_hash): binds a session to a
   *  password *generation* (invalidation on change) without helping brute
   *  force the hash itself. */
  pwFragment(passwordHash: string): string {
    return sha256Hex(passwordHash).slice(0, 8);
  }

  /** Mint a session token: `hex(expiry).hex(username).pw_fragment.hex(hmac)`. */
  signSession(expiry: number, username: string, passwordHash: string): string {
    const frag = this.pwFragment(passwordHash);
    const expBuf = Buffer.alloc(8);
    expBuf.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(expiry))));
    const tag = this.hmac([
      expBuf,
      Buffer.from(username, "utf8"),
      Buffer.from(frag, "utf8"),
    ]);
    return `${Math.floor(expiry).toString(16)}.${hexEncode(
      Buffer.from(username, "utf8"),
    )}.${frag}.${tag.toString("hex")}`;
  }

  /** Verify a session token against the live store: signature intact, not
   *  expired, user still exists, password unchanged since minting. Returns
   *  the authenticated username. */
  verifySession(
    token: string,
    store: UserStore,
    nowS: number = nowSecs(),
  ): string | null {
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [expHex = "", userHex = "", frag = "", tagHex = ""] = parts;
    if (!/^[0-9a-fA-F]+$/.test(expHex)) return null;
    const expiry = parseInt(expHex, 16);
    if (!Number.isSafeInteger(expiry) || expiry < nowS) return null;
    const userBytes = hexDecode(userHex);
    if (!userBytes) return null;
    const username = Buffer.from(userBytes).toString("utf8");
    const expBuf = Buffer.alloc(8);
    expBuf.writeBigUInt64BE(BigInt(expiry));
    const expected = this.hmac([
      expBuf,
      Buffer.from(username, "utf8"),
      Buffer.from(frag, "utf8"),
    ]);
    if (!ctEq(tagHex, expected.toString("hex"))) return null;
    const user = store.getUser(username);
    if (!user) return null;
    if (!ctEq(frag, this.pwFragment(user.passwordHash))) return null;
    return username;
  }

  private resetThrottleWindow(nowS: number): void {
    if (Math.max(0, nowS - this.throttle.windowStart) >= THROTTLE_WINDOW_SECS) {
      this.throttle.windowStart = nowS;
      this.throttle.failures = 0;
    }
  }

  /** Record a failed attempt; returns true if the caller is now throttled. */
  noteFailure(nowS: number = nowSecs()): boolean {
    this.resetThrottleWindow(nowS);
    this.throttle.failures += 1;
    return this.throttle.failures > THROTTLE_MAX_FAILURES;
  }

  isThrottled(nowS: number = nowSecs()): boolean {
    return (
      Math.max(0, nowS - this.throttle.windowStart) < THROTTLE_WINDOW_SECS &&
      this.throttle.failures > THROTTLE_MAX_FAILURES
    );
  }

  /** Atomically account for a pre-auth attempt before it can begin costly
   *  work. The first eleven attempts retain the existing throttle behavior;
   *  later attempts are rejected. */
  admitPreAuthAttempt(nowS: number = nowSecs()): boolean {
    this.resetThrottleWindow(nowS);
    if (this.throttle.failures > THROTTLE_MAX_FAILURES) return false;
    this.throttle.failures += 1;
    return true;
  }

  /** Admit a pre-auth unit of costly work. A rejected attempt never invokes
   *  `work`. */
  admitPreAuthWork<T>(work: () => T, nowS: number = nowSecs()): T | null {
    return this.admitPreAuthAttempt(nowS) ? work() : null;
  }

  /** Forget the memoized scraper credential. Call on any change to users
   *  (password change/reset, user removal) so revocation is immediate. */
  clearScraperMemo(): void {
    this.scraperMemo = null;
  }

  memoHit(cred: string): string | null {
    const tag = this.hmac([Buffer.from(cred, "utf8")]);
    const m = this.scraperMemo;
    if (!m) return null;
    return ctEq(tag.toString("hex"), m.tag.toString("hex"))
      ? m.username
      : null;
  }

  memoize(cred: string, username: string): void {
    this.scraperMemo = {
      tag: this.hmac([Buffer.from(cred, "utf8")]),
      username,
    };
  }

  /** Test/diagnostic accessor: the memo's stored tag as hex. Asserts in
   *  tests that no raw credential is retained. */
  memoTagHex(): string | null {
    return this.scraperMemo ? this.scraperMemo.tag.toString("hex") : null;
  }

  buildSetCookie(
    token: string,
    maxAge: number,
    forwardedProto?: string | null,
  ): string {
    const secure =
      this.trustProxy && (forwardedProto || "").toLowerCase() === "https";
    return (
      `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; ` +
      `Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
    );
  }

  /** Mint a Set-Cookie value for a just-verified user. */
  mintSessionCookie(
    username: string,
    passwordHash: string,
    forwardedProto?: string | null,
    nowS: number = nowSecs(),
  ): string {
    const expiry = nowS + SESSION_TTL_SECS;
    const token = this.signSession(expiry, username, passwordHash);
    return this.buildSetCookie(token, SESSION_TTL_SECS, forwardedProto);
  }
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export interface Identity {
  username: string;
  role: string;
}

export function cookieToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const t = part.trim();
    if (t.startsWith(COOKIE_NAME + "=")) return t.slice(COOKIE_NAME.length + 1);
  }
  return null;
}

/** Resolve the request's identity: a valid session cookie, or scraper-style
 *  header credentials (`Authorization: Bearer user:pass` or HTTP Basic)
 *  verified against the store. Header verification pays PBKDF2 once, then
 *  hits the HMAC digest memo on subsequent polls. Returns { username, role }. */
export async function identifyRequest(
  req: Request,
  admin: Admin,
  store: UserStore,
): Promise<Identity | null> {
  const tok = cookieToken(req.headers.get("cookie"));
  if (tok) {
    const u = admin.verifySession(tok, store);
    if (u) {
      const rec = store.getUser(u);
      if (rec) return { username: u, role: rec.role || "user" };
    }
  }
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  let cred: string;
  if (auth.startsWith("Bearer ")) {
    cred = auth.slice(7).trim();
  } else if (auth.startsWith("Basic ")) {
    const dec = base64DecodeStrict(auth.slice(6).trim());
    if (!dec) return null;
    cred = Buffer.from(dec).toString("utf8");
  } else {
    return null;
  }
  const memoUser = admin.memoHit(cred);
  if (memoUser) {
    // Deviation from auth.rs (documented above): re-validate existence so a
    // deleted user loses header-credential access immediately.
    const rec = store.getUser(memoUser);
    if (rec) return { username: memoUser, role: rec.role || "user" };
  }
  const colon = cred.indexOf(":");
  if (colon < 0) return null;
  const username = cred.slice(0, colon);
  const password = cred.slice(colon + 1);
  const rec = store.getUser(username);
  if (!rec) return null;
  const ok = await verifyPassword(password, rec.passwordHash);
  if (!ok) return null;
  admin.memoize(cred, username);
  return { username, role: rec.role || "user" };
}

// ---------------------------------------------------------------------------
// Login / logout handlers (JSON or form). Active only when users configured.
// ---------------------------------------------------------------------------

function jsonResp(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

/** POST /auth/login — verify username + password, set the session cookie.
 *  Throttled callers get 429 + Retry-After: 60. Unknown users are verified
 *  against a burner hash so timing doesn't reveal which usernames exist. */
export async function handleLogin(
  req: Request,
  admin: Admin,
  store: UserStore,
): Promise<Response> {
  if (admin.isThrottled()) {
    await sleepMs(500);
    return jsonResp(
      { error: "too_many_failed_attempts" },
      429,
      { "Retry-After": "60" },
    );
  }
  let username = "";
  let password = "";
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const b = (await req.json()) as { username?: unknown; password?: unknown };
      username = typeof b?.username === "string" ? b.username : "";
      password = typeof b?.password === "string" ? b.password : "";
    } else {
      const body = await req.text();
      username = formField(body, "username") || "";
      password = formField(body, "password") || "";
    }
  } catch {
    return jsonResp({ error: "invalid_request" }, 400);
  }
  const rec = store.getUser(username);
  const hash = rec ? rec.passwordHash : BURNER_HASH;
  const ok = (await verifyPassword(password, hash)) && !!rec;
  if (ok && rec) {
    const setCookie = admin.mintSessionCookie(
      username,
      rec.passwordHash,
      req.headers.get("x-forwarded-proto"),
    );
    return jsonResp(
      {
        ok: true,
        user: username,
        role: rec.role || "user",
        expires_in: SESSION_TTL_SECS,
      },
      200,
      { "Set-Cookie": setCookie },
    );
  }
  admin.noteFailure();
  await sleepMs(500);
  return jsonResp({ error: "invalid_credentials" }, 401);
}

/** POST /auth/logout — clear the session cookie. */
export function handleLogout(admin: Admin, req: Request): Response {
  const cleared = admin.buildSetCookie(
    "",
    0,
    req.headers.get("x-forwarded-proto"),
  );
  return jsonResp({ ok: true }, 200, { "Set-Cookie": cleared });
}

// ---------------------------------------------------------------------------
// CLI: mint a password hash for the users file
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--hash" && typeof argv[1] === "string") {
    console.log(await hashPassword(argv[1]));
  } else {
    console.error("usage: bun router_auth.ts --hash <password>");
    process.exit(2);
  }
}
