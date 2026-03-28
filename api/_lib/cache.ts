// api/cache.ts — Redis scan cache logic
import { Redis } from "@upstash/redis";
import { computeCacheTTL } from "./helpers";

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
    const result = await scanCacheRedis.get<T>(`antares:v2:${ca}`);
    return result ?? null;
  } catch (e: unknown) {
    console.warn("[antares] cache miss or Redis error", requestId, e);
    return null;
  }
}

export function setCachedResult(ca: string, result: object, tokenAgeMinutes: number | null): void {
  if (!scanCacheRedis) return;
  const ttl = computeCacheTTL(tokenAgeMinutes);
  scanCacheRedis.setex(`antares:v2:${ca}`, ttl, result).catch((e: unknown) => {
    console.warn("[antares] Redis cache write failed", e);
  });
}
