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
//
// Access (audit A-03): Insider Watch is a Pro feature and this is the
// most expensive endpoint we have (~120 Helius credits per mint nobody
// asked for yet, ~430 with the activity feed), so it is not open to
// anonymous or Free callers. In the order they are applied: the
// per-IP limiter, a Pro session (402 otherwise), 10 requests a minute
// per user, and a ceiling per UTC day for the whole service
// (GRAPH_GLOBAL_PER_DAY, 500 by default). No Redis = 503, because
// both guards live there. The answer depends on who asks, so it is
// never cached by a shared cache (private, no-store).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders, validateCA, checkRateLimit, getClientIp, getInstallId, initRateLimiters } from "./_lib/middleware";
import { apiError, settled } from "./_lib/helpers";
import { heliusGetLargestAccounts, heliusGetTokenSupply, heliusResolveAccountOwners } from "./_lib/fetchers";
import { readHeliusKey } from "./_lib/helius";
import { LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS } from "./_lib/constants";
import { buildInsiderGraph, initGraphCache } from "./_lib/insider-graph";
import { composeCriticalActors } from "./_lib/critical-actors";
import { buildInsiderActivity, initActivityCache } from "./_lib/insider-activity";
import type { HeliusHolder } from "./_lib/types";
import { logger } from "./_lib/logger";
import { initUsage, flushUsage } from "./_lib/usage";
import { initUserStorage, resolveTierAndBypass } from "./_lib/user";
import {
  initGraphAccess,
  graphAccessAvailable,
  graphUserKeyOf,
  checkGraphUserLimit,
  takeGraphDailyBudget,
  type GraphGuard,
} from "./_lib/graph-access";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initGraphCache(redis);
  initActivityCache(redis);
  initRateLimiters(redis);
  initUsage(redis);
  initUserStorage(redis);
  initGraphAccess(redis);
}

/** Answers a guard that said no: 429 + Retry-After when the caller must wait, 503 when the guard itself could not answer. */
function refuse(res: VercelResponse, guard: Exclude<GraphGuard, { ok: true }>): void {
  if (guard.reason === "limited") {
    res.setHeader("Retry-After", String(guard.retryAfterSec));
    return apiError(res, 429, "Too many Insider Watch requests. Please retry later.");
  }
  return apiError(res, 503, "Service temporarily unavailable. Please retry.");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  // setCorsHeaders leaves a short shared-cache window that suits public scan data. The answers of this endpoint depend on who
  // asks (402 for Free, 429 per user, Pro data): none of them may be served to someone else from a CDN cache.
  res.setHeader("Cache-Control", "private, no-store");
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  // Validate input BEFORE any async work. Validation is cheap and must
  // not depend on rate-limiter/Redis availability — otherwise a Redis
  // outage in CI (or prod) makes the endpoint answer invalid requests
  // with 500 instead of a clean 400. e2e contract: /api/graph (no ca)
  // and /api/graph?ca= must return 400, never 500.
  const ca = validateCA(req.query.ca);
  if (!ca) return apiError(res, 400, "Invalid token address.");

  // Dedicated rate limiting for /api/graph (expensive Helius calls)
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const HELIUS_API_KEY = readHeliusKey();
  if (!HELIUS_API_KEY) return apiError(res, 503, "Helius API key not configured.");

  // Both guards below live in Redis: without it this endpoint would run unguarded, so it does not run.
  if (!graphAccessAvailable()) return apiError(res, 503, "Service temporarily unavailable. Please retry.");

  // Pro only. The session (cookie or X-Antares-Session) is what proves the plan; the install id the client sends is only a
  // fallback identity, as for /api/scan.
  const identity = getInstallId(req) ?? ip;
  let userKey: string;
  try {
    const { tier } = await resolveTierAndBypass(req, identity);
    if (tier === "free") {
      logger.metric("graph.refused", { reason: "pro_required" });
      return apiError(res, 402, "Insider Watch is part of Antares Pro.", { code: "pro_required" });
    }
    userKey = await graphUserKeyOf(req, identity);
  } catch (e) {
    logger.warn("graph", "plan check failed — refusing", { error: String(e) });
    return apiError(res, 503, "Service temporarily unavailable. Please retry.");
  }

  // The user's own window first (cheap, and a refusal must not eat the shared budget), then the day's budget for everybody.
  const userGuard = await checkGraphUserLimit(userKey);
  if (!userGuard.ok) {
    logger.metric("graph.refused", { reason: `user_${userGuard.reason}` });
    return refuse(res, userGuard);
  }
  const dayGuard = await takeGraphDailyBudget();
  if (!dayGuard.ok) {
    logger.metric("graph.refused", { reason: `day_${dayGuard.reason}` });
    return refuse(res, dayGuard);
  }

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

    // getLargestAccounts returns SPL token-account addresses, but the transfers of a parsed transaction name OWNER wallets
    // (fromUserAccount / toUserAccount): a holder set that is not made of owners never matches a transfer counterparty. Resolve the
    // owners ONCE, first, for the graph and for the activity feed (heliusResolveAccountOwners falls back to the original address).
    // The graph used to be given the token accounts here, so it could not find a single cluster (audit M9); the scan, which built it
    // until now, already passed owners.
    const holdersWithOwners = await heliusResolveAccountOwners(holders, HELIUS_API_KEY);
    const filtered = holdersWithOwners.filter(
      (h) => !lpAddresses.has(h.address) && !lpAddresses.has(h.owner),
    );
    const graph = await buildInsiderGraph(
      ca,
      filtered.map((h) => ({ address: h.owner ?? h.address, uiAmount: h.uiAmount ?? 0 })),
      totalSupply,
      HELIUS_API_KEY,
      lpAddresses,
    );

    // The Cluster cards of the top of token.html. The scan no longer builds the graph (it cost ~120 Helius credits per cold scan for
    // a display-only feature), so its cards say "Holder #n"; token.html swaps in these ones, for the same wallets, once this answers.
    // Only the cards the scan cannot produce are returned. The creator is unknown here, so no Dev card is ever composed.
    const clusterActors = composeCriticalActors({
      tokenCreator: null,
      creatorReputation: null,
      realHolderAccounts: filtered,
      totalSupplyUi: totalSupply,
      insiderGraph: graph,
    }).filter((a) => a.type === "cluster");

    // Optional activity feed (Insider Watch tab). Only computed when
    // explicitly requested so /api/graph stays fast for graph-only
    // callers. Reuses the LP/foundation-filtered holder list to get
    // the top 10 wallet addresses, then delegates to
    // buildInsiderActivity which does its own per-wallet sig cache
    // (shared with insider-graph) + per-CA result cache (60s).
    let activity = null;
    if (req.query.activity === "1") {
      // `filtered` holds the OWNER wallets (resolved above): the activity feed matches them against tokenTransfers.
      // Build the snapshot list (owner + uiAmount) for the helper. The
      // helper uses `owner` for matching tokenTransfers and `uiAmount` +
      // totalSupply to compute pctSupply for the fallback wallet list.
      const topHolderSnapshots = filtered.slice(0, 10).map((h) => ({
        owner: h.owner ?? h.address,
        uiAmount: h.uiAmount ?? 0,
      }));
      if (topHolderSnapshots.length > 0) {
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
            topHolderSnapshots,
            totalSupply,
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

    res.setHeader("Cache-Control", "private, no-store");
    await flushUsage(); // upstream-usage counters of this request: one Redis command, at most 300 ms
    return res.json({ ...graph, activity, clusterActors });
  } catch (e) {
    logger.error("graph", "Graph analysis failed", { error: String(e) });
    return apiError(res, 500, "Graph analysis failed.");
  }
}
