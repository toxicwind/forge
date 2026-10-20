import { createHash } from "node:crypto";
/**
 * Core crypto primitives ported from flock/proxy/src/auth.rs.
 * These are pure (no I/O) functions that form the foundation
 * of the authentication system.
 */

// Constant-time byte equality (avoids leaking content via timing).
// Short-circuits only on a *length* mismatch — that leaks the secret's length,
// which is acceptable; the bytes themselves are always compared in full.
export function ct_eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  for (let i = 0; i < aBytes.length; i++) {
    result |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return result === 0;
}

/** SHA-256 hash of a string, returned as lowercase hex. */
export function sha256_hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** PBKDF2-HMAC-SHA256 iteration count for newly minted hashes (OWASP's
 * recommendation). Every stored hash encodes its own count, so this can be
 * raised later without invalidating existing credentials. */
export const PBKDF2_ITERS = 600_000;

/**
 * One PBKDF2-HMAC-SHA256 block (dkLen = 32, one SHA-256 output — all a
 * password hash needs). Hand-rolled to match RFC 7914 §11 test vectors.
 *
 * Vectors (RFC 7914 §11):
 *   pbkdf2-sha256("passwd", "salt", 1)           -> 55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc
 *   pbkdf2-sha256("Password", "NaCl", 80000)     -> 4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56
 */
export async function pbkdf2_sha256(
  password: string | Uint8Array,
  salt: string | Uint8Array,
  iters: number
): Promise<Uint8Array> {
  const crypto = await import("crypto");
  const pwBuf = typeof password === "string" ? new TextEncoder().encode(password) : password;
  const saltBuf = typeof salt === "string" ? new TextEncoder().encode(salt) : salt;
  return crypto.pbkdf2Sync(pwBuf, saltBuf, iters, 32, "sha256");
}

/** Hash a password for storage: `pbkdf2-sha256$<iters>$<salt>$<hash>` (hex). */
export async function hash_password(password: string): Promise<string> {
  // Generate a random 16-byte salt using Bun's RNG
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const dk = await pbkdf2_sha256(password, salt, PBKDF2_ITERS);

  const saltHex = Array.from(salt)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const dkHex = Array.from(dk)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2-sha256${PBKDF2_ITERS}${saltHex}${dkHex}`;
}

/** Verify a password against a stored hash string; malformed strings fail
 * closed. Honors the hash's own iteration count. CPU-bound (~hundreds of
 * ms by design). */
export async function verify_password(
  password: string,
  stored: string
): Promise<boolean> {
  // Parse the stored hash: pbkdf2-sha256$<iters>$<salt>$<hash>
  const parts = stored.split("$");
  if (parts.length !== 5) return false;

  const [prefix, itersStr, saltHex, storedHash, extra] = parts;
  if (prefix !== "pbkdf2-sha256") return false;
  if (extra !== "") return false; // reject extra fields

  const iters = parseInt(itersStr ?? "", 10);
  if (isNaN(iters) || iters <= 0) return false;

  // Validate salt hex format (32 hex chars = 16 bytes)
  if (!saltHex || saltHex.length !== 32) return false;
  for (let i = 0; i < 32; i++) {
    const c = saltHex.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) return false;
  }

  const salt = Uint8Array.fromHex(saltHex);
  if (salt.length !== 16) return false;

  const dk = await pbkdf2_sha256(password, salt, iters);

  const computedHash = Array.from(dk)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return ct_eq(computedHash, storedHash ?? "");
}

/** First 8 hex chars of SHA-256(password_hash): enough to bind a session to
 * a password *generation* (invalidation on change), too short to help brute
 * force the hash itself. */
export function pw_fragment(password_hash: string): string {
  return sha256_hex(password_hash).substring(0, 8);
}

/** Current time in seconds since Unix epoch. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Minimal base64 decoder (standard alphabet, optional padding) — avoids a
 * dependency for the one place we need it (HTTP Basic). */
export function base64_decode(s: string): Uint8Array | null {
  function val(c: number): number | null {
    if (c >= 65 && c <= 90) return c - 65; // A-Z
    if (c >= 97 && c <= 122) return c - 71; // a-z (26 + (c - 97))
    if (c >= 48 && c <= 57) return c + 4; // 0-9 -> 52..61
    if (c === 43) return 62; // +
    if (c === 47) return 63; // /
    return null;
  }

  // Remove '=' padding and whitespace
  let clean = s.replace(/=+$/, "").replace(/\s/g, "");

  // Check for invalid characters
  for (let i = 0; i < clean.length; i++) {
    if (val(clean.charCodeAt(i)) === null) return null;
  }

  const len = clean.length;
  if (len % 4 === 1) return null;          // one leftover sextet is impossible
  const quads = Math.floor(len / 4);
  const rem = len % 4;
  const out = new Uint8Array(quads * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0));
  let o = 0;

  // Full quads: four sextets -> exactly three bytes, no shifting.
  for (let q = 0; q < quads; q++) {
    const i = q * 4;
    const acc =
      ((val(clean.charCodeAt(i)) ?? 0) << 18) |
      ((val(clean.charCodeAt(i + 1)) ?? 0) << 12) |
      ((val(clean.charCodeAt(i + 2)) ?? 0) << 6) |
      (val(clean.charCodeAt(i + 3)) ?? 0);
    out[o++] = (acc >> 16) & 255;
    out[o++] = (acc >> 8) & 255;
    out[o++] = acc & 255;
  }

  // Tail: two sextets -> one byte, three sextets -> two bytes.
  if (rem === 2) {
    const i = quads * 4;
    out[o++] =
      ((val(clean.charCodeAt(i)) ?? 0) << 2) |
      ((val(clean.charCodeAt(i + 1)) ?? 0) >> 4);
  } else if (rem === 3) {
    const i = quads * 4;
    const acc =
      ((val(clean.charCodeAt(i)) ?? 0) << 12) |
      ((val(clean.charCodeAt(i + 1)) ?? 0) << 6) |
      (val(clean.charCodeAt(i + 2)) ?? 0);
    out[o++] = (acc >> 10) & 255;
    out[o++] = (acc >> 2) & 255;
  }

  return out;
}

/** Value of a single ASCII hex digit, or None. */
export function hex_val(b: number): number | null {
  if (b >= 48 && b <= 57) return b - 48; // 0-9
  if (b >= 97 && b <= 102) return b - 87; // a-f
  if (b >= 65 && b <= 70) return b - 55; // A-F
  return null;
}

/** Extend Uint8Array with fromHex helper */
if (!Uint8Array.fromHex) {
  Uint8Array.fromHex = function (hex: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = ((hex_val(hex.charCodeAt(i)) ?? 0) << 4) | (hex_val(hex.charCodeAt(i + 1)) ?? 0);
    }
    return bytes;
  };
}

/** Parse a single field from an application/x-www-form-urlencoded body. */
export function form_field(body: string, field: string): string | null {
  for (const pair of body.split("&")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const k = pair.substring(0, idx);
    const v = pair.substring(idx + 1);
    if (k === field) {
      // Simple URL decode: + becomes space, %XX decoded
      let decoded = v.replace(/\+/g, " ");
      decoded = decoded.replace(/%([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      return decoded;
    }
  }
  return null;
}

/** URL-decode a string, surviving multibyte and malformed escapes. */
export function url_decode(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 37 && i + 2 < s.length) {
      // %XX escape
      const hi = s.charCodeAt(i + 1);
      const lo = s.charCodeAt(i + 2);
      if (
        ((hi >= 48 && hi <= 57) || (hi >= 65 && hi <= 70) || (hi >= 97 && hi <= 102)) &&
        ((lo >= 48 && lo <= 57) || (lo >= 65 && lo <= 70) || (lo >= 97 && lo <= 102))
      ) {
        out += String.fromCharCode(
          ((hex_val(hi) ?? 0) << 4) | (hex_val(lo) ?? 0)
        );
        i += 3;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}