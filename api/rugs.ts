// api/rugs.ts — Wall of Shame endpoint: returns recent rug-flagged tokens
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders, checkRateLimit, getClientIp, initRateLimiters } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { initRugDb, getRecentRugs, getRugEntry } from "./_lib/rugdb";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initRugDb(redis);
  initRateLimiters(redis);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  // Rate limiting (same as /api/graph)
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  // Single token lookup: /api/rugs?mint=xxx
  const mint = typeof req.query.mint === "string" ? req.query.mint.trim() : null;
  if (mint) {
    const entry = await getRugEntry(mint);
    return res.json({ found: !!entry, entry });
  }

  // List recent rugs: /api/rugs?limit=50
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);
  const rugs = await getRecentRugs(limit);
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.json({ count: rugs.length, rugs });
}
