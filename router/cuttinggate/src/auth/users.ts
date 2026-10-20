import { createHmac } from "node:crypto";
import { ct_eq, PBKDF2_ITERS, now, pw_fragment, base64_decode, form_field, url_decode, hex_val } from "./tokens";
// Session/throttle constants. Canonical definitions live in
// src/strategy/router_auth.ts; mirrored here because src/auth/ is a leaf
// module and must not depend on the strategy tree.
const COOKIE = "estate_session";
const SESSION_TTL_SECS = 12 * 3600;
const THROTTLE_WINDOW_SECS = 60;
const THROTTLE_MAX_FAILURES = 10;

/** Memoized scraper credential: the tag for the last verified user:pass. */
export interface Memo {
  valid: boolean;
  tagHex: string;
  username: string;
}

/** Big-endian 8-byte encoding of a 64-bit value. */
function be64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(v);
  return b;
}

// Session/throttle state: a random per-boot signing key (sessions don't
// survive restarts — deliberate, see the auth-posture ADR), the login
// throttle, and a memo of the last verified scraper credential so
// Prometheus polls don't pay PBKDF2 every 15 seconds.

/** Represents a stored user configuration. */
export interface User {
  /** Unique username */
  username: string;
  /** Hashed and salted password */
  password_hash: string;
  /** User role/permissions */
  role: Role;
  /** Optional locale preference */
  locale: string | null;
}

/** User roles. */
export type Role = "superuser" | "user" | string;

/** Stored config holding users and their metadata. */
export interface StoredConfig {
  /** List of users */
  users: User[];
  /** Default user role if not specified */
  default_role: Role;
}

/** Admin session/throttle state. */
export class Admin {
  /** Random per-boot signing key (32 bytes). */
  signing_key: Uint8Array;
  /** Whether to trust X-Forwarded-Proto header for "secure" cookie flag. */
  trust_proxy: boolean;
  /** Fixed-window failed-login limiter (per process). */
  throttle: Throttle;
  /** Memo of last verified scraper credential: (HMAC(signing_key, "user:pass"), username). */
  scraper_memo: Memo;
  /** Flag indicating if setup is required. */
  setup_required: boolean;

  /** Create a new Admin instance with a random signing key. */
  constructor(trust_proxy: boolean = false) {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    this.signing_key = key;
    this.trust_proxy = trust_proxy;
    this.throttle = {
      window_start: now(),
      failures: 0,
    };
    this.scraper_memo = {
      valid: false,
      tagHex: "",
      username: "",
    };
    this.setup_required = true;
  }

  /** HMAC-SHA256 over length-prefixed parts. */
  mac(parts: Uint8Array[]): Uint8Array {
    const hmac = createHmac("sha256", this.signing_key);
    for (const p of parts) {
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64BE(BigInt(p.length));
      hmac.update(lenBuf);
      hmac.update(Buffer.from(p));
    }
    return new Uint8Array(hmac.digest());
  }

  /** Mint a session token for `user`:
   * `hex(expiry).hex(username).pw_fragment.hex(hmac)`.
   */
  sign_session(expiry: number, username: string, password_hash: string): string {
    const frag = pw_fragment(password_hash);
    const tag = this.mac([
      be64(BigInt(expiry)),
      Buffer.from(username, "utf8"),
      Buffer.from(frag, "utf8"),
    ]);
    const tagHex = Array.from(tag)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    const userHex = Array.from(Buffer.from(username, "utf8"))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    return `${expiry.toString(16)}.${userHex}.${frag}.${tagHex}`;
  }

  /** Verify a session token against the live store: signature intact, not
   * expired, user still exists, password unchanged since minting.
   * Returns the authenticated username, or null. */
  verify_session(token: string, sc: StoredConfig): string | null {
    const parts = token.split(".");
    if (parts.length !== 4) return null;

    const [expHex, userHex, frag, tagHex] = parts;
    if (!expHex || !userHex || !frag || !tagHex) return null;

    // Parse expiry
    // sign_session emits expiry.toString(16), so this is a hex string.
    // BigInt() parses a bare string as DECIMAL: without the 0x prefix every
    // real token threw here, so verification never succeeded for anyone.
    if (!/^[0-9a-f]+$/i.test(expHex)) return null;
    let expiry: bigint;
    try {
      expiry = BigInt("0x" + expHex);
    } catch {
      return null;
    }

    // Check expiry
    if (expiry < BigInt(now())) return null;

    // Parse username from hex
    const userBytes = Uint8Array.fromHex(userHex);
    if (userBytes.length === 0) return null;
    const decoder = new TextDecoder();
    const userName = decoder.decode(userBytes);

    // Recompute expected tag
    const expectedTag = this.mac([
      be64(expiry),
      Buffer.from(userName, "utf8"),
      Buffer.from(frag, "utf8"),
    ]);
    const expectedTagHex = Array.from(expectedTag)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time compare tags
    if (!ct_eq(tagHex, expectedTagHex)) return null;

    // Check user exists in store and password hasn't changed
    const user = sc.users.find(u => u.username === userName);
    if (!user) return null;

    // Verify password fragment matches
    if (!ct_eq(frag, pw_fragment(user.password_hash))) return null;

    return userName;
  }

  /** Record a failed attempt; returns true if the caller is now throttled. */
  note_failure(): boolean {
    let t = this.throttle;
    // Reset throttle window if enough time has passed
    if (now() - t.window_start >= THROTTLE_WINDOW_SECS) {
      t.window_start = now();
      t.failures = 0;
    }
    t.failures += 1;
    return t.failures > THROTTLE_MAX_FAILURES;
  }

  /** Check if the throttle is currently active. */
  is_throttled(): boolean {
    let t = this.throttle;
    return (
      now() - t.window_start < THROTTLE_WINDOW_SECS && t.failures > THROTTLE_MAX_FAILURES
    );
  }

  /** Atomically account for a pre-auth attempt before it can begin costly work.
   * The first THROTTLE_MAX_FAILURES attempts retain the existing throttle
   * behavior; later attempts are rejected while holding the same limiter lock. */
  admit_pre_auth_attempt(): boolean {
    let t = this.throttle;
    // Reset throttle window if enough time has passed
    if (now() - t.window_start >= THROTTLE_WINDOW_SECS) {
      t.window_start = now();
      t.failures = 0;
    }
    if (t.failures > THROTTLE_MAX_FAILURES) {
      return false;
    }
    t.failures += 1;
    return true;
  }

  /** Admit a pre-auth unit of costly work. A rejected attempt never invokes
   * `work`, so callers can put blocking-pool admission inside the closure. */
  admit_pre_auth_work<T>(work: () => T): T | null {
    if (this.admit_pre_auth_attempt()) {
      return work();
    }
    return null;
  }

  /** Forget the memoized scraper credential. Call on any change to users
   * (password change/reset, user removal) so revocation is immediate. */
  clear_scraper_memo(): void {
    this.scraper_memo = {
      valid: false,
      tagHex: "",
      username: "",
    };
  }

  /** Check if a credential matches the memoized one. */
  memo_hit(cred: string): string | null {
    const tag = this.mac([Buffer.from(cred, "utf8")]);
    const expectedTagHex = Array.from(tag)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    if (!ct_eq(expectedTagHex, this.scraper_memo.tagHex)) return null;

    return this.scraper_memo.username;
  }

  /** Memoize a credential and username. */
  memoize(cred: string, username: string): void {
    const tag = this.mac([Buffer.from(cred, "utf8")]);
    this.scraper_memo = {
      valid: true,
      tagHex: Array.from(tag)
        .map(b => b.toString(16).padStart(2, "0"))
        .join(""),
      username,
    };
  }

  /** Build Set-Cookie header value for a just-verified user. */
  cookie(token: string, max_age: number, trust_proxy: boolean = this.trust_proxy): string {
    const secure = trust_proxy &&
      /* trust proxy check would need real headers; simplified here */ false;
    const secure_attr = secure ? "; Secure" : "";
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${max_age}${secure_attr}`;
  }

  /** Reset throttle window if it has rolled over. */
  static reset_throttle_window(t: Throttle): void {
    if (now() - t.window_start >= THROTTLE_WINDOW_SECS) {
      t.window_start = now();
      t.failures = 0;
    }
  }
}

/** Fixed-window failed-login limiter (per process, not per IP). */
export interface Throttle {
  /** Window start timestamp (seconds since epoch). */
  window_start: number;
  /** Number of consecutive failures. */
  failures: number;
}

/** Default Admin creation with trust_proxy=false. */
export function createAdmin(trust_proxy: boolean = false): Admin {
  return new Admin(trust_proxy);
}

/** Parse a stored config from a simple data structure. */
export function parseStoredConfig(data: {
  users: Array<{ username: string; password_hash: string; role: Role; locale: string | null }>;
}): StoredConfig {
  return {
    users: data.users.map(u => ({
      username: u.username,
      password_hash: u.password_hash,
      role: u.role,
      locale: u.locale,
    })),
    default_role: "user",
  };
}