// api/watchlist.ts — Per-user token watchlist (Pro v1).
//
//   GET    /api/watchlist                  → { items, count, max, tier }
//   POST   /api/watchlist  { address }     → { added, count, max, tier, reason? }
//   DELETE /api/watchlist?address=<ca>     → { removed, tier }
//
// Limits: Free 5 items, Pro/Lifetime 50. Limit-reached returns 402 Payment
// Required so the extension UI can route Free users to the upgrade flow.
//
// install_id (X-Antares-Install header) is required — anonymous traffic has
// no persistent identity to bind a watchlist to.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  getClientIp,
  getInstallId,
  checkRateLimit,
  initRateLimiters,
  validateCA,
} from "./_lib/middleware";
import { initQuota } from "./_lib/quota";
import {
  initUserStorage,
  getUserTier,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  watchlistMaxFor,
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

function readBodyAddress(req: VercelRequest): unknown {
  const body = req.body as unknown;
  if (body && typeof body === "object" && "address" in body) {
    return (body as { address: unknown }).address;
  }
  // Some clients post raw JSON strings — best-effort parse
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { address?: unknown };
      return parsed?.address;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  // Override allow-methods because watchlist needs POST/DELETE in addition to GET.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");

  const ip = getClientIp(req);
  const installId = getInstallId(req);
  if (!installId) {
    return apiError(res, 401, "X-Antares-Install header required.");
  }

  const rateLimitOk = await checkRateLimit(res, ip, installId);
  if (!rateLimitOk) return;

  // Watchlist state changes per request — never cache, never reuse stale state.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const tier = await getUserTier(installId);

  try {
    if (req.method === "GET") {
      const items = await getWatchlist(installId);
      return res.json({
        items,
        count: items.length,
        max: watchlistMaxFor(tier),
        tier,
      });
    }

    if (req.method === "POST") {
      const rawAddress = readBodyAddress(req);
      const address = validateCA(rawAddress);
      if (!address) {
        return apiError(res, 400, "Body must include a valid Solana token address.");
      }
      const result = await addToWatchlist(installId, address, tier);
      // 402 signals "limit reached, upgrade to Pro" — the UI can route to /pricing.
      const status = !result.added && result.reason === "limit_reached" ? 402 : 200;
      return res.status(status).json({ ...result, tier });
    }

    if (req.method === "DELETE") {
      const queryAddress =
        typeof req.query.address === "string" ? req.query.address : undefined;
      const rawAddress = queryAddress ?? readBodyAddress(req);
      const address = validateCA(rawAddress);
      if (!address) {
        return apiError(res, 400, "Provide ?address=<ca> or {address: ca} body.");
      }
      const removed = await removeFromWatchlist(installId, address);
      return res.json({ removed, address, tier });
    }

    return apiError(res, 405, "Method not allowed.");
  } catch (err) {
    logger.error("api/watchlist", "handler error", { error: String(err), method: req.method });
    return apiError(res, 500, "Watchlist operation failed.");
  }
}
