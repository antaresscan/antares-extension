// api/history.ts — Per-user scan history.
//
//   GET /api/history?limit=<n>&since=<ms>  → { items, count, retentionDays, tier }
//
// The same for everyone: up to 100 entries from the last 30 days (`since` clamps to 30 days). The Free tier is the verdict, unlimited;
// only the explanation of the verdict is a Pro feature, so the tier changes nothing here. It is still reported in the answer, for the
// clients that read it.
//
// Storage is populated by /api/scan on every successful scan when an
// install_id is present. Anonymous scans don't push history (no identity
// to bind to).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  getClientIp,
  getInstallId,
  checkRateLimit,
  initRateLimiters,
} from "./_lib/middleware";
import { initQuota } from "./_lib/quota";
import {
  initUserStorage,
  getEffectiveTierFromRequest,
  getScanHistory,
  HISTORY_DAY_WINDOW,
} from "./_lib/user";
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

const HISTORY_LIMIT = 100;
const RETENTION_DAYS = HISTORY_DAY_WINDOW;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const ip = getClientIp(req);
  const installId = getInstallId(req);
  if (!installId) {
    return apiError(res, 401, "X-Antares-Install header required.");
  }

  const rateLimitOk = await checkRateLimit(res, ip, installId);
  if (!rateLimitOk) return;

  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    // The tier is only reported (the clients that read it keep reading it): it does not change what the caller gets.
    const tier = await getEffectiveTierFromRequest(req, installId);

    const limit = clampInt(req.query.limit, 1, HISTORY_LIMIT, HISTORY_LIMIT);

    const retentionDays = RETENTION_DAYS;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const minSinceMs = Date.now() - retentionMs;

    // Honour user-supplied `since` only if it's stricter than the retention window — nobody can ask for older data than it keeps.
    const requestedSince = clampInt(
      req.query.since,
      minSinceMs,
      Date.now(),
      minSinceMs,
    );
    const sinceMs = Math.max(requestedSince, minSinceMs);

    const items = await getScanHistory(installId, { limit, sinceMs });

    return res.json({
      items,
      count: items.length,
      tier,
      retentionDays,
      limit,
      sinceMs,
    });
  } catch (err) {
    logger.error("api/history", "handler error", { error: String(err) });
    return apiError(res, 500, "History read failed.");
  }
}
