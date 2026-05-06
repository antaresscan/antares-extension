// api/graph.ts — Insider Network Graph + Top 10 Live Activity Feed
//
// This endpoint serves TWO related deep-analysis features that both
// need the top-holders + Helius data, so they share a single
// serverless-function slot (Vercel Hobby caps us at 12 functions):
//
//   GET /api/graph?ca={mint}                      → graph only
//   GET /api/graph?ca={mint}&activity=1&price={p} → graph + activity
//
// When `activity=1`, the response includes a `.activity` field with
// the recent on-chain actions of the top 10 holders inside a 6h
// window. The `price` query param is the current USD-per-token price
// (already known from the scan response on the caller side); used to
// compute USD values for each activity entry without an extra
// upstream lookup.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders, validateCA, checkRateLimit, getClientIp, initRateLimiters } from "./_lib/middleware";
import { apiError, settled } from "./_lib/helpers";
import { heliusGetLargestAccounts, heliusGetTokenSupply } from "./_lib/fetchers";
import { LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS } from "./_lib/constants";
import { buildInsiderGraph, initGraphCache } from "./_lib/insider-graph";
import { buildInsiderActivity, initActivityCache } from "./_lib/insider-activity";
import type { HeliusHolder } from "./_lib/types";
import { logger } from "./_lib/logger";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initGraphCache(redis);
  initActivityCache(redis);
  initRateLimiters(redis);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  // Dedicated rate limiting for /api/graph (expensive Helius calls)
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_API_KEY) return apiError(res, 503, "Helius API key not configured.");

  const ca = validateCA(req.query.ca);
  if (!ca) return apiError(res, 400, "Invalid token address.");

  try {
    // Fetch holders and supply in parallel
    const [holdersRaw, supplyRaw] = await Promise.all([
      settled(heliusGetLargestAccounts(ca, HELIUS_API_KEY)),
      settled(heliusGetTokenSupply(ca, HELIUS_API_KEY)),
    ]);

    const holders: HeliusHolder[] = (holdersRaw as { result?: { value?: HeliusHolder[] } })?.result?.value ?? [];
    const totalSupply: number = (supplyRaw as { result?: { value?: { uiAmount?: number } } })?.result?.value?.uiAmount ?? 0;

    if (!holders.length) {
      return apiError(res, 404, "No holder data available for this token.");
    }

    const lpAddresses = new Set([...LP_PROGRAM_ADDRESSES, ...FOUNDATION_WALLETS]);
    const graph = await buildInsiderGraph(ca, holders, totalSupply, HELIUS_API_KEY, lpAddresses);

    // Optional activity feed (Insider Watch tab). Only computed when
    // explicitly requested so /api/graph stays fast for graph-only
    // callers. Reuses the LP/foundation-filtered holder list to get
    // the top 10 wallet addresses, then delegates to
    // buildInsiderActivity which does its own per-wallet sig cache
    // (shared with insider-graph) + per-CA result cache (60s).
    let activity = null;
    if (req.query.activity === "1") {
      const filtered = holders.filter(
        (h) => !lpAddresses.has(h.address),
      );
      const topAddresses = filtered.slice(0, 10).map((h) => h.address);
      if (topAddresses.length > 0) {
        // Optional price hint — caller passes the DexScreener price
        // already known from the scan response, avoids a duplicate
        // upstream lookup. Falls back to null if missing/invalid;
        // helper then leaves usdValue=null per entry (UI shows "—").
        const priceParam = req.query.price;
        let tokenPriceUsd: number | null = null;
        if (typeof priceParam === "string") {
          const parsed = parseFloat(priceParam);
          if (Number.isFinite(parsed) && parsed > 0) tokenPriceUsd = parsed;
        }
        try {
          activity = await buildInsiderActivity(
            ca,
            topAddresses,
            tokenPriceUsd,
            HELIUS_API_KEY,
          );
        } catch (e) {
          // Don't fail the whole graph request if activity fetching
          // bombs — degrade gracefully to graph-only.
          logger.warn("graph", "activity fetch failed", { error: String(e) });
          activity = null;
        }
      }
    }

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.json({ ...graph, activity });
  } catch (e) {
    logger.error("graph", "Graph analysis failed", { error: String(e) });
    return apiError(res, 500, "Graph analysis failed.");
  }
}
