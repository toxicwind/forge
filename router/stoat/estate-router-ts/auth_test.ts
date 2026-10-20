// Deterministic tests for the operator-auth port
// (flock proxy/src/auth.rs -> router_auth.ts).
// Run: bun auth_test.ts
import {
  Admin,
  MemoryUserStore,
  BURNER_HASH,
  COOKIE_NAME,
  PBKDF2_ITERS,
  SESSION_TTL_SECS,
  THROTTLE_MAX_FAILURES,
  THROTTLE_WINDOW_SECS,
  base64DecodeStrict,
  cookieToken,
  ctEq,
  formField,
  handleLogin,
  handleLogout,
  hashPassword,
  hexDecode,
  hexEncode,
  identifyRequest,
  nowSecs,
  pbkdf2Sha256,
  sha256Hex,
  urlDecode,
  verifyPassword,
} from "./router_auth.ts";

let passed = 0;
function ok(cond: boolean, name: string): void {
  if (!cond) {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok - ${name}`);
}

const T0 = 1_700_000_000;

function admin(trustProxy = false): Admin {
  return new Admin(trustProxy);
}
function storeWith(username: string, passwordHash: string): MemoryUserStore {
  return new MemoryUserStore([{ username, passwordHash, role: "admin" }]);
}

// 1. sha256 helper
ok(
  sha256Hex("abc") ===
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "sha256Hex matches the known vector",
);

// 2. constant-time compare
ok(ctEq("abc", "abc"), "ctEq: equal strings");
ok(!ctEq("abc", "abd"), "ctEq: different content");
ok(!ctEq("abc", "abcd"), "ctEq: different length");
ok(!ctEq("", "x"), "ctEq: empty vs non-empty");

// 3. PBKDF2-HMAC-SHA256 matches RFC 7914 §11 vectors (first 32 bytes)
ok(
  hexEncode(await pbkdf2Sha256("passwd", Buffer.from("salt"), 1)) ===
    "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc",
  "pbkdf2 RFC7914 vector 1",
);
ok(
  hexEncode(await pbkdf2Sha256("Password", Buffer.from("NaCl"), 80_000)) ===
    "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56",
  "pbkdf2 RFC7914 vector 2 (80k iters)",
);

// 4. hash format: pbkdf2-sha256$600000$<salt>$<hash>
{
  const h = await hashPassword("correct horse");
  ok(h.startsWith(`pbkdf2-sha256$${PBKDF2_ITERS}$`), "new hash uses 600k iters");
  const parts = h.split("$");
  ok(parts.length === 4, "hash has exactly 4 $-separated fields");
  ok(parts[2].length === 32 && hexDecode(parts[2]) !== null, "salt is 16 bytes hex");
  ok(parts[3].length === 64 && hexDecode(parts[3]) !== null, "dk is 32 bytes hex");
  ok(await verifyPassword("correct horse", h), "hash round-trips");
  ok(!(await verifyPassword("wrong horse", h)), "wrong password rejected");
  ok(h !== (await hashPassword("correct horse")), "salts are random");
}

// 5. verification honors the stored iteration count (cheap fixtures)
{
  const fixture = await hashPassword("hunter22", 1_000);
  ok(fixture.startsWith("pbkdf2-sha256$1000$"), "fixture carries its own count");
  ok(await verifyPassword("hunter22", fixture), "low-iter fixture verifies");
  ok(!(await verifyPassword("hunter23", fixture)), "low-iter fixture rejects wrong");
  const tampered = fixture.replace("$1000$", "$999999$");
  ok(!(await verifyPassword("hunter22", tampered)), "tampered iter count fails");
}

// 6. malformed hash strings fail closed
for (const bad of [
  "",
  "plaintext",
  "pbkdf2-sha256$0$aa$bb", // zero iterations
  "pbkdf2-sha256$x$aa$bb", // non-numeric iterations
  "pbkdf2-sha256$1000$zz$bb", // bad salt hex
  "pbkdf2-sha256$1000$aa", // missing field
  "pbkdf2-sha256$1000$aa$bb$cc", // extra field
  "scrypt$1000$aa$bb", // unknown scheme
]) {
  ok(!(await verifyPassword("x", bad)), `malformed hash rejected: ${bad || "(empty)"}`);
}

// 7. session sign/verify round-trip carries identity
{
  const a = admin();
  const sc = storeWith("alice", "hash-v1");
  const tok = a.signSession(T0 + 100, "alice", "hash-v1");
  ok(a.verifySession(tok, sc, T0) === "alice", "valid session round-trips");
  ok(tok.split(".").length === 4, "token has exactly 4 dotted parts");
}

// 8. malformed token shapes rejected
{
  const a = admin();
  const sc = storeWith("alice", "hash-v1");
  ok(a.verifySession("a.b.c", sc, T0) === null, "3-part token rejected");
  ok(a.verifySession("too.many.dots.here.and.more", sc, T0) === null, "6-part token rejected");
  ok(a.verifySession("", sc, T0) === null, "empty token rejected");
}

// 9. expired session rejected
{
  const a = admin();
  const sc = storeWith("alice", "hash-v1");
  ok(a.verifySession(a.signSession(T0 - 1, "alice", "hash-v1"), sc, T0) === null, "expired session rejected");
}

// 10. tampered tag rejected
{
  const a = admin();
  const sc = storeWith("alice", "hash-v1");
  const tok = a.signSession(T0 + 100, "alice", "hash-v1");
  const last = tok.length - 1;
  const tampered = tok.slice(0, last) + (tok[last] === "a" ? "b" : "a");
  ok(a.verifySession(tampered, sc, T0) === null, "tampered tag rejected");
}

// 11. per-boot key: sessions die on restart, foreign keys rejected
{
  const a = admin();
  const b = admin(); // different random signing key ( = a restart)
  const sc = storeWith("alice", "hash-v1");
  const tok = a.signSession(T0 + 100, "alice", "hash-v1");
  ok(b.verifySession(tok, sc, T0) === null, "session from another boot rejected");
  ok(a.signingKey.toString("hex") !== b.signingKey.toString("hex"), "signing keys are random per boot");
}

// 12. password change invalidates existing sessions (fingerprint binding)
{
  const a = admin();
  const tok = a.signSession(T0 + 100, "alice", "hash-v1");
  const rotated = storeWith("alice", "hash-v2");
  ok(a.verifySession(tok, rotated, T0) === null, "password change kills sessions");
}

// 13. deleted user rejected
{
  const a = admin();
  const tok = a.signSession(T0 + 100, "alice", "hash-v1");
  const sc = storeWith("bob", "hash-v1");
  ok(a.verifySession(tok, sc, T0) === null, "deleted user session rejected");
}

// 14. username is authenticated, not just parsed
{
  const a = admin();
  const sc = new MemoryUserStore([
    { username: "alice", passwordHash: "h", role: "user" },
    { username: "admin", passwordHash: "h", role: "admin" },
  ]);
  const tok = a.signSession(T0 + 100, "alice", "h");
  const parts = tok.split(".");
  parts[1] = Buffer.from("admin", "utf8").toString("hex");
  ok(a.verifySession(parts.join("."), sc, T0) === null, "re-labeled username rejected");
}

// 15. throttle: fixed 60s window, >10 failures
{
  const a = admin();
  a.throttle.windowStart = T0; // pin the fake clock (constructor uses real now)
  for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) {
    ok(!a.noteFailure(T0), `failure ${i + 1} not yet throttled`);
  }
  ok(a.noteFailure(T0), "11th failure trips the throttle");
  ok(a.isThrottled(T0), "isThrottled true inside the window");
  ok(!a.isThrottled(T0 + THROTTLE_WINDOW_SECS + 1), "throttle clears after the window");
}

// 16. throttle window rollover resets the counter
{
  const a = admin();
  a.throttle.windowStart = T0 - THROTTLE_WINDOW_SECS - 1;
  a.throttle.failures = 10_000;
  ok(!a.noteFailure(T0), "rolled-over window resets the counter");
}

// 17. pre-auth admission counts before rejecting excess attempts
{
  const a = admin();
  for (let i = 0; i <= THROTTLE_MAX_FAILURES; i++) {
    ok(a.admitPreAuthAttempt(T0), `pre-auth attempt ${i + 1} admitted`);
  }
  ok(!a.admitPreAuthAttempt(T0), "12th pre-auth attempt rejected");
}

// 18. rejected pre-auth work never runs
{
  const a = admin();
  for (let i = 0; i <= THROTTLE_MAX_FAILURES; i++) a.admitPreAuthAttempt(T0);
  let ran = false;
  ok(a.admitPreAuthWork(() => { ran = true; return 1; }, T0) === null, "throttled work returns null");
  ok(!ran, "throttled work never runs");
  const b = admin();
  let ran2 = false;
  ok(b.admitPreAuthWork(() => { ran2 = true; return 7; }, T0) === 7, "admitted work runs and returns");
  ok(ran2, "admitted work ran");
}

// 19. scraper memo: digest round-trip, clear, never raw
{
  const a = admin();
  ok(a.memoHit("alice:pw") === null, "memo starts empty");
  a.memoize("alice:pw", "alice");
  ok(a.memoHit("alice:pw") === "alice", "memo hits");
  ok(a.memoHit("alice:other") === null, "different cred misses");
  const tagHex = a.memoTagHex();
  ok(!!tagHex && tagHex.length === 64, "memo stores a 32-byte digest");
  ok(!tagHex!.includes("alice:pw"), "memo never retains the raw credential");
  a.clearScraperMemo();
  ok(a.memoHit("alice:pw") === null, "clearScraperMemo clears");
}

// 20. cookie attributes
{
  const https = "https";
  const c1 = admin(true).buildSetCookie("tok", 3600, https);
  ok(c1.includes("; Secure"), "Secure set behind trusted https proxy");
  ok(!admin(false).buildSetCookie("tok", 3600, https).includes("; Secure"), "untrusted proxy header ignored");
  ok(!admin(true).buildSetCookie("tok", 3600, "http").includes("; Secure"), "plain http gets no Secure");
  ok(!admin(true).buildSetCookie("tok", 3600, null).includes("; Secure"), "missing proto gets no Secure");
  ok(admin(true).buildSetCookie("tok", 3600, "HTTPS").includes("; Secure"), "proto match is case-insensitive");
  const c2 = admin().buildSetCookie("tok", 3600, null);
  for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=3600"]) {
    ok(c2.includes(attr), `cookie carries ${attr}`);
  }
  ok(c2.startsWith(`${COOKIE_NAME}=tok;`), "cookie uses the session name");
}

// 21. identify via session cookie
{
  const a = admin();
  const realNow = nowSecs();
  const sc = storeWith("alice", await hashPassword("secret", 1_000));
  const setCookie = a.mintSessionCookie("alice", (await sc.getUser("alice"))!.passwordHash, null, realNow);
  const token = cookieToken(setCookie.split(";")[0]);
  ok(!!token, "minted cookie parses");
  const req = new Request("http://x/ui", { headers: { cookie: `${COOKIE_NAME}=${token}` } });
  const id = await identifyRequest(req, a, sc);
  ok(id?.username === "alice" && id?.role === "admin", "cookie identity resolves with role");
  // TTL baked into the token: minted for realNow+12h, dead after
  ok(a.verifySession(token!, sc, realNow) === "alice", "session valid inside TTL");
  ok(a.verifySession(token!, sc, realNow + SESSION_TTL_SECS + 1) === null, "12h TTL enforced");
}

// 22. identify via Bearer user:pass
{
  const a = admin();
  const sc = storeWith("alice", await hashPassword("secret", 1_000));
  const req = new Request("http://x/metrics", { headers: { authorization: "Bearer alice:secret" } });
  const id = await identifyRequest(req, a, sc);
  ok(id?.username === "alice", "bearer user:pass identifies");
  // second poll hits the digest memo (no raw creds retained)
  const id2 = await identifyRequest(req, a, sc);
  ok(id2?.username === "alice", "bearer identity memoizes");
  ok(!a.memoTagHex()!.includes("alice:secret"), "memoized credential is a digest");
}

// 23. identify via HTTP Basic
{
  const a = admin();
  const sc = storeWith("alice", await hashPassword("secret", 1_000));
  const basic = Buffer.from("alice:secret", "utf8").toString("base64");
  const req = new Request("http://x/metrics", { headers: { authorization: `Basic ${basic}` } });
  ok((await identifyRequest(req, a, sc))?.username === "alice", "basic auth identifies");
}

// 24. identify rejects bad credentials
{
  const a = admin();
  const sc = storeWith("alice", await hashPassword("secret", 1_000));
  const bad1 = new Request("http://x/", { headers: { authorization: "Bearer alice:wrong" } });
  ok((await identifyRequest(bad1, a, sc)) === null, "wrong password rejected");
  const bad2 = new Request("http://x/", { headers: { authorization: "Bearer mallory:secret" } });
  ok((await identifyRequest(bad2, a, sc)) === null, "unknown user rejected");
  const bad3 = new Request("http://x/", { headers: { authorization: "Digest xyz" } });
  ok((await identifyRequest(bad3, a, sc)) === null, "non-bearer/basic scheme rejected");
  const bad4 = new Request("http://x/", { headers: { authorization: "Bearer nocolonhere" } });
  ok((await identifyRequest(bad4, a, sc)) === null, "credential without colon rejected");
  const bad5 = new Request("http://x/");
  ok((await identifyRequest(bad5, a, sc)) === null, "missing auth rejected");
}

// 25. strict base64
{
  ok(Buffer.from(base64DecodeStrict("dXNlcjpwYXNz")!).toString() === "user:pass", "base64 round-trips");
  ok(Buffer.from(base64DecodeStrict("TWE=")!).toString() === "Ma", "padded tail decodes");
  ok(Buffer.from(base64DecodeStrict("+AAA")!).toString("hex") === "f80000", "alphabet slot 62");
  ok(Buffer.from(base64DecodeStrict("/AAA")!).toString("hex") === "fc0000", "alphabet slot 63");
  ok(base64DecodeStrict("ab*c") === null, "garbage rejected");
  ok(base64DecodeStrict("A") === null, "lone char rejected");
}

// 26. form parsing
{
  ok(formField("password=hunter2", "password") === "hunter2", "form field parses");
  ok(formField("a=1&password=p%40ss", "password") === "p@ss", "percent escape decodes");
  ok(urlDecode("p%40ss+word") === "p@ss word", "urlDecode handles escapes and plus");
  ok(urlDecode("%") === "%", "truncated escape passes through");
  ok(urlDecode("%€") === "%€", "multibyte after % never panics");
}

// 27. POST /auth/login success sets a session cookie (JSON + form)
{
  const a = admin();
  const sc = storeWith("alice", await hashPassword("secret", 1_000));
  const req = new Request("http://x/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "secret" }),
  });
  const res = await handleLogin(req, a, sc);
  ok(res.status === 200, "login 200");
  const sc2 = res.headers.get("set-cookie") || "";
  ok(sc2.includes("HttpOnly") && sc2.includes(`${COOKIE_NAME}=`), "login sets the session cookie");
  const body = (await res.json()) as { user?: string };
  ok(body.user === "alice", "login body carries the username");
  const formReq = new Request("http://x/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=alice&password=secret",
  });
  ok((await handleLogin(formReq, a, sc)).status === 200, "form login works");
}

// 28. login failure is 401 and throttles toward 429
{
  const a = admin();
  const sc = storeWith("alice", await hashPassword("secret", 1_000));
  const bad = new Request("http://x/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "nope" }),
  });
  ok((await handleLogin(bad, a, sc)).status === 401, "wrong password is 401");
  const unknown = new Request("http://x/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "mallory", password: "x" }),
  });
  ok((await handleLogin(unknown, a, sc)).status === 401, "unknown user is 401 (burner hash)");
  for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) a.noteFailure();
  const throttled = await handleLogin(bad, a, sc);
  ok(throttled.status === 429, "throttled login is 429");
  ok(throttled.headers.get("retry-after") === "60", "429 carries Retry-After: 60");
}

// 29. logout clears the cookie
{
  const a = admin();
  const res = handleLogout(a, new Request("http://x/auth/logout", { method: "POST" }));
  ok(res.status === 200, "logout 200");
  ok((res.headers.get("set-cookie") || "").includes("Max-Age=0"), "logout clears the cookie");
}

// 30. burner hash is a real 600k hash (timing parity for unknown users)
{
  ok(BURNER_HASH.startsWith(`pbkdf2-sha256$${PBKDF2_ITERS}$`), "burner uses 600k iters");
  ok(!(await verifyPassword("anything", BURNER_HASH)), "burner never verifies");
}

console.log(`\n${passed} auth tests passed`);
