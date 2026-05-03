// api/_lib/quota.ts — Daily scan quota for tiered access.
//
// Free tier:    50 scans / UTC day, counted per install_id (or IP fallback).
// Pro tier:     unlimited (still subject to the per-minute rate limit upstream).
// Lifetime:     unlimited, same as Pro.
//
// Storage:
//   user:{key}:tier            → "free" | "pro" | "lifetime"  (string)
//   quota:{key}:{YYYY-MM-DD}   → INCR counter, TTL set to next 00:00 UTC
//
// Behaviour:
//   - Pro/Lifetime bypass the counter entirely.
//   - Free hits a hard ceiling at 50; we INCR first then deny if over, so
//     concurrent requests can't exceed by more than the in-flight count.
//   - If Redis is misbehaving we fail open (allow the request) — locking
//     out the entire Free tier on a transient Upstash blip would be worse
//     than letting a few extra scans through.
import type { VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";
import { getUserTier, type Tier } from "./user";

export const FREE_TIER_DAILY_LIMIT = 50;

// Re-export Tier for callers that already import from quota.ts
export type { Tier };

export interface QuotaResult {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
  /** Epoch ms of next 00:00 UTC. 0 when tier is unlimited. */
  resetAt: number;
  tier: Tier;
}

let redis: Redis | null = null;
let redisConfigured = false;

export function initQuota(redisInstance: Redis): void {
  redis = redisInstance;
  redisConfigured = true;
}

/** Reset quota state — only intended for tests. */
export function _resetQuotaForTests(): void {
  redis = null;
  redisConfigured = false;
}

/** Returns the next 00:00 UTC as an epoch-ms timestamp. */
export function getResetAt(now: Date = new Date()): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

/** Format a Date as "YYYY-MM-DD" in UTC for use in quota keys. */
export function getUtcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const UNLIMITED_RESULT = (tier: Tier): QuotaResult => ({
  allowed: true,
  used: 0,
  remaining: -1,
  limit: -1,
  resetAt: 0,
  tier,
});

const PERMISSIVE_FREE_RESULT = (resetAt: number): QuotaResult => ({
  allowed: true,
  used: 0,
  remaining: FREE_TIER_DAILY_LIMIT,
  limit: FREE_TIER_DAILY_LIMIT,
  resetAt,
  tier: "free",
});

/**
 * Increment the daily counter and decide whether to allow the request.
 *
 * Pro/Lifetime tiers bypass the counter entirely. Free tier requests above
 * the daily ceiling get `allowed: false` with a `resetAt` timestamp the
 * caller can surface in `Retry-After`.
 *
 * @param identityKey  Stable per-user key (typically install_id; falls
 *                     back to IP for anonymous calls so quota can't be
 *                     bypassed by omitting the install header).
 */
export async function checkDailyQuota(
  identityKey: string | null,
  /**
   * Pre-resolved tier (from `getEffectiveTier(req)`) — pass when the
   * caller has already applied the dev-mode override so we don't
   * double-read tier state. Otherwise falls back to the canonical
   * `getUserTier()` lookup.
   */
  precomputedTier?: Tier,
): Promise<QuotaResult> {
  const resetAt = getResetAt();

  // Local/test environments without Redis → treat as Free with full quota
  // available. Production always has Redis configured via initQuota().
  if (!redisConfigured || !redis) {
    return PERMISSIVE_FREE_RESULT(resetAt);
  }

  // Anonymous traffic shares a single bucket so quota can't be bypassed by
  // dropping the install header. Per-IP rate limit upstream already limits
  // the damage one anonymous client can do.
  const key = identityKey ?? "anonymous";

  const tier = precomputedTier ?? (await getUserTier(key));
  if (tier !== "free") return UNLIMITED_RESULT(tier);

  const today = getUtcDateKey();
  const quotaKey = `quota:${key}:${today}`;

  let used = 0;
  try {
    used = await redis.incr(quotaKey);
    if (used === 1) {
      // First request of the day — pin TTL to next midnight UTC plus a 60s
      // grace window for clock skew. Without this the key would persist
      // forever (Upstash default), which is fine for cleanup but pointless
      // since tomorrow uses a new key anyway.
      const ttlSeconds =
        Math.ceil((resetAt - Date.now()) / 1000) + 60;
      await redis.expire(quotaKey, ttlSeconds);
    }
  } catch (err) {
    logger.warn("quota", "Counter INCR failed — failing open", { error: String(err) });
    return PERMISSIVE_FREE_RESULT(resetAt);
  }

  const allowed = used <= FREE_TIER_DAILY_LIMIT;

  return {
    allowed,
    used,
    remaining: Math.max(0, FREE_TIER_DAILY_LIMIT - used),
    limit: FREE_TIER_DAILY_LIMIT,
    resetAt,
    tier: "free",
  };
}

/**
 * Read-only quota status without incrementing the counter. Used by the
 * `/api/quota` endpoint so the extension can display "47/50 today" in the
 * overlay without spending one of the user's scans just to refresh the UI.
 *
 * Same fail-open semantics as checkDailyQuota — a Redis hiccup returns a
 * permissive Free result rather than locking the UI into "0 remaining".
 */
export async function peekDailyQuota(
  identityKey: string | null,
  /** Same dev-tier override semantics as checkDailyQuota above. */
  precomputedTier?: Tier,
): Promise<QuotaResult> {
  const resetAt = getResetAt();

  if (!redisConfigured || !redis) {
    return PERMISSIVE_FREE_RESULT(resetAt);
  }

  const key = identityKey ?? "anonymous";

  const tier = precomputedTier ?? (await getUserTier(key));
  if (tier !== "free") return UNLIMITED_RESULT(tier);

  const today = getUtcDateKey();
  const quotaKey = `quota:${key}:${today}`;

  let used = 0;
  try {
    const raw = await redis.get<number | string>(quotaKey);
    if (typeof raw === "number") {
      used = raw;
    } else if (typeof raw === "string") {
      const parsed = parseInt(raw, 10);
      used = Number.isFinite(parsed) ? parsed : 0;
    }
  } catch (err) {
    logger.warn("quota", "peek failed — falling open", { error: String(err) });
    return PERMISSIVE_FREE_RESULT(resetAt);
  }

  // `<` not `<=`: the question is "would the *next* scan be allowed",
  // and a peek doesn't add to the counter.
  return {
    allowed: used < FREE_TIER_DAILY_LIMIT,
    used,
    remaining: Math.max(0, FREE_TIER_DAILY_LIMIT - used),
    limit: FREE_TIER_DAILY_LIMIT,
    resetAt,
    tier: "free",
  };
}

/**
 * Stamp standard quota response headers. Call on both success and 429 paths
 * so the extension UI always knows where the user stands without making a
 * second request.
 *
 * Headers are also exposed via Access-Control-Expose-Headers in the CORS
 * middleware so client JS can actually read them.
 */
export function setQuotaHeaders(res: VercelResponse, quota: QuotaResult): void {
  res.setHeader("X-Antares-Quota-Tier", quota.tier);
  res.setHeader("X-Antares-Quota-Limit", String(quota.limit));
  res.setHeader("X-Antares-Quota-Used", String(quota.used));
  res.setHeader("X-Antares-Quota-Remaining", String(quota.remaining));
  res.setHeader("X-Antares-Quota-Reset", String(quota.resetAt));
}

/**
 * Number of seconds until the quota resets. Used for the `Retry-After`
 * header on 429 responses. Returns at least 1 to avoid clients spinning.
 */
export function secondsUntilReset(quota: QuotaResult): number {
  if (quota.resetAt <= 0) return 1;
  return Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000));
}
