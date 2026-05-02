// api/quota.ts — Read-only quota status endpoint.
//
// GET /api/quota
//   Headers in:  X-Antares-Install (recommended), Origin
//   Headers out: X-Antares-Quota-{Tier,Used,Limit,Remaining,Reset}
//   Body out:    { tier, used, limit, remaining, resetAt, unlimited }
//
// The extension overlay uses this to display "47/50 today" without spending
// one of the user's scans on a UI refresh. The endpoint is rate-limited the
// same as /api/scan but does NOT increment the daily counter.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  getClientIp,
  getInstallId,
  checkRateLimit,
  initRateLimiters,
} from "./_lib/middleware";
import { initQuota, peekDailyQuota, setQuotaHeaders } from "./_lib/quota";
import { initUserStorage, getEffectiveTier } from "./_lib/user";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initRateLimiters(redis);
  initQuota(redis);
  initUserStorage(redis);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const ip = getClientIp(req);
  const installId = getInstallId(req);
  const rateLimitOk = await checkRateLimit(res, ip, installId);
  if (!rateLimitOk) return;

  const identityKey = installId ?? ip;

  try {
    // Honour the X-Antares-Dev-Tier header for installs in DEV_PRO_INSTALLS.
    const effectiveTier = await getEffectiveTier(
      identityKey,
      req.headers["x-antares-dev-tier"],
    );
    const quota = await peekDailyQuota(identityKey, effectiveTier);
    setQuotaHeaders(res, quota);

    // No-cache: quota state changes per request, stale data is misleading.
    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.json({
      tier: quota.tier,
      used: quota.used,
      limit: quota.limit,
      remaining: quota.remaining,
      resetAt: quota.resetAt,
      unlimited: quota.limit === -1,
    });
  } catch (err) {
    logger.warn("api/quota", "peek failed", { error: String(err) });
    return apiError(res, 500, "Failed to read quota status.");
  }
}
