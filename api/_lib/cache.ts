// api/cache.ts — Redis scan cache logic
//
// Cache keys are namespaced by ENGINE_VERSION (constants.ts) — a manual
// version tag combined with a fingerprint of every scoring constant. When
// a weight, penalty or threshold changes, the fingerprint flips and old
// cache entries are silently bypassed (and TTL out within 24h). This
// prevents the "user sees DANGER, refreshes a minute later, sees SAFE"
// class of bug after a scoring deploy.
import { Redis } from "@upstash/redis";
import { computeCacheTTL } from "./helpers";
import { logger } from "./logger";
import { ENGINE_VERSION } from "./constants";
import { deploymentNamespace } from "./deployment";

let scanCacheRedis: Redis | null = null;

// A preview deployment gets its own namespace (see deployment.ts): it must neither read production's cached scans nor
// write into them. Production keys are unchanged.
export const cacheKey = (ca: string): string => `antares:${deploymentNamespace()}${ENGINE_VERSION}:${ca}`;
export const lockKey  = (ca: string): string => `antares:lock:${deploymentNamespace()}${ENGINE_VERSION}:${ca}`;

export function initCache(redis: Redis): void {
  scanCacheRedis = redis;
}

export function getCacheRedis(): Redis | null {
  return scanCacheRedis;
}

export async function getCachedResult<T = unknown>(ca: string, requestId: string): Promise<T | null> {
  if (!scanCacheRedis) return null;
  try {
    const result = await scanCacheRedis.get<T>(cacheKey(ca));
    return result ?? null;
  } catch (e: unknown) {
        logger.warn("cache", "cache miss or Redis error", { requestId, error: String(e) });
    return null;
  }
}

export function setCachedResult(
  ca: string,
  result: object,
  tokenAgeMinutes: number | null,
  verdict?: "SAFE" | "CAUTION" | "DANGER" | "RUG",
): void {
  if (!scanCacheRedis) return;
  const ttl = computeCacheTTL(tokenAgeMinutes, verdict);
  scanCacheRedis.setex(cacheKey(ca), ttl, result).catch((e: unknown) => {
        logger.warn("cache", "Redis cache write failed", { error: String(e) });
  });
}

/**
 * Short-TTL cache for incomplete results — used by scan.ts when the AI
 * summary hasn't landed yet but we still want to absorb a near-immediate
 * re-scan of the same CA (e.g. user reloads the page). 30s is the typical
 * TTL chosen by callers; longer values should use `setCachedResult`.
 *
 * Shares the engine-versioned key prefix with the regular cache, so a
 * scoring bump invalidates these too.
 */
export function setShortCachedResult(
  ca: string,
  result: object,
  ttlSeconds: number,
): void {
  if (!scanCacheRedis) return;
  scanCacheRedis.setex(cacheKey(ca), ttlSeconds, result).catch((e: unknown) => {
    logger.warn("cache", "Redis short-cache write failed", { error: String(e) });
  });
}

// ─── SINGLE-FLIGHT SCAN LOCK (cache-stampede protection) ─────────────────
//
// When a token starts trending, dozens of users scan the same uncached CA
// within the ~10s cold-scan window. Without coordination, every one of them
// sees a cache miss and runs its OWN full cold scan → N× upstream API calls
// (Helius/Solscan/RugCheck) and — because degraded scans resolve a different
// subset of sources — N inconsistent verdicts for the same token.
//
// The lock fixes this: the FIRST request to miss the cache acquires a short
// Redis lock and runs the single cold scan; everyone else waits for that
// scan to populate the cache and reads the identical result.
//
// CRITICAL: fail-open. Coalescing is an optimization, never a hard
// dependency — if Redis is unavailable or errors, acquireScanLock returns
// true so the scan ALWAYS proceeds. Worst case without Redis = the old
// behaviour (every request scans). We never block a scan on lock infra.

/**
 * Try to acquire the single-flight lock for `ca`.
 * @returns true  → THIS caller won the race; it must run the cold scan and
 *                  call releaseScanLock() when done.
 *          false → another request already holds the lock; this caller should
 *                  wait for the cache via waitForCachedResult().
 *
 * TTL (default 28s) is the safety net: it sits just above the 25s Vercel
 * function maxDuration so a crashed lock holder can't wedge the lock for
 * longer than its own function could possibly live.
 */
export async function acquireScanLock(ca: string, ttlSeconds = 28): Promise<boolean> {
  if (!scanCacheRedis) return true; // no Redis → no coalescing, always scan
  try {
    // Upstash SET ... NX EX — returns "OK" when set, null when the key
    // already exists (i.e. another request holds the lock).
    const res = await scanCacheRedis.set(lockKey(ca), "1", { nx: true, ex: ttlSeconds });
    return res === "OK";
  } catch (e: unknown) {
    logger.warn("cache", "scan lock acquire failed — failing open", { error: String(e) });
    return true; // fail-open: proceed with the scan
  }
}

/** Release the single-flight lock. Best-effort — TTL expiry is the backstop. */
export async function releaseScanLock(ca: string): Promise<void> {
  if (!scanCacheRedis) return;
  try {
    await scanCacheRedis.del(lockKey(ca));
  } catch {
    /* lock TTL will expire it; nothing to do */
  }
}

/**
 * Poll the cache until a COMPLETE (aiSummary-present) result appears for `ca`
 * or `timeoutMs` elapses. Used by requests that lost the single-flight race:
 * they wait for the lock holder's scan to land in the cache instead of
 * running a redundant cold scan.
 *
 * Returns the cached result, or null if the holder didn't finish in time
 * (caller then falls back to scanning itself with whatever budget remains).
 */
export async function waitForCachedResult<T extends { aiSummary?: unknown }>(
  ca: string,
  requestId: string,
  { timeoutMs = 18000, intervalMs = 250, maxIntervalMs = 900 }:
    { timeoutMs?: number; intervalMs?: number; maxIntervalMs?: number } = {},
): Promise<T | null> {
  if (!scanCacheRedis) return null;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    // Jittered backoff — critical for extreme stampedes (1000+ waiters on
    // ONE token). Two properties:
    //   • GROWTH: the interval widens each attempt (capped at maxIntervalMs)
    //     so early polls stay snappy for fast scans, while a long-running
    //     holder doesn't get hammered. Cuts total polls ~2× vs a fixed tick.
    //   • JITTER: a random offset de-synchronizes the waiters so 1000 of
    //     them don't all hit Redis on the same 250ms boundary (which would
    //     produce 1000-command bursts). Spreads the GET load smoothly.
    // Worst case Redis is still overwhelmed → getCachedResult fails open
    // (returns null) → the waiter keeps trying, then falls back to its own
    // scan on timeout. Never a crash.
    const grow = Math.min(maxIntervalMs, intervalMs * (1 + attempt * 0.2));
    const wait = grow + Math.random() * 120;
    await new Promise((r) => setTimeout(r, wait));
    const r = await getCachedResult<T>(ca, requestId);
    if (r && r.aiSummary) return r;
    attempt++;
  }
  return null;
}
