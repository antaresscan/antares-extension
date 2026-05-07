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

let scanCacheRedis: Redis | null = null;

const cacheKey = (ca: string): string => `antares:${ENGINE_VERSION}:${ca}`;

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
