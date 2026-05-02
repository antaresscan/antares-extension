// api/auth/me.ts — Return the currently logged-in account, or 401.
//
//   GET /api/auth/me
//   Returns: 200 { email } when cookie is valid
//            401 when cookie is missing/invalid/expired
//
// Used by the website pages to decide whether to show "Log in" or
// "Logged in as <email>" in the nav, and by /account.html to gate
// the licenses view.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders } from "../_lib/middleware";
import { apiError } from "../_lib/helpers";
import { logger } from "../_lib/logger";
import { getAccountFromRequest } from "../_lib/session-cookie";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }
    return res.json({
      ok: true,
      email: account.email,
      emailVerified: account.emailVerified,
      createdAt: account.createdAt,
    });
  } catch (err) {
    logger.error("auth/me", "lookup failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not read session.");
  }
}
