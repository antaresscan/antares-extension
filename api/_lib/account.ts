// api/_lib/account.ts — Email + password accounts, scrypt-hashed passwords,
// HMAC-SHA256 JWT sessions. Zero-dep on top of node:crypto so we don't
// have to add bcrypt or jose to the bundle.
//
// Storage in Redis (keys.ts holds the catalogue):
//   account:<email_lc>            HASH
//     id, email, passwordHash, createdAt, emailVerified, sessionVersion, verifyNonce, verifySentAt
//   account:install:<install_id>  STRING → email_lc
//     which account an install belongs to
//
// Sessions are JWTs signed with SESSION_SECRET (env var), carrying {sub: email_lc, iat, exp, sv}. `sv` is the account's
// sessionVersion when the token was signed: raising it (revokeAllSessions, "log out everywhere") refuses every older token at once.
//
// Password hashing is scrypt (N=16384): about 50 ms of CPU. The request paths use the ASYNC form (hashPasswordAsync /
// verifyPasswordAsync), which runs on libuv's thread pool: the synchronous form blocks the event loop for those 50 ms, and an
// instance that serves several requests at once (Vercel's concurrent functions) would make every other request wait.

import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHmac, createHash, type ScryptOptions } from "node:crypto";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";
import { emailRef, maskLicenseKey } from "./log-ref";
import { issueLicense, normalizeEmail, type License } from "./license";
import { PENDING_ACCOUNT_TTL_SECONDS } from "./email-proof";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  email: string;
  /** scrypt$<salt-hex>$<derived-hex> */
  passwordHash: string;
  createdAt: number;
  emailVerified: boolean;
  /**
   * "Log out everywhere" (audit A-12): a session token only counts while it carries THIS number. revokeAllSessions raises it, and every
   * token signed before stops working at once. An account that predates it has none stored, which reads as 0. A new account starts at the
   * time of its creation (ms), see createAccount.
   */
  sessionVersion: number;
  /**
   * E-mail proof (audit A-01): the secret half of the confirmation link, "n" + 32 hex. Present from the creation of the account until the owner
   * confirms; the link carries it, and a link only works while it equals this. (The letter in front keeps Redis from handing it back as a number.)
   */
  verifyNonce?: string;
  /** When the last confirmation e-mail was sent (ms), 0 when none: the cooldown between two sends. */
  verifySentAt: number;
}

export interface SessionPayload {
  sub: string; // email_lc
  exp: number; // epoch-seconds
  iat: number;
  /** The account's sessionVersion when the token was signed. A token signed before the number existed carries none: it reads as 0. */
  sv?: number;
  /**
   * When the password was typed (epoch seconds), for a token re-issued from another one (/api/auth/sync-token): the re-issue keeps it,
   * so no chain of re-issues outlives SESSION_MAX_AGE_SECONDS after the sign-in. A token signed before the field existed carries none:
   * its iat stands in.
   */
  auth?: number;
}

// ─── Redis keys ───────────────────────────────────────────────────────────────

// The keys are defined once, in keys.ts; they are still exported from here for the modules that import them from this file.
import { ACCOUNT_KEY, ACCOUNT_INSTALL_KEY, ACCOUNT_CREATE_LOCK_KEY } from "./keys";
export { ACCOUNT_KEY, ACCOUNT_INSTALL_KEY };

// ─── Password hashing (scrypt) ────────────────────────────────────────────────

const SCRYPT_N = 16384; // CPU cost (default 16384, gives ~50ms hash on Vercel)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 16;
const SCRYPT_OPTIONS: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
/** The longest password accepted. hashPassword refuses longer ones, so a longer one can never match: it is refused before any hashing. */
const PASSWORD_MAX_LENGTH = 256;

function checkNewPassword(plain: unknown): asserts plain is string {
  if (typeof plain !== "string" || plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    throw new Error("password too long");
  }
}

/** A stored hash split into its parts, or null when it is not one of ours ("scrypt$<salt-hex>$<derived-hex>", 64-byte derived key). */
function parseStoredHash(stored: string): { salt: Buffer; expected: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  return expected.length === SCRYPT_KEYLEN && salt.length > 0 ? { salt, expected } : null;
}

const scryptAsync = (plain: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** Synchronous hash. Kept for the callers and tests that have not moved to hashPasswordAsync; a request path should not use it (it blocks). */
export function hashPassword(plain: string): string {
  checkNewPassword(plain);
  const salt = randomBytes(SCRYPT_SALTLEN);
  const derived = scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** The hash to store for a new password, computed off the event loop. Same format and rules as hashPassword. */
export async function hashPasswordAsync(plain: string): Promise<string> {
  checkNewPassword(plain);
  const salt = randomBytes(SCRYPT_SALTLEN);
  const derived = await scryptAsync(plain, salt);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Synchronous check. Kept for the callers and tests that have not moved to verifyPasswordAsync; a request path should not use it. */
export function verifyPassword(plain: string, stored: string): boolean {
  if (typeof plain !== "string" || typeof stored !== "string" || plain.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  try {
    return timingSafeEqual(scryptSync(plain, parsed.salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS), parsed.expected);
  } catch {
    return false;
  }
}

/** Does `plain` match the stored hash? Computed off the event loop; never throws (a malformed hash is simply no match). */
export async function verifyPasswordAsync(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== "string" || typeof stored !== "string" || plain.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  try {
    return timingSafeEqual(await scryptAsync(plain, parsed.salt), parsed.expected);
  } catch {
    return false;
  }
}

// ─── JWT (HMAC-SHA256) ────────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  let str = s.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

// Domain-separated derivation salt for the bootstrap fallback path
// (see getSessionSecret below). Hard-coded by design: changing this
// rotates every session previously issued via the fallback, which is
// useful operational lever — a deploy with a different value forces
// re-login without touching env vars.
const SESSION_SECRET_DERIVATION_INFO = "antares-session-secret-v1";

/**
 * Resolve the HMAC key used to sign session JWTs.
 *
 * Resolution order:
 *   1. process.env.SESSION_SECRET (≥32 chars) — production-correct path.
 *      Operators should always set this explicitly; rotate by `vercel
 *      env rm SESSION_SECRET production && vercel env add ...` and
 *      redeploy.
 *
 *   2. Bootstrap fallback derived from UPSTASH_REDIS_REST_TOKEN via
 *      HMAC-SHA256 with a domain-separated info string. Used when the
 *      operator hasn't explicitly set SESSION_SECRET on a fresh
 *      deployment (e.g. the antares-extension Vercel project before
 *      first `setup-auth.sh` run). This unblocks signup/login from day
 *      one — every deployment that has Redis configured (which is
 *      mandatory for any storage anyway) gets a working auth secret.
 *
 *      Trade-off: session integrity becomes coupled to the Redis
 *      token's secrecy. If the Redis token leaks, attackers can forge
 *      sessions. We log a `warn` line per `getSessionSecret` call so
 *      operators see this in dashboards and rotate to an explicit
 *      `SESSION_SECRET` quickly.
 *
 *      Migrating to an explicit SESSION_SECRET later invalidates
 *      every session issued via the fallback — users get logged out
 *      and re-authenticate. Acceptable cost for unblocking auth on
 *      day one.
 *
 *   3. Throw — unrecoverable. The only way to hit this is a deployment
 *      with neither `SESSION_SECRET` nor `UPSTASH_REDIS_REST_TOKEN`
 *      set, which means there's no Redis either, which means storage
 *      is broken and signup wouldn't work regardless.
 */
// Memoised at module level: getSessionSecret is called on every auth
// request (signSession + verifySession) and the resolution path is
// constant for the lifetime of a serverless invocation. Without this
// cache the bootstrap-fallback `logger.warn` previously fired on every
// request, spamming Sentry breadcrumbs. With the cache it fires once
// per cold start — visible enough to act on, quiet enough to read.
let cachedSessionSecret: Buffer | null = null;

function getSessionSecret(): Buffer {
  if (cachedSessionSecret) return cachedSessionSecret;

  const explicit = process.env.SESSION_SECRET;
  if (typeof explicit === "string" && explicit.length >= 32) {
    cachedSessionSecret = Buffer.from(explicit, "utf8");
    return cachedSessionSecret;
  }

  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (typeof redisToken === "string" && redisToken.length >= 32) {
    // Once-per-cold-start (memoised below). The warning is intentionally
    // loud — the bootstrap fallback was meant as a 5-minute unblocker on
    // a fresh Vercel project, not as a production posture. If this line
    // ever appears in production Sentry, set SESSION_SECRET explicitly
    // and redeploy: existing sessions get invalidated (users re-login
    // once) and the auth surface decouples from Redis token secrecy.
    // A SESSION_SECRET that IS set but too short lands here too: the message says which case it is, so it is not read as "missing".
    const why = typeof explicit === "string" && explicit.length > 0
      ? `SESSION_SECRET is set but has ${explicit.length} characters (32 needed)`
      : "SESSION_SECRET not set";
    logger.warn(
      "auth",
      `${why} — using bootstrap fallback derived from UPSTASH_REDIS_REST_TOKEN. Set a SESSION_SECRET of 32+ characters (\`openssl rand -hex 32\`) via the Vercel dashboard or \`vercel env add SESSION_SECRET production\`. Session-forge risk if the Upstash token leaks.`,
    );
    cachedSessionSecret = createHmac("sha256", redisToken)
      .update(SESSION_SECRET_DERIVATION_INFO)
      .digest();
    return cachedSessionSecret;
  }

  throw new Error(
    "Auth not configured: set SESSION_SECRET (32+ chars) on the deployment, or ensure UPSTASH_REDIS_REST_TOKEN is set so the bootstrap fallback can derive one. Generate a SESSION_SECRET with `openssl rand -hex 32`.",
  );
}

/**
 * Test-only helper. Production callers should never reach the cache.
 * Vitest reuses module state across tests in the same file, so a test
 * that flips SESSION_SECRET env vars must reset this before re-reading.
 */
export function _resetSessionSecretCacheForTests(): void {
  cachedSessionSecret = null;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
/**
 * The longest a session lives after the password was typed, re-issues included: the 30-day cookie of the sign-in, then the 30-day token
 * that sync-token signs from it on its last day. Without this bound, a token handed to sync-token came back as a fresh 30-day token, again
 * and again: a stolen token never died (only "log out everywhere" stopped it).
 */
export const SESSION_MAX_AGE_SECONDS = 2 * SESSION_TTL_SECONDS;

/**
 * Signs a session token. `signedInAt` (epoch ms) is when the password was typed: omitted for a sign-in (it is `now`), given by a re-issue
 * (sync-token passes the one of the token it was shown, see signedInAtOf).
 */
export function signSession(emailLc: string, now: number = Date.now(), sessionVersion: number = 0, signedInAt: number = now): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: SessionPayload = {
    sub: emailLc,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
    sv: sessionVersion,
    auth: Math.floor(Math.min(signedInAt, now) / 1000),
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const data = `${header}.${payloadB64}`;
  const sig = createHmac("sha256", getSessionSecret()).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

export function verifySession(token: string, now: number = Date.now()): SessionPayload | null {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  // Recompute signature and constant-time compare.
  const expectedSig = createHmac("sha256", getSessionSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let providedSig: Buffer;
  try {
    providedSig = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;
  // Decode and validate payload.
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 < now) return null;
  // The session number, when there is one, is a whole number from 0 up. Anything else is not a token we signed.
  if (payload.sv !== undefined && !(Number.isInteger(payload.sv) && payload.sv >= 0)) return null;
  // However it was re-issued, a session ends SESSION_MAX_AGE_SECONDS after the password was typed.
  const signedIn = signedInAtOf(payload);
  if (signedIn === null || signedIn + SESSION_MAX_AGE_SECONDS * 1000 < now) return null;
  return payload;
}

/** When the password of this session was typed (epoch ms): its `auth`, or its iat for a token signed before `auth` existed. null when neither is a number. */
export function signedInAtOf(payload: Pick<SessionPayload, "auth" | "iat">): number | null {
  const seconds = typeof payload.auth === "number" ? payload.auth : payload.iat;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** A session number as read from Redis: a string ("2") or, when the client deserialises, a number (2). Absent or garbage = 0. */
export function parseSessionVersion(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Does this signed token still belong to the account's current sessions? A token signed before "log out everywhere" existed carries no
 * number, which reads as 0: the number of every account until its first revocation, so nobody is logged out by the deployment of this check.
 */
export function isCurrentSession(payload: SessionPayload, account: Account): boolean {
  return (payload.sv ?? 0) === account.sessionVersion;
}

// ─── Account CRUD ─────────────────────────────────────────────────────────────

export type CreateAccountOutcome =
  | { ok: true; account: Account }
  | { ok: false; reason: "invalid_email" | "weak_password" }
  /** `existing` is the account that holds the address (null when another sign-up for it was in flight at the same moment). */
  | { ok: false; reason: "already_exists"; existing: Account | null };

const CREATE_LOCK_SECONDS = 20;

/** The e-mail as it appears in a key name: its SHA-256, never the address. */
const emailSha256 = (emailLc: string) => createHash("sha256").update(emailLc).digest("hex");

/**
 * Creates the account of a sign-up, UNCONFIRMED (audit A-01): it has a confirmation secret (verifyNonce), it is deleted by Redis after
 * PENDING_ACCOUNT_TTL_SECONDS if nobody confirms it, and until it is confirmed it owns no licence (email-proof.ts).
 *
 * The first sign-up for an address holds it: a second sign-up never replaces the password of an existing account, confirmed or not (that
 * would let anybody take over an address between its owner's sign-up and the click on the link). An address that already has an account
 * comes back as `already_exists` WITH that account, so that the caller can answer the same thing in every case and send the right e-mail.
 * Two sign-ups for one address at the same moment are serialised by a 20 s mutex: the loser is told `already_exists` with no account.
 */
export async function createAccount(
  redis: Redis,
  params: { email: string; password: string },
): Promise<CreateAccountOutcome> {
  const email = normalizeEmail(params.email);
  if (!email) return { ok: false, reason: "invalid_email" };
  if (typeof params.password !== "string" || params.password.length < 8) {
    return { ok: false, reason: "weak_password" };
  }

  const lockKey = ACCOUNT_CREATE_LOCK_KEY(emailSha256(email));
  const locked = await redis.set(lockKey, "1", { nx: true, ex: CREATE_LOCK_SECONDS });
  if (!locked) return { ok: false, reason: "already_exists", existing: null };
  try {
    const existing = await getAccount(redis, email);
    if (existing) return { ok: false, reason: "already_exists", existing };

    let passwordHash: string;
    try {
      passwordHash = await hashPasswordAsync(params.password);
    } catch {
      return { ok: false, reason: "weak_password" };
    }

    const now = Date.now();
    const account: Account = {
      id: randomBytes(16).toString("hex"),
      email,
      passwordHash,
      createdAt: now,
      emailVerified: false,
      // Not 0: an account that was deleted (A-14b) and is created again with the same e-mail must not honour the tokens of the old one, which
      // are signed with the same e-mail and live 30 days. A start at the moment of creation can never equal the number of an older account.
      sessionVersion: now,
      verifyNonce: newVerifyNonce(),
      verifySentAt: 0,
    };

    // One transaction: the account and its expiry appear together, so a crash cannot leave an unconfirmed account that never expires.
    await redis
      .multi()
      .hset(ACCOUNT_KEY(email), {
        id: account.id,
        email: account.email,
        passwordHash: account.passwordHash,
        createdAt: String(account.createdAt),
        emailVerified: "0",
        sessionVersion: String(account.sessionVersion),
        verifyNonce: account.verifyNonce as string,
        verifySentAt: "0",
      })
      .expire(ACCOUNT_KEY(email), PENDING_ACCOUNT_TTL_SECONDS)
      .exec();

    logger.info("account", "created (unconfirmed)", { emailRef: emailRef(email) });
    return { ok: true, account };
  } finally {
    try { await redis.del(lockKey); } catch { /* it expires by itself */ }
  }
}

/** A fresh confirmation secret: "n" + 32 hex. The letter keeps it from being all digits, which Redis would hand back as a number. */
export function newVerifyNonce(): string {
  return `n${randomBytes(16).toString("hex")}`;
}

/**
 * A key for one purpose, derived from the session secret with its own label (domain separation): the confirmation links are signed with
 * deriveKey("antares-email-verify-v1"), so a link can never pass for a session token and a session token never for a link.
 */
export function deriveKey(label: string): Buffer {
  return createHmac("sha256", getSessionSecret()).update(label).digest();
}

export async function getAccount(
  redis: Redis,
  email: string,
): Promise<Account | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const raw = await redis.hgetall<Record<string, unknown>>(ACCOUNT_KEY(norm));
  if (!raw || !raw.email) return null;
  const nonce = raw.verifyNonce === undefined || raw.verifyNonce === null || raw.verifyNonce === "" ? undefined : String(raw.verifyNonce);
  return {
    id: String(raw.id),
    email: String(raw.email),
    passwordHash: String(raw.passwordHash),
    createdAt: Number(raw.createdAt) || 0,
    // Redis may hand "1" back as the number 1 (Upstash deserialises): compare as text, or a confirmed account would read as unconfirmed.
    emailVerified: String(raw.emailVerified) === "1",
    sessionVersion: parseSessionVersion(raw.sessionVersion),
    verifyNonce: nonce,
    verifySentAt: Number(raw.verifySentAt) || 0,
  };
}

/**
 * Logs the account out of EVERY browser and install: raises its session number, so every token signed before (the 30-day cookie, the copy the
 * extension keeps, a stolen one) is refused from the next request on. Returns the new number, or null when there is no such account
 * (HINCRBY would otherwise create a hash holding only the counter).
 */
export async function revokeAllSessions(redis: Redis, email: string): Promise<number | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const key = ACCOUNT_KEY(norm);
  if (!(await redis.hget(key, "email"))) return null;
  const next = Number(await redis.hincrby(key, "sessionVersion", 1));
  // The account may have been erased between the two commands (a "delete my account" at the same moment): HINCRBY then created a hash
  // that holds only the counter, an orphan with no expiry. Look once more and remove it.
  if (!(await redis.hget(key, "email"))) {
    await redis.del(key);
    return null;
  }
  logger.info("account", "sessions revoked", { emailRef: emailRef(norm), sessionVersion: next });
  return next;
}

export type AuthOutcome =
  | { ok: true; account: Account }
  | { ok: false; reason: "invalid_credentials" };

export async function authenticate(
  redis: Redis,
  params: { email: string; password: string },
): Promise<AuthOutcome> {
  const account = await getAccount(redis, params.email);
  if (!account) {
    // The same ~50 ms of hashing as a real check, so that the time of the answer does not tell whether the account exists.
    await verifyPasswordAsync(TIMING_DECOY_PASSWORD, TIMING_DECOY_HASH);
    return { ok: false, reason: "invalid_credentials" };
  }
  const ok = await verifyPasswordAsync(params.password, account.passwordHash);
  if (!ok) return { ok: false, reason: "invalid_credentials" };
  return { ok: true, account };
}

/** A fixed, valid hash for the "no such account" path: verifying against it costs exactly what verifying a real password costs. */
const TIMING_DECOY_PASSWORD = "timing-decoy-never-a-real-password";
const TIMING_DECOY_HASH = `scrypt$${"00".repeat(SCRYPT_SALTLEN)}$${"00".repeat(SCRYPT_KEYLEN)}`;

// ─── Dev Lifetime grant ───────────────────────────────────────────────────────
//
// Some accounts (the founder, contributors, QA) need to use the
// extension on the Pro/Lifetime tier without going through a real
// Solana payment. Mirror of the install-based DEV_PRO_INSTALLS env
// var in user.ts, but keyed by email so it survives extension
// re-installs and works for any device the developer logs in from.
//
// Resolution: the DEV_LIFETIME_EMAILS env var, comma-separated, normalised (there is no list in the code: see below).
// The grant is only made once the e-mail is PROVEN (email-proof.ts), by the callers in api/auth/[action].ts.
//
// On the auth handler's success path (signup + login), if the email
// matches we call ensureDevLifetimeLicense() — that issues a real
// Lifetime licence keyed to the email if one doesn't already exist.
// The dev then sees it on /account.html and pastes the key into the
// extension exactly like a paying user would. Same redeem path, same
// idempotency, same Pro-tier behaviour after redeem.

// Configure dev/founder grants exclusively via DEV_LIFETIME_EMAILS in the
// deployment env (comma-separated). Keeping the list out of source code
// removes the public attack-surface signal "this is the founder's auto-
// grant address — phish/credential-stuff this account" that a hardcoded
// list in a published repo provided. Operators set `DEV_LIFETIME_EMAILS`
// once per Vercel project; missing env var = no auto-grant (paid flow
// still works for the same email if they pay normally).
function getDevLifetimeEmails(): Set<string> {
  const fromEnv = (process.env.DEV_LIFETIME_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(fromEnv);
}

export function isDevLifetimeEmail(email: string): boolean {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  return getDevLifetimeEmails().has(norm);
}

/**
 * Idempotently issue a Yearly licence to a dev/founder/QA email.
 * Returns the licence (existing or freshly minted). Safe to call on
 * every signup/login — the synthetic intent reference dedupes inside
 * issueLicense, so we never mint duplicates for the same email.
 *
 * Function name kept as `ensureDevLifetimeLicense` for back-compat with
 * call sites in api/auth/[action].ts. As of 2026-05 the granted tier
 * is "yearly" (1-year subscription), matching the new product. Old
 * lifetime grants in Redis from before the rename still work — they
 * just keep their stored "lifetime" tier and never expire.
 *
 * The licence is real: same redeem path, same scan-tier behaviour,
 * same /account.html surface. The only difference from a paid Yearly
 * is `amountUsd: 0` and the synthetic reference string, both of
 * which are visible to anyone auditing Redis (no hidden grants).
 */
export async function ensureDevLifetimeLicense(
  redis: Redis,
  email: string,
): Promise<License | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  if (!isDevLifetimeEmail(norm)) return null;

  // Stable synthetic reference — bumped to "yearly" so the new dev grant
  // gets minted alongside any pre-existing dev-lifetime licence (rather
  // than dedupe-merging into it). Effect: founders signing up after the
  // 2026-05 rollout get a yearly grant; pre-rollout lifetime grants stay
  // valid forever in parallel.
  const intentReference = `dev-grant-yearly:${norm}`;

  try {
    const license = await issueLicense(redis, {
      email: norm,
      tier: "yearly",
      intentReference,
      amountUsd: 0,
    });
    logger.info("auth", "dev-yearly ensured", {
      emailRef: emailRef(norm),
      key: maskLicenseKey(license.key),
      // The reference holds the address ("dev-grant-yearly:<e-mail>"): only its kind is logged.
      reference: "dev-grant-yearly",
    });
    return license;
  } catch (err) {
    // Don't fail the auth flow on grant errors — the user can still
    // log in and pay normally. Logging is enough for the operator
    // to notice and fix.
    logger.error("auth", "dev-yearly issuance failed", {
      emailRef: emailRef(norm),
      error: String(err),
    });
    return null;
  }
}

// ─── Dev Pro grant ────────────────────────────────────────────────────────────
//
// Same shape as the Lifetime grant above but mints a Pro 30-day pass
// instead of a Lifetime licence. Some devs / QA need to test the
// expiry-aware Pro flow specifically (renewal prompts, downgrade
// clock, "Renews on …" UI on /account) — Lifetime doesn't surface
// any of those.
//
// Issuing both a Pro AND a Lifetime to the same email is fine: the
// /account UI lists both licences and the user picks which key to
// redeem in the extension. Tier on the install_id reflects whichever
// got redeemed last.

// Same posture as DEV_LIFETIME_EMAILS — configure via env, not source.
// Operators wanting both licences for the same account should list the
// email in BOTH `DEV_LIFETIME_EMAILS` and `DEV_PRO_EMAILS`.
function getDevProEmails(): Set<string> {
  const fromEnv = (process.env.DEV_PRO_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(fromEnv);
}

export function isDevProEmail(email: string): boolean {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  return getDevProEmails().has(norm);
}

/**
 * Idempotently issue a Pro 30-day pass licence to a dev-allowlisted
 * email. Mirror of ensureDevLifetimeLicense but with intent tier
 * "monthly" (which intentTierToLicenseTier maps to license tier
 * "pro"). Synthetic intent reference dedupes inside issueLicense
 * so repeat calls don't mint duplicates.
 *
 * Note on expiry: issueLicense sets `expiresAt = now + PRO_PASS_DAYS`
 * on Pro licences. The first call from a dev's first login locks in
 * a 30-day window starting then; subsequent logins return the SAME
 * licence with the SAME expiry (idempotent). To get a fresh 30-day
 * window after the first one expires, the dev would need to redeem
 * the licence in the extension (which extends the install's tier
 * window) or the operator can manually delete the key
 * `intent:license:dev-grant-pro:<email>` (INTENT_LICENSE_KEY, see keys.ts) to allow a re-issue.
 */
export async function ensureDevProLicense(
  redis: Redis,
  email: string,
): Promise<License | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  if (!isDevProEmail(norm)) return null;

  const intentReference = `dev-grant-pro:${norm}`;

  try {
    const license = await issueLicense(redis, {
      email: norm,
      tier: "monthly",
      intentReference,
      amountUsd: 0,
    });
    logger.info("auth", "dev-pro ensured", {
      emailRef: emailRef(norm),
      key: maskLicenseKey(license.key),
      reference: "dev-grant-pro",
    });
    return license;
  } catch (err) {
    logger.error("auth", "dev-pro issuance failed", {
      emailRef: emailRef(norm),
      error: String(err),
    });
    return null;
  }
}
