// api/insider-activity.ts — Top 10 holder live activity feed endpoint.
//
// GET /api/insider-activity?ca={mint}&price={priceUsd}
//   - mint:  base58 token CA (validated)
//   - price: optional, current USD price hint from caller (DexScreener)
//
// Pulls the top 10 holders from Helius (LP/foundation-filtered), then
// returns the recent on-chain actions of those wallets touching this
// mint inside a 6h window. Cached server-side 60s per CA so a chatty
// frontend or multiple users on the same token share one Helius round.

import type { VercelRequest, VercelResponse } from "@vercel/node"
import { Redis } from "@upstash/redis"
import {
  setCorsHeaders,
  validateCA,
  checkRateLimit,
  getClientIp,
  initRateLimiters,
} from "./_lib/middleware"
import { apiError, settled } from "./_lib/helpers"
import { heliusGetLargestAccounts } from "./_lib/fetchers"
import { LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS } from "./_lib/constants"
import {
  buildInsiderActivity,
  initActivityCache,
} from "./_lib/insider-activity"
import type { HeliusHolder } from "./_lib/types"

if (
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
  initActivityCache(redis)
  initRateLimiters(redis)
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  const corsOk = setCorsHeaders(req, res)
  if (req.method === "OPTIONS") return res.status(204).end()
  if (!corsOk) return apiError(res, 403, "Origin not allowed.")
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.")

  // Rate-limit shared with /api/graph + /api/scan — tied to client IP.
  // The 60s server cache absorbs most repeat hits but a single misbehaving
  // client shouldn't be able to exhaust Helius quota for everyone.
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(res, ip)
  if (!allowed) return

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY
  if (!HELIUS_API_KEY) {
    return apiError(res, 503, "Helius API key not configured.")
  }

  const ca = validateCA(req.query.ca)
  if (!ca) return apiError(res, 400, "Invalid token address.")

  // Optional price hint — caller already knows the DexScreener price
  // from the scan response, so we accept it as a query param to avoid
  // a second upstream lookup. Falls back to null if missing/invalid;
  // the helper then leaves usdValue=null per entry (UI shows "—").
  const priceParam = req.query.price
  let tokenPriceUsd: number | null = null
  if (typeof priceParam === "string") {
    const parsed = parseFloat(priceParam)
    if (Number.isFinite(parsed) && parsed > 0) tokenPriceUsd = parsed
  }

  try {
    const holdersRaw = await settled(
      heliusGetLargestAccounts(ca, HELIUS_API_KEY),
    )
    const holders: HeliusHolder[] =
      (
        holdersRaw as { result?: { value?: HeliusHolder[] } } | null
      )?.result?.value ?? []

    if (!holders.length) {
      // Don't 404 — frontend renders an honest empty state. Same payload
      // shape so the renderer doesn't have to special-case 404 vs empty.
      return res.json({
        activity: [],
        netFlowUsd: 0,
        windowHours: 6,
        generatedAt: Date.now(),
        totalCheckedWallets: 0,
        walletsWithActivity: 0,
      })
    }

    // Filter LPs and known foundation/treasury wallets — the activity of
    // a Raydium pool is "transfer out 10M tokens to a buyer" 200 times
    // a day, useless as insider signal. FOUNDATION_WALLETS is a
    // hand-curated list (USDC, USDT, JTO, JUP, MNGO, …) where seeing
    // them in top 10 means the token is paired with a real treasury
    // not a hidden insider.
    const filtered = holders.filter(
      (h) =>
        !LP_PROGRAM_ADDRESSES.has(h.address) &&
        !FOUNDATION_WALLETS.has(h.address),
    )

    const topAddresses = filtered.slice(0, 10).map((h) => h.address)

    if (!topAddresses.length) {
      return res.json({
        activity: [],
        netFlowUsd: 0,
        windowHours: 6,
        generatedAt: Date.now(),
        totalCheckedWallets: 0,
        walletsWithActivity: 0,
      })
    }

    const result = await buildInsiderActivity(
      ca,
      topAddresses,
      tokenPriceUsd,
      HELIUS_API_KEY,
    )

    // Edge cache 30s + s-maxage 60s (matches the inner Redis TTL) +
    // SWR 120s so a request landing right after expiry serves the stale
    // payload while we re-fetch in the background.
    res.setHeader(
      "Cache-Control",
      "public, max-age=30, s-maxage=60, stale-while-revalidate=120",
    )
    return res.json(result)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[insider-activity] error", e)
    return apiError(res, 500, "Failed to fetch insider activity.")
  }
}
