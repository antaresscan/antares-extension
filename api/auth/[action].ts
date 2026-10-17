// api/auth/[action].ts — Single auth dispatcher.
//
// Hobby Vercel allows 12 serverless functions max; routing all four
// auth verbs (signup / login / logout / me) through one dynamic file
// keeps us under the cap. URLs are unchanged thanks to the dynamic
// segment:
//   POST /api/auth/signup → action=signup
//   POST /api/auth/login  → action=login
//   POST /api/auth/logout → action=logout
//   POST /api/auth/logout-all → action=logout-all (every session of the account, everywhere)
//   POST /api/auth/delete-account → action=delete-account (erases the account and what hangs on it; needs the password)
//   POST /api/auth/verify-email → action=verify-email (the owner opens the link of the e-mail AND types the password: audit A-01)
//   POST /api/auth/resend-verification → action=resend-verification (a signed-in, unconfirmed account asks for its link again)
//   GET  /api/auth/me     → action=me
//
// Each branch keeps its own method/body/contract guarantees so the
// caller surface is identical to the previous one-file-per-verb shape.
import { createHash } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  checkRateLimit,
  getClientIp,
  getInstallId,
  initRateLimiters,
  coldScanKey,
} from "../_lib/middleware";
import { apiError } from "../_lib/helpers";
import { logger } from "../_lib/logger";
import { emailRef } from "../_lib/log-ref";
import {
  createAccount,
  authenticate,
  hashPasswordAsync,
  ACCOUNT_KEY,
  ensureDevLifetimeLicense,
  ensureDevProLicense,
  signSession,
  signedInAtOf,
  revokeAllSessions,
  ACCOUNT_INSTALL_KEY,
} from "../_lib/account";
import { checkLoginLock, clearLoginFailures } from "../_lib/login-guard";
import { eraseAccount } from "../_lib/account-erasure";
import {
  emailProofOf, isEmailProven, VERIFY_MAIL_COOLDOWN_MS, VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS, ALREADY_REGISTERED_MAIL_COOLDOWN_SECONDS, LEGACY_GRACE_ENDS_AT,
} from "../_lib/email-proof";
import { beginVerification, confirmEmail, parseVerifyToken, sentRecently } from "../_lib/email-verify";
import { sendMail, mailConfigured, type MailResult } from "../_lib/mailer";
import { normalizeEmail } from "../_lib/license";
import { verificationMail, alreadyRegisteredMail } from "../_lib/mail-templates";
import { ALREADY_REGISTERED_MAIL_KEY, SIGNUP_MAIL_BUDGET_KEY, SIGNUP_NETWORK_KEY } from "../_lib/keys";
import type { Account } from "../_lib/account";
import {
  setSessionCookie,
  clearSessionCookie,
  getAccountFromRequest,
  getSessionFromRequest,
} from "../_lib/session-cookie";
import {
  verifyIpnSignature,
  mapStatus,
  paidRatio,
  type NpPayment,
} from "../_lib/nowpayments";
import {
  bindNpPaymentId,
  getIntentByNpInvoiceId,
  getIntentByNpPaymentId,
  getPaymentIntent,
} from "../_lib/payments";
import { confirmIntent } from "../_lib/payment-confirm";
import { initUserStorage } from "../_lib/user";
import { initSentry, captureError } from "../_lib/sentry";

initSentry();

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function readBody(req: VercelRequest): Record<string, unknown> {
  const body = req.body as unknown;
  if (body && typeof body === "object") return body as Record<string, unknown>;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * The shortest time a sign-up answer takes (from the moment the input is valid), so that its duration does not tell a new address (scrypt +
 * an e-mail sent) from a known one (scrypt only). Only on a Vercel deployment: a local run and the unit tests answer at once.
 */
export const SIGNUP_MIN_ANSWER_MS = process.env.VERCEL_ENV ? 1500 : 0;
/** Sign-ups one network may start in an hour. */
export const SIGNUPS_PER_NETWORK_PER_HOUR = 20;
/** E-mails the sign-up form may send to one address in a day (links and "already registered" notices together). */
export const SIGNUP_MAILS_PER_ADDRESS_PER_DAY = 5;

/**
 * One more use of a counted allowance: true while the counter stays within `max` over its window. Fails OPEN (Redis down → allowed): a
 * ceiling against abuse must not stop people from signing up.
 */
async function underCeiling(redis: Redis, key: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const n = Number(await redis.incr(key));
    if (n === 1) await redis.expire(key, windowSeconds);
    return n <= max;
  } catch (e: unknown) {
    logger.warn("auth/signup", "ceiling unavailable — allowed", { error: String(e) });
    return true;
  }
}

// ── signup ──────────────────────────────────────────────────────────────
//
// E-mail proof (audit A-01). A sign-up creates an account that is NOT confirmed: it owns no licence, gets no dev grant and is Free until the
// owner opens the link in the e-mail AND types the password (see email-verify.ts for why both). So the answer to a sign-up is ALWAYS the same
// "check your inbox", no session cookie, whatever the address is: new, waiting for its confirmation, or already an account. A sign-up form
// that answered "already registered" told anybody which addresses have an account (that was the 409 of before, and the A-11 note that this
// had to wait for the e-mail proof). What is DONE differs, and only the owner of the mailbox sees it:
//   - new address: the account is created and the link is sent;
//   - an account waiting for its confirmation: nothing changes (the password is NEVER replaced), the link is sent again unless one left less
//     than a minute ago;
//   - a confirmed account: nothing changes, an e-mail says "you already have an account" (once an hour at most per address).
// With no RESEND_API_KEY nothing is created (the account could never be confirmed) and the answer is 503, the same for every address.
async function handleSignup(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = String(body.email ?? "");
  const password = String(body.password ?? "");

  // What is wrong with the input is the same answer whether or not the mail service is up (createAccount stays the authority on the rules).
  if (!normalizeEmail(email)) return res.status(400).json({ ok: false, reason: "invalid_email" });
  if (password.length < 8) return res.status(400).json({ ok: false, reason: "weak_password" });

  // From here on, the answer must not tell whether the address has an account: neither by its content (always "check_email") nor by the
  // TIME it takes. A new address costs a scrypt AND an e-mail sent through Resend (hundreds of ms); a confirmed address inside its hourly
  // cooldown costs a scrypt only. So every answer of this path waits until SIGNUP_MIN_ANSWER_MS after the start (audit lot 5).
  const started = Date.now();
  const answer = async (status: number, payload: Record<string, unknown>) => {
    const wait = SIGNUP_MIN_ANSWER_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return res.status(status).json(payload);
  };

  try {
    if (!mailConfigured()) {
      logger.error("auth/signup", "RESEND_API_KEY is not set: sign-ups are refused (an account that cannot be confirmed is useless)", {});
      return answer(503, { ok: false, reason: "email_unavailable" });
    }
    // One network may start SIGNUPS_PER_NETWORK_PER_HOUR sign-ups an hour: each one can make us write to an inbox of its choosing.
    if (!(await underCeiling(redis, SIGNUP_NETWORK_KEY(sha256Hex(coldScanKey(ip))), SIGNUPS_PER_NETWORK_PER_HOUR, 60 * 60))) {
      res.setHeader("Retry-After", "3600");
      return answer(429, { ok: false, reason: "too_many_signups", error: "Too many sign-ups from this network. Try again in an hour." });
    }
    const outcome = await createAccount(redis, { email, password });
    if (!outcome.ok && outcome.reason !== "already_exists") {
      return answer(400, { ok: false, reason: outcome.reason });
    }

    // At most SIGNUP_MAILS_PER_ADDRESS_PER_DAY e-mails a day to one address, whatever kind: the per-kind cooldowns (1 minute for the link,
    // 1 hour for "already registered") still let a script send 1 440 links a day to somebody else's inbox. Past the ceiling nothing is sent and
    // the answer is the same "check_email" (the ceiling says nothing about the account).
    const mailAllowed = () =>
      underCeiling(redis, SIGNUP_MAIL_BUDGET_KEY(sha256Hex(normalizeEmail(email) ?? email)), SIGNUP_MAILS_PER_ADDRESS_PER_DAY, 24 * 60 * 60);
    let sent: MailResult | null = null;
    if (outcome.ok) {
      if (await mailAllowed()) sent = await sendVerificationMail(redis, outcome.account);
    } else {
      // Same CPU as a creation (off the event loop, like the creation's own hash), on top of the minimum answer time.
      try { await hashPasswordAsync(password); } catch { /* the password was valid when createAccount looked at it */ }
      const existing = outcome.existing;
      if (existing && !existing.emailVerified) {
        if (!sentRecently(existing, VERIFY_MAIL_COOLDOWN_MS) && (await mailAllowed())) sent = await sendVerificationMail(redis, existing);
      } else if (existing) {
        const noticeKey = ALREADY_REGISTERED_MAIL_KEY(sha256Hex(existing.email));
        const first = await redis.set(noticeKey, "1", { nx: true, ex: ALREADY_REGISTERED_MAIL_COOLDOWN_SECONDS });
        if (first && (await mailAllowed())) sent = await sendMail(alreadyRegisteredMail(existing.email));
      }
    }
    if (sent && !sent.ok) {
      logger.error("auth/signup", "the e-mail could not be sent", { reason: sent.reason });
      return answer(503, { ok: false, reason: "email_unavailable" });
    }
    logger.metric("auth.signup", { emailRef: emailRef(email), created: outcome.ok });
    return answer(200, { ok: true, status: "check_email" });
  } catch (err) {
    logger.error("auth/signup", "creation failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/signup" });
    return apiError(res, 500, "Could not create account.");
  }
}

/** Sends (or sends again) the confirmation link of an account. Records the moment, for the cooldown. */
async function sendVerificationMail(redis: Redis, account: Account): Promise<MailResult> {
  const { token } = await beginVerification(redis, account);
  const result = await sendMail(verificationMail(account.email, token));
  if (!result.ok) {
    // Nothing left the building: the minute of cooldown must not stand between the person and their next try.
    try { await redis.hset(ACCOUNT_KEY(account.email), { verifySentAt: "0" }); } catch { /* the cooldown ends by itself */ }
  }
  return result;
}

// ── login ───────────────────────────────────────────────────────────────
async function handleLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = String(body.email ?? "");
  const password = String(body.password ?? "");

  try {
    // The lock of this e-mail's login (audit A-11): 10 failed logins in 15 minutes, from any address, and the next ones are refused until the
    // window ends, the right password included. It counts unknown e-mails exactly like known ones, so the lock tells nothing about who has an account.
    const lock = await checkLoginLock(redis, email);
    if (lock.locked) {
      const minutes = Math.max(1, Math.ceil(lock.retryAfterSec / 60));
      res.setHeader("Retry-After", String(lock.retryAfterSec));
      logger.metric("auth.login-locked", { emailRef: emailRef(email) });
      // `error` is what the website's login form shows, word for word, on a 429.
      return res.status(429).json({
        ok: false,
        reason: "too_many_attempts",
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        retryAfterSec: lock.retryAfterSec,
      });
    }
    const outcome = await authenticate(redis, { email, password });
    if (!outcome.ok) {
      // The attempt was counted by checkLoginLock before the password was checked (concurrent guesses cannot slip under the lock).
      // 401 not 404 — never differentiate "no account" from "wrong
      // password" or we leak account existence.
      return res
        .status(401)
        .json({ ok: false, reason: "invalid_credentials" });
    }
    await clearLoginFailures(redis, email, lock.attempts);
    setSessionCookie(res, outcome.account.email, {}, outcome.account.sessionVersion);
    // An unconfirmed account can log in (to see why it is Free, and to ask for its link) but owns nothing yet: no dev grant until the e-mail is
    // proven (audit A-01). Inside the grace of the accounts that predate the rule it still counts as proven.
    if (isEmailProven(outcome.account)) {
      // Auto-grant dev licences (Pro + Lifetime). Idempotent — only mints once per email-and-tier regardless of how many logins.
      await ensureDevLifetimeLicense(redis, outcome.account.email);
      await ensureDevProLicense(redis, outcome.account.email);
    }
    // An account that never confirmed gets its link again at its next login (no more than once every 10 minutes): this is how the accounts that
    // existed before the rule learn they have to confirm. A failure here never blocks the login.
    if (!outcome.account.emailVerified && mailConfigured() && !sentRecently(outcome.account, VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS)) {
      try { await sendVerificationMail(redis, outcome.account); } catch (err) { logger.warn("auth/login", "confirmation e-mail not sent", { error: String(err) }); }
    }
    logger.metric("auth.login", { emailRef: emailRef(outcome.account.email) });
    return res.status(200).json({
      ok: true,
      email: outcome.account.email,
      emailVerified: outcome.account.emailVerified,
      emailProof: emailProofOf(outcome.account),
    });
  } catch (err) {
    logger.error("auth/login", "auth failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/login" });
    return apiError(res, 500, "Could not log in.");
  }
}

// ── logout ──────────────────────────────────────────────────────────────
//
// Just clear the cookie. We don't need to mutate the install→email
// binding or stored tier any more — `getEffectiveTierFromRequest` is
// session-gated, so the cookie's absence IS what makes the next scan
// return Free for everyone, including dev and paying customers.
// Signing back in restores tier without any data being touched.
function handleLogout(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}

// ── logout-all ──────────────────────────────────────────────────────────
//
// "Log me out everywhere" (audit A-12). A session is a signed token valid 30 days and the server keeps no list of them, so "log out" only
// forgets the token in THIS browser: a copy that was stolen, or left on another machine, kept working until it expired. Here the account's
// session number is raised (revokeAllSessions): every token signed before is refused from the next request on, in every browser and in the
// extension. The caller must be signed in with a token that still counts; the cookie of this browser is cleared in the same answer (this
// token is one of the revoked ones). Signing in again signs a token with the new number.
async function handleLogoutAll(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }
    const next = await revokeAllSessions(redis, account.email);
    if (next === null) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }
    clearSessionCookie(res);
    logger.metric("auth.logout-all", { emailRef: emailRef(account.email), sessionVersion: next });
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("auth/logout-all", "revocation failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/logout-all" });
    return apiError(res, 500, "Could not log out everywhere.");
  }
}

// ── delete-account ──────────────────────────────────────────────────────
//
// "Delete my account" (audit A-14b, GDPR article 17). Erases the account, the link between its installs and its e-mail, the scan history
// and the plan stored on those installs (account-erasure.ts says what goes and what stays: the record of what was bought stays).
// Three things must be true before anything is touched: a session that still counts, the PASSWORD in the body (a stolen session alone must
// not be able to destroy the account), and an e-mail whose login is not locked. A wrong password counts as a failed login: this endpoint is
// no way round the lock of login.
async function handleDeleteAccount(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }

    const lock = await checkLoginLock(redis, account.email);
    if (lock.locked) {
      const minutes = Math.max(1, Math.ceil(lock.retryAfterSec / 60));
      res.setHeader("Retry-After", String(lock.retryAfterSec));
      return res.status(429).json({
        ok: false,
        reason: "too_many_attempts",
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        retryAfterSec: lock.retryAfterSec,
      });
    }
    const password = String(readBody(req).password ?? "");
    const outcome = await authenticate(redis, { email: account.email, password });
    if (!outcome.ok) {
      // Counted by checkLoginLock, before the password was checked.
      return res.status(401).json({ ok: false, reason: "invalid_credentials" });
    }
    await clearLoginFailures(redis, account.email, lock.attempts);

    const result = await eraseAccount(redis, account.email, { installHint: getInstallId(req) });
    if (!result.ok) {
      // Nothing was deleted: the account is still there and the same request can be sent again.
      return res.status(503).json({ ok: false, reason: "try_again", message: "Could not finish deleting the account. Nothing was deleted: please try again in a few minutes." });
    }
    clearSessionCookie(res);
    logger.metric("auth.delete-account", { emailRef: emailRef(account.email), installsErased: result.installsErased });
    return res.status(200).json({ ok: true, installsErased: result.installsErased });
  } catch (err) {
    logger.error("auth/delete-account", "erasure failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/delete-account" });
    return apiError(res, 500, "Could not delete the account.");
  }
}

// ── verify-email ────────────────────────────────────────────────────────
//
// The owner opens the link of the e-mail (verify.html, on this host) and types the password: the e-mail becomes PROVEN (audit A-01). The
// link alone is not enough (email-verify.ts says why). A wrong password counts against the same lock as the login, the link is not used up by
// it, and every other answer about the link is the same "invalid_token": not ours, run out, already used, the account gone.
async function handleVerifyEmail(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const parsed = parseVerifyToken(body.token);
  if (!parsed.ok) return res.status(400).json({ ok: false, reason: "invalid_token" });

  try {
    const lock = await checkLoginLock(redis, parsed.email);
    if (lock.locked) {
      const minutes = Math.max(1, Math.ceil(lock.retryAfterSec / 60));
      res.setHeader("Retry-After", String(lock.retryAfterSec));
      return res.status(429).json({
        ok: false,
        reason: "too_many_attempts",
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? "s" : ""}.`,
        retryAfterSec: lock.retryAfterSec,
      });
    }
    const outcome = await confirmEmail(redis, parsed, String(body.password ?? ""));
    if (!outcome.ok) {
      // A wrong password was counted by checkLoginLock, before the check. (An invalid token is counted too: it is an attempt like any other.)
      if (outcome.reason === "invalid_credentials") {
        return res.status(401).json({ ok: false, reason: "invalid_credentials" });
      }
      return res.status(400).json({ ok: false, reason: "invalid_token" });
    }
    await clearLoginFailures(redis, parsed.email, lock.attempts);
    // The password was just typed: this is a login too. The grants that waited for the proof are given now (a no-op for any other address).
    setSessionCookie(res, outcome.account.email, {}, outcome.account.sessionVersion);
    await ensureDevLifetimeLicense(redis, outcome.account.email);
    await ensureDevProLicense(redis, outcome.account.email);
    logger.metric("auth.verify-email", { emailRef: emailRef(outcome.account.email) });
    return res.status(200).json({ ok: true, email: outcome.account.email });
  } catch (err) {
    logger.error("auth/verify-email", "confirmation failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/verify-email" });
    return apiError(res, 500, "Could not confirm the e-mail.");
  }
}

// ── resend-verification ─────────────────────────────────────────────────
//
// A signed-in account that has not confirmed asks for its link again (the button on the website's account page). Never faster than once a minute.
async function handleResendVerification(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) return res.status(401).json({ ok: false, reason: "not_authenticated" });
    if (account.emailVerified) return res.status(200).json({ ok: true, status: "already_verified" });
    if (!mailConfigured()) return res.status(503).json({ ok: false, reason: "email_unavailable" });
    if (sentRecently(account, VERIFY_MAIL_COOLDOWN_MS)) {
      const retryAfterSec = Math.max(1, Math.ceil((account.verifySentAt + VERIFY_MAIL_COOLDOWN_MS - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ ok: false, reason: "too_soon", retryAfterSec });
    }
    const sent = await sendVerificationMail(redis, account);
    if (!sent.ok) {
      logger.error("auth/resend-verification", "the e-mail could not be sent", { reason: sent.reason });
      return res.status(503).json({ ok: false, reason: "email_unavailable" });
    }
    return res.status(200).json({ ok: true, status: "sent" });
  } catch (err) {
    logger.error("auth/resend-verification", "failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/resend-verification" });
    return apiError(res, 500, "Could not send the e-mail.");
  }
}

// ── sync-token ──────────────────────────────────────────────────────────
//
// Returns the session JWT in the response body so the website can hand
// it to the extension via the postMessage bridge. Required because:
//
//   - The session cookie set on /api/auth/login is HttpOnly, so JS on
//     the website can't read it to forward to the extension.
//   - Cookies don't reliably flow from chrome-extension:// → API origin
//     in browsers with strict third-party cookie blocking. SameSite=None
//     + Secure helps but Chrome 124+ phases out third-party cookies
//     entirely. Without a non-cookie path, signed-in users would see
//     Free in the overlay.
//
// Flow: website calls this after login (cookie auto-sent) → gets the
// JWT → posts {type:'antares:set-session-token', token} to the bridge
// content script → bridge writes to chrome.storage.local → background
// scan calls send X-Antares-Session: <token> header → API verifies.
//
// The token is a fresh sign of the same email payload. Same TTL as the
// cookie (30 days), but it keeps the sign-in time of the token it was
// shown: a chain of re-issues ends SESSION_MAX_AGE_SECONDS (60 days)
// after the password was typed, whatever is presented (the cookie, or
// a token in X-Antares-Session). Logout clears the bridge-stored token
// via a separate postMessage (handled in the bridge content script).
async function handleSyncToken(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  try {
    const session = await getSessionFromRequest(req, redis);
    if (!session) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }
    const { account, payload } = session;

    // Auto-bind the caller's install_id to their email so subsequent scan
    // calls resolve tier without requiring a separate "Link to my
    // extension" click. This is what closes the website-account ↔
    // extension-overlay loop:
    //
    //   1. User signs in → cookie set
    //   2. /account.html probes install_id from extension bridge
    //   3. /account.html calls /api/auth/sync-token with X-Antares-Install
    //   4. We bind the install to the user's email here (this block)
    //   5. We hand back the JWT, the bridge stores it
    //   6. Next /api/scan call resolves session+binding → user's tier ✓
    //
    // Anti-hijack: we only bind when the install is currently UNBOUND.
    // If install is already bound to a different email, we leave it
    // alone — preventing user B from claiming user A's paid install
    // by signing up on the same browser. (Same-email re-bind is a
    // no-op; idempotent.) Refusal is silent — the sync-token still
    // succeeds so the user can scan; their tier just stays Free
    // until they redeem their own license.
    //
    // "Only when UNBOUND" is decided by Redis, not by a read followed by
    // a write: SET NX writes only if no binding exists. A read-then-write
    // let two accounts signing in at the same moment both see "unbound"
    // and both write, the last one silently replacing the first.
    const installId = getInstallId(req);
    // An address nobody has confirmed does not get an install bound to it (audit A-01).
    if (installId && isEmailProven(account)) {
      try {
        // The usual case (already bound to this account) costs one read, as before.
        let existing = await redis.get<string>(ACCOUNT_INSTALL_KEY(installId));
        if (!existing) {
          const written = await redis.set(ACCOUNT_INSTALL_KEY(installId), account.email, { nx: true });
          if (written === "OK") {
            logger.info("auth/sync-token", "install auto-bound", {
              installId,
              emailRef: emailRef(account.email),
            });
          } else {
            // Another sign-in bound it between the read and the write: that binding stands.
            existing = await redis.get<string>(ACCOUNT_INSTALL_KEY(installId));
          }
        }
        if (existing && existing !== account.email) {
          logger.warn("auth/sync-token", "install bound to different email", {
            installId,
            sessionRef: emailRef(account.email),
            boundRef: emailRef(existing),
          });
        }
        // existing === account.email → no-op, idempotent
      } catch (err) {
        // Don't fail the whole sync-token call on a binding-write hiccup —
        // tier resolution will just see no binding and return Free, which
        // is the safe default. The user can retry from /account.html.
        logger.warn("auth/sync-token", "auto-bind write failed", {
          error: String(err),
          installId,
        });
      }
    }

    const now = Date.now();
    // verifySession accepted the payload, so its sign-in time is a number; `now` is only the type's fallback.
    const token = signSession(account.email, now, account.sessionVersion, signedInAtOf(payload) ?? now);
    return res.json({ ok: true, token, email: account.email });
  } catch (err) {
    logger.error("auth/sync-token", "lookup failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/sync-token" });
    return apiError(res, 500, "Could not issue sync token.");
  }
}

// ── me ──────────────────────────────────────────────────────────────────
async function handleMe(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }
    const proof = emailProofOf(account);
    return res.json({
      ok: true,
      email: account.email,
      emailVerified: account.emailVerified,
      // "verified" | "grace" (not confirmed, still honoured until graceEndsAt) | "unverified" (Free until confirmed): the website says which.
      emailProof: proof,
      ...(proof === "grace" ? { graceEndsAt: LEGACY_GRACE_ENDS_AT } : {}),
      createdAt: account.createdAt,
    });
  } catch (err) {
    logger.error("auth/me", "lookup failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    captureError(err, { endpoint: "auth/me" });
    return apiError(res, 500, "Could not read session.");
  }
}

// ── nowpayments-ipn ─────────────────────────────────────────────────────
//
// NOWPayments IPN webhook receiver. Sits inside the auth router (rather
// than in its own file) because Vercel Hobby caps us at 12 serverless
// functions and this dispatcher already has spare capacity.
//
// Request: POST /api/auth/nowpayments-ipn
//   Headers: x-nowpayments-sig: <HMAC-SHA512 of body using IPN secret>
//   Body (NpPayment shape):
//     { payment_id, payment_status, order_id, invoice_id, payin_hash, ... }
//
// Security: signature verification is mandatory. Without a valid
// `NOWPAYMENTS_IPN_SECRET` env var or a matching signature header we
// fail closed (401). Replays of an already-confirmed intent are
// idempotent thanks to `confirmIntent` checking intent.status first.
//
// CORS: NOWPayments servers are not browsers, no preflight expected,
// and we don't need to expose this to extension origins. The router's
// outer setCorsHeaders gate is permissive enough; we don't add origin
// restrictions here because NOWPayments doesn't send an Origin header.
async function handleNowpaymentsIpn(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  // Per-IP rate limit. NOWPayments fires from a stable set of IPs so
  // legit traffic never approaches the cap (60/min, and 429 is retried
  // by NOWPayments like any other non-200). The check protects
  // against spoofed-source flood: an attacker with a known endpoint can
  // POST garbage all day; without a limit each request would HMAC-verify
  // (cheap but non-zero), look up a Redis key, and burn function quota.
  initRateLimiters(redis);
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  initUserStorage(redis);

  const sigHeader = req.headers["x-nowpayments-sig"];
  const body = readBody(req);
  if (!body || Object.keys(body).length === 0) {
    return apiError(res, 400, "Empty IPN payload.");
  }

  if (!verifyIpnSignature(body, sigHeader)) {
    logger.warn("auth/nowpayments-ipn", "signature verification failed", {
      hasSig: typeof sigHeader === "string" && sigHeader.length > 0,
      // Unsigned, so written by anyone: at most 80 characters of it reach the logs.
      orderId: typeof body.order_id === "string" ? body.order_id.slice(0, 80) : null,
    });
    return res.status(401).json({ ok: false, reason: "invalid_signature" });
  }

  const payment = body as unknown as NpPayment;
  const orderId = typeof payment.order_id === "string" ? payment.order_id : "";
  const npPaymentId =
    typeof payment.payment_id === "string"
      ? payment.payment_id
      : payment.payment_id != null
        ? String(payment.payment_id)
        : "";
  const npInvoiceId =
    typeof payment.invoice_id === "string"
      ? payment.invoice_id
      : payment.invoice_id != null
        ? String(payment.invoice_id)
        : "";

  const internalStatus = mapStatus(payment.payment_status);

  // Locate the intent. order_id is our reference (what we passed to
  // NOWPayments), so it's the primary lookup. Fall back to the
  // payment_id → reference index, then the invoice_id index, in case
  // an upstream relay drops the order_id field.
  //
  // Strict reads: a Redis error THROWS (the dispatcher answers 500 and
  // NOWPayments retries). Read as "no intent", it got the 200 below,
  // NOWPayments stopped retrying, and a confirmed payment was lost.
  let intent = orderId ? await getPaymentIntent(redis, orderId, { strict: true }) : null;
  if (!intent && npPaymentId) {
    intent = await getIntentByNpPaymentId(redis, npPaymentId, { strict: true });
  }
  if (!intent && npInvoiceId) {
    intent = await getIntentByNpInvoiceId(redis, npInvoiceId, { strict: true });
  }
  if (!intent) {
    logger.warn("auth/nowpayments-ipn", "intent not found", {
      orderId,
      npPaymentId,
      npInvoiceId,
    });
    // A CONFIRMED payment with no intent is money received and nothing to give back for it: nothing else will ever
    // retry it (the 200 below stops NOWPayments from doing so), so it has to reach a human.
    if (internalStatus === "confirmed") {
      captureError(new Error("NOWPayments confirmed a payment whose intent no longer exists"), {
        endpoint: "auth/nowpayments-ipn",
        phase: "confirmedWithoutIntent",
        orderId,
        npPaymentId,
        npInvoiceId,
        paymentStatus: payment.payment_status,
      });
    }
    // 200 anyway so NOWPayments doesn't keep retrying — the intent
    // either doesn't exist or has been GC'd. Logging captures it.
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Bind the payment_id on first observation so subsequent IPN events
  // (and the payment-status poll) hit the fast path.
  if (npPaymentId && !intent.npPaymentId) {
    try {
      intent = await bindNpPaymentId(redis, intent, npPaymentId);
    } catch { /* non-critical */ }
  }

  if (internalStatus === "confirmed") {
    // The IPN body is HMAC-signed so we trust *what NOWPayments saw*,
    // but pass how much of the asked crypto amount was really sent
    // (actually_paid / pay_amount) so confirmIntent can guard against the
    // partially-paid → finished corner case (anti-underpay).
    const ratio = paidRatio(payment);
    const txSignature =
      payment.payin_hash ?? payment.payout_hash ?? undefined;
    const outcome = await confirmIntent(redis, intent, {
      txSignature: typeof txSignature === "string" ? txSignature : undefined,
      paidRatio: ratio,
    });
    if (!outcome.ok) {
      // 200 anyway so NOWPayments stops retrying. Polling client can
      // see the underpay state via the body for UX surfacing.
      return res.status(200).json({
        ok: false,
        status: "amount_mismatch",
        reason: outcome.reason,
        paidRatio: outcome.paidRatio,
      });
    }
    logger.metric("auth/nowpayments-ipn.confirmed", {
      reference: outcome.intent.reference,
      tier: outcome.intent.tier,
      amountUsd: outcome.intent.amountUsd,
      paidRatio: ratio ?? null,
      hasEmail: !!outcome.intent.email,
      licenseIssued: outcome.licenseKey !== null,
    });
    return res.status(200).json({ ok: true, status: "confirmed" });
  }

  if (internalStatus === "expired") {
    // ONE payment of the invoice is dead (failed / refunded / expired). That does not close the intent: an invoice can hold
    // several payments (the buyer picks a coin, then another one), so the dead one may be the abandoned attempt of an intent
    // that another payment has already confirmed, or is confirming right now. Expiring here turned a paid intent into
    // "expired": the buyer's page lost its licence key, the cron stopped looking at it, and a re-delivered "finished" IPN
    // granted the tier a second time from scratch. The intent is left as it is; the reconciliation (payment-reconcile.ts,
    // run by the poll and the cron), which asks NOWPayments for EVERY payment of the invoice, is the one that expires it.
    logger.metric("auth/nowpayments-ipn.expired", {
      reference: intent.reference,
      providerStatus: payment.payment_status,
      intentStatus: intent.status,
    });
    return res.status(200).json({ ok: true, status: intent.status });
  }

  // Pending / partially-paid / waiting / confirming — record the event but
  // don't transition the intent yet. The polling endpoint and cron will
  // re-check on subsequent ticks.
  logger.info("auth/nowpayments-ipn", "pending update", {
    reference: intent.reference,
    providerStatus: payment.payment_status,
  });
  return res.status(200).json({ ok: true, status: "pending" });
}

// ── dispatcher ──────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel surfaces the [action] segment under req.query.action.
  const actionRaw = req.query.action;
  const action = String(Array.isArray(actionRaw) ? actionRaw[0] : actionRaw ?? "");

  // NOWPayments IPN webhook is hit by NOWPayments servers, NOT browsers.
  // No Origin header → the CORS gate would reject it (403). Skip CORS
  // entirely for this action — auth is enforced via the HMAC signature
  // header, which is far stronger than origin checking anyway.
  if (action === "nowpayments-ipn") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    // Wrap with a global catch — handleNowpaymentsIpn does not have
    // an outer try, and an unhandled throw inside `confirmIntent`
    // (e.g. transient Redis flake mid-license-mint) is the worst
    // bug we can ship: NOWPayments confirmed the payment, the user
    // pays, but our side fails silently and the license never lands,
    // leaving them paid-but-still-Free. Sentry capture here is the
    // only signal we have to detect that scenario.
    try {
      return await handleNowpaymentsIpn(req, res);
    } catch (err) {
      logger.error("auth/nowpayments-ipn", "unhandled exception", {
        error: String(err),
      });
      captureError(err, { endpoint: "auth/nowpayments-ipn", phase: "unhandled" });
      // Return 500 so NOWPayments retries the IPN — they will, and
      // by the time of retry the transient cause is usually gone.
      // confirmIntent is idempotent so duplicate retries are safe.
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, reason: "internal_error" });
      }
      return;
    }
  }

  // Every browser-facing auth action reads or mints a session, so only
  // first-party origins (the website and the extension) get through. A
  // trading site or a website preview that merely passes the general CORS
  // allowlist must not be able to drive login / sync-token with the
  // visitor's cookie: sync-token returns a 30-day JWT and binds the
  // caller's install to the account.
  const corsOk = setCorsHeaders(req, res, { credentialedOnly: true });
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  // Wrap dispatch in a try/catch so an unhandled throw inside a
  // sub-handler (Upstash quota exceeded, Redis transient flake,
  // scrypt out of memory, …) doesn't bubble up to Vercel as
  // FUNCTION_INVOCATION_FAILED — that error path returns Vercel's
  // generic 500 page without the CORS headers we set above, so the
  // browser sees a CORS rejection instead of our error JSON and
  // surfaces "Failed to fetch" to the user. Catching here lets us
  // emit a proper response with the right CORS headers already in
  // place, and a structured body the client can show.
  //
  // The `await` on each handler is what makes this work — without it
  // we'd return the Promise unawaited and any rejection would land
  // back on Vercel, not in our catch.
  try {
    switch (action) {
      case "signup":
        return await handleSignup(req, res);
      case "login":
        return await handleLogin(req, res);
      case "logout":
        return await handleLogout(req, res);
      case "logout-all":
        return await handleLogoutAll(req, res);
      case "delete-account":
        return await handleDeleteAccount(req, res);
      case "verify-email":
        return await handleVerifyEmail(req, res);
      case "resend-verification":
        return await handleResendVerification(req, res);
      case "me":
        return await handleMe(req, res);
      case "sync-token":
        return await handleSyncToken(req, res);
      // ("nowpayments-ipn" never reaches this switch: it is answered above, outside the CORS gate.)
      default:
        return apiError(
          res,
          404,
          "Unknown auth action. Use signup | login | logout | logout-all | delete-account | verify-email | resend-verification | me | sync-token | nowpayments-ipn.",
        );
    }
  } catch (err) {
    // Most likely cause: Upstash daily/monthly quota exceeded — every
    // mutating auth handler (signup, login, logout, sync-token) writes
    // to Redis, so when the quota cap is hit those handlers throw and
    // we land here. Smaller incidents (transient Redis ECONNRESET, a
    // scrypt out of memory under load, a Vercel function reaching its CPU
    // budget) follow the same path.
    //
    // We classify the error to choose between 503 (transient, retry
    // makes sense) and 500 (generic). Both responses keep the CORS
    // headers the dispatcher set earlier, so the browser actually
    // surfaces our body to the page instead of dropping it as a CORS
    // failure — the website's auth.js shows the body's `message` to
    // the user verbatim ("Service temporarily unavailable — retry in
    // a minute") instead of the misleading "Failed to fetch".
    const errMsg = String((err as Error)?.message || err);
    logger.error(`auth/${action}`, "unhandled exception", { error: errMsg });
    captureError(err, { endpoint: `auth/${action}`, phase: "dispatcher-catch" });
    if (res.headersSent) return;
    const lower = errMsg.toLowerCase();
    const isQuotaOrTransient =
      lower.includes("upstash") ||
      lower.includes("daily limit") ||
      lower.includes("rate limit") ||
      lower.includes("quota") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("max requests");
    if (isQuotaOrTransient) {
      return res.status(503).json({
        ok: false,
        reason: "service_unavailable",
        message:
          "Service temporarily unavailable. Please try again in a few minutes.",
      });
    }
    return res.status(500).json({
      ok: false,
      reason: "internal_error",
      message: "An internal error occurred. Please try again.",
    });
  }
}

// Internals exported for unit tests so we don't need to mock req.query.action.
export const __test = {
  handleSignup,
  handleLogin,
  handleLogout,
  handleDeleteAccount,
  handleVerifyEmail,
  handleResendVerification,
  handleMe,
  handleSyncToken,
  handleNowpaymentsIpn,
};
