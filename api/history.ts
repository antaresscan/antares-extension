// api/history.ts — Per-user scan history.
//
//   GET /api/history?limit=<n>&since=<ms>  → { items, count, retentionDays, tier }
//
// Tier policy:
//   Free          last 10 entries, any time window
//   Pro/Lifetime  last 100 entries from last 30 days (`since` clamps to 30d)
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

const FREE_HISTORY_LIMIT = 10;
const PRO_HISTORY_LIMIT = 100;
const FREE_RETENTION_DAYS = HISTORY_DAY_WINDOW;
const PRO_RETENTION_DAYS = HISTORY_DAY_WINDOW;

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
    // Session-gated tier resolution: signed-out users see Free history
    // (10 entries); signed-in users get their account tier's window.
    // Dev-tier override flows through the same path for dev-allowlisted
    // emails — see api/_lib/user.ts:getEffectiveTierFromRequest.
    const tier = await getEffectiveTierFromRequest(req, installId);
    const isPaid = tier === "pro" || tier === "yearly" || tier === "lifetime";

    const maxLimit = isPaid ? PRO_HISTORY_LIMIT : FREE_HISTORY_LIMIT;
    const limit = clampInt(req.query.limit, 1, maxLimit, maxLimit);

    const retentionDays = isPaid ? PRO_RETENTION_DAYS : FREE_RETENTION_DAYS;
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
    const minSinceMs = Date.now() - retentionMs;

    // Honour user-supplied `since` only if it's stricter than the tier floor —
    // a Free user can't ask for older data than their tier permits.
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
