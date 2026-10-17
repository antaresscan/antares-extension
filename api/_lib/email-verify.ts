// api/_lib/email-verify.ts — The confirmation link of an account, and what clicking it does (audit A-01).
//
// A link proves one thing: that whoever holds it can read the mailbox. It is NOT enough to confirm the account, on purpose. Confirming also
// asks for the PASSWORD of the account, so the one who confirms is the one who chose it. Otherwise anybody could sign up first with somebody
// else's address and a password they know; when the real owner, later, clicked the link in an e-mail that arrived unasked, it would be the
// attacker's account that became confirmed. With the password asked, the owner (who does not know the attacker's password) cannot confirm
// the attacker's account, and the attacker (who cannot read the mailbox) cannot confirm it either: it stays unconfirmed and disappears
// after 48 hours.
//
// THE LINK: base64url(JSON {e: e-mail, n: nonce, x: expiry in ms}) "." base64url(HMAC-SHA256 of that text), keyed with
// deriveKey("antares-email-verify-v1") (account.ts): not the session key, so a link can never be taken for a session. It goes in the
// FRAGMENT of the address (#t=...), which a browser never sends to a server, a log or a Referer header. `n` must equal the nonce stored on
// the account; confirming removes the nonce, so a link works once.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { ACCOUNT_KEY } from "./keys";
import { deriveKey, getAccount, newVerifyNonce, verifyPasswordAsync, type Account } from "./account";
import { VERIFY_TOKEN_TTL_MS } from "./email-proof";
import { normalizeEmail } from "./license";
import { logger } from "./logger";
import { emailRef } from "./log-ref";

const KEY_LABEL = "antares-email-verify-v1";

const b64url = (buf: Buffer | string): string => (typeof buf === "string" ? Buffer.from(buf) : buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4), "base64");

export function signVerifyToken(emailLc: string, nonce: string, now: number = Date.now()): string {
  const payload = b64url(JSON.stringify({ e: emailLc, n: nonce, x: now + VERIFY_TOKEN_TTL_MS }));
  const sig = createHmac("sha256", deriveKey(KEY_LABEL)).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}

export type ParsedVerifyToken = { ok: true; email: string; nonce: string } | { ok: false };

/** Reads a link's token: false for anything that is not a token we signed, or that has run out. One answer for every cause. */
export function parseVerifyToken(token: unknown, now: number = Date.now()): ParsedVerifyToken {
  if (typeof token !== "string" || token.length < 20 || token.length > 1024) return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false };
  const expected = createHmac("sha256", deriveKey(KEY_LABEL)).update(parts[0]).digest();
  let given: Buffer;
  try { given = unb64url(parts[1]); } catch { return { ok: false }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  let body: { e?: unknown; n?: unknown; x?: unknown };
  try { body = JSON.parse(unb64url(parts[0]).toString("utf8")) as typeof body; } catch { return { ok: false }; }
  if (typeof body.e !== "string" || typeof body.n !== "string" || typeof body.x !== "number") return { ok: false };
  if (body.x < now) return { ok: false };
  const email = normalizeEmail(body.e);
  return email ? { ok: true, email, nonce: body.n } : { ok: false };
}

/**
 * The link to send to this account, and the moment it was sent (for the cooldown). An account that has no nonce yet (one made before the
 * rule) is given one. The nonce of an account that has one is KEPT: sending again does not cancel the e-mail already in the inbox.
 */
export async function beginVerification(redis: Redis, account: Account, now: number = Date.now()): Promise<{ token: string }> {
  let nonce = account.verifyNonce;
  const fields: Record<string, string> = { verifySentAt: String(now) };
  if (!nonce) { nonce = newVerifyNonce(); fields.verifyNonce = nonce; }
  await redis.hset(ACCOUNT_KEY(account.email), fields);
  return { token: signVerifyToken(account.email, nonce, now) };
}

/** Has the last confirmation e-mail been sent less than `cooldownMs` ago? */
export const sentRecently = (account: Pick<Account, "verifySentAt">, cooldownMs: number, now: number = Date.now()): boolean =>
  account.verifySentAt > 0 && now - account.verifySentAt < cooldownMs;

export type ConfirmOutcome =
  | { ok: true; account: Account }
  /** The link is not one of ours, has run out, was already used, or belongs to an account that is gone or already confirmed. */
  | { ok: false; reason: "invalid_token" }
  /** The link is good but the password is not the account's. The link is NOT used up. */
  | { ok: false; reason: "invalid_credentials" };

/** The owner opens the link AND types the password: the e-mail becomes proven. */
export async function confirmEmail(redis: Redis, token: Extract<ParsedVerifyToken, { ok: true }>, password: string): Promise<ConfirmOutcome> {
  const account = await getAccount(redis, token.email);
  if (!account || account.emailVerified || !account.verifyNonce) return { ok: false, reason: "invalid_token" };
  const a = Buffer.from(token.nonce);
  const b = Buffer.from(account.verifyNonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid_token" };
  // Off the event loop (the synchronous scrypt held the whole instance for ~50 ms: audit lot 3).
  if (!(await verifyPasswordAsync(password, account.passwordHash))) return { ok: false, reason: "invalid_credentials" };

  // One transaction: confirmed, link spent, and the 48 h expiry of an unconfirmed account lifted, all or none.
  await redis
    .multi()
    .hset(ACCOUNT_KEY(account.email), { emailVerified: "1" })
    .hdel(ACCOUNT_KEY(account.email), "verifyNonce", "verifySentAt")
    .persist(ACCOUNT_KEY(account.email))
    .exec();
  logger.info("account", "e-mail confirmed", { emailRef: emailRef(account.email) });
  return { ok: true, account: { ...account, emailVerified: true, verifyNonce: undefined, verifySentAt: 0 } };
}
