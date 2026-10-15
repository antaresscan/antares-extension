// api/_lib/quota.ts — what the X-Antares-Quota-* headers and /api/quota say.
//
// There is no quota any more. Every tier (Free, Pro, Yearly, Lifetime) is unlimited, on the founder's call: the Free tier is the
// verdict, unlimited and fast; Pro is the explanation of the verdict. The only brake left is the per-minute rate limit in
// api/_lib/middleware.ts ("unlimited" never meant "scan as fast as you can spam"). The daily counter, the 429 "Daily limit reached"
// and the Redis keys behind them are gone (the counter was already switched off on 2026-05-11, the code stayed).
//
// What is kept here is the WIRE FORMAT, byte for byte, because the published extension (v1.3.22) reads it: its overlay draws the
// PRO / YEAR / LIFE badge and the Free view from X-Antares-Quota-Tier, and reads an unlimited tier as limit = -1. Do not change a
// value without shipping an extension that no longer needs it.
import type { VercelResponse } from "@vercel/node";
import type { Tier } from "./user";

export interface QuotaResult {
  used: number;
  remaining: number;
  /** -1 = unlimited, which is every tier. */
  limit: number;
  /** Epoch ms of the next reset. 0 = never (unlimited). */
  resetAt: number;
  tier: Tier;
}

/** What every caller gets: unlimited, labelled with its tier. */
export function unlimitedQuota(tier: Tier): QuotaResult {
  return { used: 0, remaining: -1, limit: -1, resetAt: 0, tier };
}

/**
 * Stamp the quota response headers. Headers are also exposed via Access-Control-Expose-Headers in the CORS middleware so client JS
 * can actually read them.
 */
export function setQuotaHeaders(res: VercelResponse, quota: QuotaResult): void {
  res.setHeader("X-Antares-Quota-Tier", quota.tier);
  res.setHeader("X-Antares-Quota-Limit", String(quota.limit));
  res.setHeader("X-Antares-Quota-Used", String(quota.used));
  res.setHeader("X-Antares-Quota-Remaining", String(quota.remaining));
  res.setHeader("X-Antares-Quota-Reset", String(quota.resetAt));
}
