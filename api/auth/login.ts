// api/auth/login.ts — Authenticate against an existing account.
//
//   POST /api/auth/login
//   Body:    { email, password }
//   Returns: 200 + Set-Cookie on success
//            401 invalid_credentials otherwise (no enumeration leak)
//
// Constant-time compare in verifyPassword + a dummy hash on
// nonexistent accounts in authenticate() means the response time
// looks the same whether the email exists or the password is wrong.
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
import { authenticate } from "../_lib/account";
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

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = String(body.email ?? "");
  const password = String(body.password ?? "");

  try {
    const outcome = await authenticate(redis, { email, password });
    if (!outcome.ok) {
      // 401 not 404 — never differentiate "no account" from "wrong
      // password" or we leak account existence.
      return res
        .status(401)
        .json({ ok: false, reason: "invalid_credentials" });
    }
    setSessionCookie(res, outcome.account.email);
    logger.metric("auth.login", { email: outcome.account.email });
    return res.status(200).json({
      ok: true,
      email: outcome.account.email,
    });
  } catch (err) {
    logger.error("auth/login", "auth failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not log in.");
  }
}
