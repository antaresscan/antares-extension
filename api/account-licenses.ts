// api/account-licenses.ts — List licenses for an email, gated by proof.
//
//   POST /api/account-licenses
//   Body:    { email: string, license_key: string }
//   Returns: { licenses: License[] } on success
//            403 on email/key mismatch (treated as auth failure)
//
// Why POST not GET: we want to keep both fields out of access logs and
// the URL bar — license keys are credentials. POST + JSON body is the
// least leaky option without standing up a session/cookie layer.
//
// Auth model, two paths:
//   - the session of an account whose e-mail is confirmed (what /account.html uses): every licence of the e-mail, keys in full;
//   - the legacy proof, e-mail + ONE licence key of that e-mail (no first-party client uses it any more): the list of the
//     purchases, but only the key that was shown comes back in full; the others are masked ("ANT-7K2M..."). A key is a
//     credential for ONE licence (whoever holds it redeems it, api/redeem.ts, which also answers with its e-mail): it used to
//     hand out every other key of the buyer, the unredeemed ones included, to whoever held one (a pass given to a friend, a key
//     pasted in a chat). The full keys are behind the session, i.e. behind the confirmed e-mail (audit A-01).
//
// Rate limit: the shared per-network window of checkRateLimit (60 per minute). Brute-force is infeasible against the 80-bit
// key space anyway, but rate-limiting closes the timing-attack door.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  checkRateLimit,
  getClientIp,
  initRateLimiters,
} from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { emailRef, maskLicenseKey } from "./_lib/log-ref";
import { initSentry, captureError } from "./_lib/sentry";

initSentry();
import {
  getLicensesByEmail,
  isValidLicenseKey,
  normalizeEmail,
  type License,
} from "./_lib/license";
import { getAccountFromRequest } from "./_lib/session-cookie";
import { emailProofOf, isEmailProven } from "./_lib/email-proof";

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

/**
 * Strip server-only fields from the response. The buyer doesn't need
 * intent references in the UI, and exposing them invites someone to
 * try to look up other intents by reference.
 */
function sanitize(license: License): Record<string, unknown> {
  return {
    key: license.key,
    tier: license.tier,
    amountUsd: license.amountUsd,
    createdAt: license.createdAt,
    expiresAt: license.expiresAt ?? null,
    redeemed: license.redeemed,
    redeemedAt: license.redeemedAt ?? null,
    // redeemedBy install_id is a private system identifier — exposing
    // it would let one buyer see if their license was redeemed on
    // someone else's machine, which is fine, but we mask it for
    // good-hygiene reasons (no install_id leakage cross-account).
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res, { credentialedOnly: true }); // account state: first-party origins only
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const redis = getRedis();
  if (!redis) {
    return apiError(res, 503, "Storage unavailable.");
  }
  initRateLimiters(redis);

  // Standard 60-req/min network limit covers brute-force; the 80-bit key
  // space makes guessing infeasible anyway, but rate-limiting closes
  // the door on enumeration timing.
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  // Two auth paths:
  //   1. Session cookie (preferred) — logged-in users on /account get
  //      the full list without needing to type a license key.
  //   2. Legacy email + license_key — pre-account buyers who just
  //      have the artifacts from the pricing modal can still recover
  //      their license list. Kept for the launch window so existing
  //      buyers aren't locked out; will be deprecated once the
  //      account flow is universal.
  let authedEmail: string | null = null;
  try {
    const account = await getAccountFromRequest(req, redis);
    if (account) {
      // An address nobody has confirmed owns no licence (audit A-01): a signed-in account that has not proved its e-mail gets an empty
      // list and the reason, not an error (it is signed in; it just has nothing yet). Confirming the e-mail brings the licences.
      if (!isEmailProven(account)) {
        return res.json({ ok: true, email: account.email, licenses: [], emailProof: emailProofOf(account) });
      }
      authedEmail = account.email;
    }
  } catch {
    // SESSION_SECRET unset, etc. Fall through to legacy auth.
  }

  let email: string | null = null;
  // Cache the first lookup so the legacy proof-verify path doesn't
  // double-charge Redis with two getLicensesByEmail calls.
  let prefetched: License[] | null = null;
  // The key shown as proof (legacy path only): the one key that comes back in full.
  let proofKey: string | null = null;
  if (authedEmail) {
    email = authedEmail;
  } else {
    const body = readBody(req);
    email = normalizeEmail(body.email);
    proofKey = String(body.license_key ?? "").trim().toUpperCase();
    if (!email) {
      return apiError(res, 400, "Valid email required in body.");
    }
    if (!isValidLicenseKey(proofKey)) {
      return apiError(res, 400, "Valid license_key required in body.");
    }
    try {
      prefetched = await getLicensesByEmail(redis, email);
      const matches = prefetched.find((l) => l.key === proofKey);
      if (!matches) {
        return res
          .status(403)
          .json({ ok: false, reason: "invalid_credentials" });
      }
    } catch (err) {
      logger.error("account-licenses", "lookup failed", { error: String(err) });
      captureError(err, { endpoint: "account-licenses", phase: "preflightAuth" });
      return apiError(res, 500, "Could not look up licenses.");
    }
  }

  try {
    const licenses = prefetched ?? (await getLicensesByEmail(redis, email));
    logger.metric("account-licenses.read", {
      emailRef: emailRef(email),
      count: licenses.length,
      via: authedEmail ? "session" : "license_key",
    });
    // Legacy path: only the key that was shown comes back in full (see the header).
    const view = (l: License) => {
      const out = sanitize(l);
      return proofKey !== null && l.key !== proofKey ? { ...out, key: maskLicenseKey(l.key) } : out;
    };
    return res.json({
      ok: true,
      email,
      licenses: licenses.map(view),
    });
  } catch (err) {
    logger.error("account-licenses", "lookup failed", { error: String(err) });
    captureError(err, { endpoint: "account-licenses", phase: "list" });
    return apiError(res, 500, "Could not look up licenses.");
  }
}

