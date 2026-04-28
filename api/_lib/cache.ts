// api/cache.ts — Redis scan cache logic
import { Redis } from "@upstash/redis";
import { computeCacheTTL } from "./helpers";
import { logger } from "./logger";

let scanCacheRedis: Redis | null = null;

export function initCache(redis: Redis): void {
  scanCacheRedis = redis;
}

export function getCacheRedis(): Redis | null {
  return scanCacheRedis;
}

export async function getCachedResult<T = unknown>(ca: string, requestId: string): Promise<T | null> {
  if (!scanCacheRedis) return null;
  try {
    const result = await scanCacheRedis.get<T>(`antares:v13:${ca}`);
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
  scanCacheRedis.setex(`antares:v13:${ca}`, ttl, result).catch((e: unknown) => {
        logger.warn("cache", "Redis cache write failed", { error: String(e) });
  });
}
