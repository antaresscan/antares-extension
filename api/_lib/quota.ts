// api/_lib/quota.ts — Daily scan quota for tiered access.
//
// Free tier:    UNLIMITED scans (still subject to the per-minute rate limit
//               upstream). Tier is used purely for feature gating in the
//               overlay (Critical Flags, Full Analysis, AI Summary remain
//               Pro-locked). Removed the 50/day cap on the founder's call —
//               we'd rather let everyone scan freely than create friction
//               on the core scanning experience.
// Pro tier:     unlimited.
// Lifetime:     unlimited, same as Pro.
//
// Storage:
//   user:{key}:tier            → "free" | "pro" | "lifetime"  (string)
//   quota:{key}:{YYYY-MM-DD}   → INCR counter (kept for future analytics
//                                / abuse detection; doesn't affect access)
//
// Behaviour:
//   - All tiers return UNLIMITED on every request. The counter is no
//     longer the gate; we keep it for visibility but `allowed` is always
//     true.
//   - Per-minute rate limit (api/_lib/middleware.ts) is still in force —
//     unlimited doesn't mean "scan as fast as you can spam".
import type { VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { getUserTier, type Tier } from "./user";

export const FREE_TIER_DAILY_LIMIT = 50; // legacy, kept for back-compat tests

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
  /**
   * Legacy parameter — historically requested the dev quota bypass when
   * `bypassQuota: true`. Now a no-op because every tier is unlimited.
   * Kept on the signature so the call sites in scan.ts / quota.ts don't
   * need a coordinated update.
   */
  _options: { bypassQuota?: boolean } = {},
): Promise<QuotaResult> {
  // All tiers are unlimited now. The counter is best-effort instrumentation
  // (useful later for abuse detection / analytics dashboards), but it does
  // not gate access — `allowed: true` for everyone, every time.
  if (!redisConfigured || !redis) {
    const tier = precomputedTier ?? "free";
    return UNLIMITED_RESULT(tier);
  }

  const key = identityKey ?? "anonymous";
  const tier = precomputedTier ?? (await getUserTier(key));

  // Best-effort INCR for visibility. Failure is silently ignored — the
  // counter is not a gate any more, just a metric. We still TTL-pin on
  // first write so old keys clean up and analytics queries can use the
  // YYYY-MM-DD suffix as a partition.
  if (tier === "free") {
    void incrementCounterBestEffort(key);
  }

  return UNLIMITED_RESULT(tier);
}

async function incrementCounterBestEffort(key: string): Promise<void> {
  if (!redis) return;
  try {
    const today = getUtcDateKey();
    const quotaKey = `quota:${key}:${today}`;
    const used = await redis.incr(quotaKey);
    if (used === 1) {
      const resetAt = getResetAt();
      const ttlSeconds = Math.ceil((resetAt - Date.now()) / 1000) + 60;
      await redis.expire(quotaKey, ttlSeconds);
    }
  } catch {
    // Silent — counter is not a gate.
  }
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
  /** Same tier override semantics as checkDailyQuota above. */
  precomputedTier?: Tier,
  /** Legacy bypass parameter — no-op now (every tier is unlimited). */
  _options: { bypassQuota?: boolean } = {},
): Promise<QuotaResult> {
  // Mirror of checkDailyQuota: every tier is unlimited. We don't even
  // bother reading the counter for the peek — there's no gating decision
  // to inform.
  const tier = precomputedTier ?? (
    redisConfigured && redis && identityKey
      ? await getUserTier(identityKey)
      : "free"
  );
  return UNLIMITED_RESULT(tier);
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
