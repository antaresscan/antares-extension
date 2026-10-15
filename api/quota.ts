// api/quota.ts — Read-only quota status endpoint.
//
// GET /api/quota
//   Headers in:  X-Antares-Install (recommended), Origin
//   Headers out: X-Antares-Quota-{Tier,Used,Limit,Remaining,Reset}
//   Body out:    { tier, used, limit, remaining, resetAt, unlimited, tierExpiresAt }
//                tierExpiresAt: epoch ms when a pro / yearly tier lapses, null otherwise (free, lifetime, dev grants).
//
// There is no scan quota any more (every tier is unlimited), so this only tells the caller its
// tier ("unlimited": true) and, for a pro / yearly tier, when it lapses. It is rate-limited the
// same as /api/scan. The body keeps the shape the extension and the Options page read.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  getClientIp,
  getInstallId,
  checkRateLimit,
  initRateLimiters,
} from "./_lib/middleware";
import { unlimitedQuota, setQuotaHeaders } from "./_lib/quota";
import { initUserStorage, resolveTier } from "./_lib/user";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initRateLimiters(redis);
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
    // Session-gated: logged-out users are Free regardless of what tier their install has stored.
    // Signing back in restores their paid tier without any data being mutated.
    const { tier: effectiveTier, tierExpiresAt } = await resolveTier(
      req,
      identityKey,
    );
    const quota = unlimitedQuota(effectiveTier);
    setQuotaHeaders(res, quota);

    // No-cache: the tier changes with the session, stale data is misleading.
    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.json({
      tier: quota.tier,
      used: quota.used,
      limit: quota.limit,
      remaining: quota.remaining,
      resetAt: quota.resetAt,
      unlimited: quota.limit === -1,
      tierExpiresAt: tierExpiresAt ?? null,
    });
  } catch (err) {
    logger.warn("api/quota", "peek failed", { error: String(err) });
    return apiError(res, 500, "Failed to read quota status.");
  }
}
