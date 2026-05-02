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
import { normalizeEmail } from "./license";

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

function getSessionSecret(): Buffer {
  const secret = process.env.SESSION_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set (32+ chars). Generate with `openssl rand -hex 32`.",
    );
  }
  return Buffer.from(secret, "utf8");
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
