// api/auth/signup.ts — Create a new account from email + password.
//
//   POST /api/auth/signup
//   Body:    { email, password }
//   Returns: 200 + Set-Cookie (HTTP-only session) when created
//            409 already_exists, 400 invalid_email | weak_password
//
// We deliberately don't email-verify before issuing a session — for
// MVP we treat the email as a routing handle (where licenses go and
// where /account looks them up). Email-verification + password reset
// flows ship once we have an email-sending dependency wired
// (Resend/Postmark, post-launch).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  checkRateLimit,
  getClientIp,
  initRateLimiters,
} from "../_lib/middleware";
import { apiError } from "../_lib/helpers";
import { logger } from "../_lib/logger";
import { createAccount } from "../_lib/account";
import { setSessionCookie } from "../_lib/session-cookie";

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  // Rate-limit signup by IP — scrypt is intentionally CPU-heavy so we
  // also want a hard ceiling on requests/s to keep the function from
  // timing out under abuse.
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = String(body.email ?? "");
  const password = String(body.password ?? "");

  try {
    const outcome = await createAccount(redis, { email, password });
    if (!outcome.ok) {
      const status =
        outcome.reason === "already_exists" ? 409 : 400;
      return res.status(status).json({ ok: false, reason: outcome.reason });
    }
    setSessionCookie(res, outcome.account.email);
    logger.metric("auth.signup", { email: outcome.account.email });
    return res.status(200).json({
      ok: true,
      email: outcome.account.email,
    });
  } catch (err) {
    logger.error("auth/signup", "creation failed", { error: String(err) });
    // SESSION_SECRET unset surfaces here — surface as 503 so the page
    // can show "auth not configured" rather than the generic 500.
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not create account.");
  }
}
