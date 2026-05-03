// api/_lib/account.ts — Email + password accounts, scrypt-hashed passwords,
// HMAC-SHA256 JWT sessions. Zero-dep on top of node:crypto so we don't
// have to add bcrypt or jose to the bundle.
//
// Storage in Redis:
//   account:<email_lc>            HASH
//     id, email, passwordHash, createdAt, emailVerified
//   account:install:<install_id>  STRING → email_lc
//     reverse index for "extension wants to know which account owns
//     this install"
//
// Sessions are stateless JWTs signed with SESSION_SECRET (env var).
// Token contains {sub: email_lc, exp}. We don't keep a server-side
// allowlist for MVP — if we need to revoke we can rotate
// SESSION_SECRET; that invalidates every session at once. Future:
// per-token allowlist for fine-grained revocation.

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";
import { issueLicense, normalizeEmail, type License } from "./license";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  email: string;
  /** scrypt$<salt-hex>$<derived-hex> */
  passwordHash: string;
  createdAt: number;
  emailVerified: boolean;
}

export interface SessionPayload {
  sub: string; // email_lc
  exp: number; // epoch-seconds
  iat: number;
}

// ─── Redis keys ───────────────────────────────────────────────────────────────

export const ACCOUNT_KEY = (emailLc: string) => `account:${emailLc}`;
export const ACCOUNT_INSTALL_KEY = (installId: string) =>
  `account:install:${installId}`;

// ─── Password hashing (scrypt) ────────────────────────────────────────────────

const SCRYPT_N = 16384; // CPU cost (default 16384, gives ~50ms hash on Vercel)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 16;

export function hashPassword(plain: string): string {
  if (typeof plain !== "string" || plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  if (plain.length > 256) {
    throw new Error("password too long");
  }
  const salt = randomBytes(SCRYPT_SALTLEN);
  const derived = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, derivedHex] = parts;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(derivedHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(plain, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
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
function getSessionSecret(): Buffer {
  const explicit = process.env.SESSION_SECRET;
  if (typeof explicit === "string" && explicit.length >= 32) {
    return Buffer.from(explicit, "utf8");
  }

  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (typeof redisToken === "string" && redisToken.length >= 32) {
    logger.warn(
      "auth",
      "SESSION_SECRET not set — using bootstrap fallback derived from UPSTASH_REDIS_REST_TOKEN. Set a dedicated SESSION_SECRET ASAP via the Vercel dashboard or `vercel env add SESSION_SECRET production`. See AUTH-SETUP.md §2.",
    );
    return createHmac("sha256", redisToken)
      .update(SESSION_SECRET_DERIVATION_INFO)
      .digest();
  }

  throw new Error(
    "Auth not configured: set SESSION_SECRET (32+ chars) on the deployment, or ensure UPSTASH_REDIS_REST_TOKEN is set so the bootstrap fallback can derive one. Generate a SESSION_SECRET with `openssl rand -hex 32`.",
  );
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function signSession(emailLc: string, now: number = Date.now()): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: SessionPayload = {
    sub: emailLc,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
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
  return payload;
}

// ─── Account CRUD ─────────────────────────────────────────────────────────────

export type CreateAccountOutcome =
  | { ok: true; account: Account }
  | { ok: false; reason: "invalid_email" | "weak_password" | "already_exists" };

export async function createAccount(
  redis: Redis,
  params: { email: string; password: string },
): Promise<CreateAccountOutcome> {
  const email = normalizeEmail(params.email);
  if (!email) return { ok: false, reason: "invalid_email" };
  if (typeof params.password !== "string" || params.password.length < 8) {
    return { ok: false, reason: "weak_password" };
  }

  const existing = await redis.hgetall<Record<string, string>>(ACCOUNT_KEY(email));
  if (existing && existing.email) {
    return { ok: false, reason: "already_exists" };
  }

  let passwordHash: string;
  try {
    passwordHash = hashPassword(params.password);
  } catch {
    return { ok: false, reason: "weak_password" };
  }

  const account: Account = {
    id: randomBytes(16).toString("hex"),
    email,
    passwordHash,
    createdAt: Date.now(),
    emailVerified: false,
  };

  await redis.hset(ACCOUNT_KEY(email), {
    id: account.id,
    email: account.email,
    passwordHash: account.passwordHash,
    createdAt: String(account.createdAt),
    emailVerified: account.emailVerified ? "1" : "0",
  });

  logger.info("account", "created", { email });
  return { ok: true, account };
}

export async function getAccount(
  redis: Redis,
  email: string,
): Promise<Account | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const raw = await redis.hgetall<Record<string, string>>(ACCOUNT_KEY(norm));
  if (!raw || !raw.email) return null;
  return {
    id: raw.id,
    email: raw.email,
    passwordHash: raw.passwordHash,
    createdAt: Number(raw.createdAt) || 0,
    emailVerified: raw.emailVerified === "1",
  };
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
    // Sleep ~50ms to roughly match the verify cost — defends against
    // user-existence enumeration via timing.
    try {
      hashPassword("dummy-password-for-timing-defense-only");
    } catch {
      /* ignore */
    }
    return { ok: false, reason: "invalid_credentials" };
  }
  const ok = verifyPassword(params.password, account.passwordHash);
  if (!ok) return { ok: false, reason: "invalid_credentials" };
  return { ok: true, account };
}

// ─── Install ↔ account binding ────────────────────────────────────────────────

export async function bindInstallToAccount(
  redis: Redis,
  installId: string,
  email: string,
): Promise<void> {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("invalid email");
  await redis.set(ACCOUNT_INSTALL_KEY(installId), norm);
}

export async function getAccountByInstall(
  redis: Redis,
  installId: string,
): Promise<Account | null> {
  const email = await redis.get<string>(ACCOUNT_INSTALL_KEY(installId));
  if (!email) return null;
  return getAccount(redis, email);
}

// ─── Dev Lifetime grant ───────────────────────────────────────────────────────
//
// Some accounts (the founder, contributors, QA) need to use the
// extension on the Pro/Lifetime tier without going through a real
// Solana payment. Mirror of the install-based DEV_PRO_INSTALLS env
// var in user.ts, but keyed by email so it survives extension
// re-installs and works for any device the developer logs in from.
//
// Resolution:
//   1. Hardcoded fallback list (audit-friendly, ships with the code)
//   2. plus DEV_LIFETIME_EMAILS env var, comma-separated, normalised
//
// On the auth handler's success path (signup + login), if the email
// matches we call ensureDevLifetimeLicense() — that issues a real
// Lifetime licence keyed to the email if one doesn't already exist.
// The dev then sees it on /account.html and pastes the key into the
// extension exactly like a paying user would. Same redeem path, same
// idempotency, same Pro-tier behaviour after redeem.

const DEV_LIFETIME_EMAILS_HARDCODED = [
  // Founder — keep in code so the deployment always grants this even
  // before DEV_LIFETIME_EMAILS env var is configured, and so the
  // grant survives env-var rotation.
  "lennypierrepro@gmail.com",
];

function getDevLifetimeEmails(): Set<string> {
  const fromEnv = (process.env.DEV_LIFETIME_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([
    ...DEV_LIFETIME_EMAILS_HARDCODED.map((e) => e.toLowerCase()),
    ...fromEnv,
  ]);
}

export function isDevLifetimeEmail(email: string): boolean {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  return getDevLifetimeEmails().has(norm);
}

/**
 * Idempotently issue a Lifetime licence to a dev/founder/QA email.
 * Returns the licence (existing or freshly minted). Safe to call on
 * every signup/login — the synthetic intent reference dedupes inside
 * issueLicense, so we never mint duplicates for the same email.
 *
 * The licence is real: same redeem path, same scan-tier behaviour,
 * same /account.html surface. The only difference from a paid
 * Lifetime is `amountUsd: 0` and the synthetic reference string,
 * both of which are visible to anyone auditing Redis (no hidden
 * grants).
 */
export async function ensureDevLifetimeLicense(
  redis: Redis,
  email: string,
): Promise<License | null> {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  if (!isDevLifetimeEmail(norm)) return null;

  // Stable synthetic reference — issueLicense uses it for idempotency.
  // Any subsequent call for the same email returns the same key.
  const intentReference = `dev-grant-lifetime:${norm}`;

  try {
    const license = await issueLicense(redis, {
      email: norm,
      tier: "lifetime",
      intentReference,
      amountUsd: 0,
    });
    logger.info("auth", "dev-lifetime ensured", {
      email: norm,
      key: license.key,
      reference: intentReference,
    });
    return license;
  } catch (err) {
    // Don't fail the auth flow on grant errors — the user can still
    // log in and pay normally. Logging is enough for the operator
    // to notice and fix.
    logger.error("auth", "dev-lifetime issuance failed", {
      email: norm,
      error: String(err),
    });
    return null;
  }
}
