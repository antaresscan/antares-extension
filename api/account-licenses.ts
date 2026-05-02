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
// Auth model: there are no passwords or sessions. The license key
// itself is the credential — knowing one license key for an email
// proves ownership of that email (because the key was generated
// server-side and only delivered to the buyer). Once proof checks
// out, we return all licenses for that email so the buyer can see
// every Pro 30-day pass and Lifetime they've ever bought.
//
// Rate limit: 5 requests per minute per IP via the existing
// withMiddleware helper. Brute-force is infeasible against the 80-bit
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
import {
  getLicensesByEmail,
  isValidLicenseKey,
  normalizeEmail,
  type License,
} from "./_lib/license";

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
  const corsOk = setCorsHeaders(req, res);
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

  // Standard 30-req/min IP limit covers brute-force; the 80-bit key
  // space makes guessing infeasible anyway, but rate-limiting closes
  // the door on enumeration timing.
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = normalizeEmail(body.email);
  const proofKey = String(body.license_key ?? "").trim().toUpperCase();

  if (!email) {
    return apiError(res, 400, "Valid email required in body.");
  }
  if (!isValidLicenseKey(proofKey)) {
    return apiError(res, 400, "Valid license_key required in body.");
  }

  try {
    const licenses = await getLicensesByEmail(redis, email);
    // Verify the proof: at least one of the licenses owned by this
    // email must match the supplied key. Otherwise this is either an
    // unknown email/key combination or someone fishing.
    const matches = licenses.find((l) => l.key === proofKey);
    if (!matches) {
      // 403 not 404: we don't differentiate "no licenses for this
      // email" from "wrong key" — that would let an attacker
      // enumerate which emails have ever bought.
      return res.status(403).json({ ok: false, reason: "invalid_credentials" });
    }

    logger.metric("account-licenses.read", {
      email,
      count: licenses.length,
    });

    return res.json({
      ok: true,
      email,
      licenses: licenses.map(sanitize),
    });
  } catch (err) {
    logger.error("account-licenses", "lookup failed", { error: String(err) });
    return apiError(res, 500, "Could not look up licenses.");
  }
}

