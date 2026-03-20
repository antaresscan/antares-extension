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

export async function getCachedResult(ca: string, requestId: string): Promise<unknown | null> {
  if (!scanCacheRedis) return null;
  try {
    return await scanCacheRedis.get(`antares:v2:${ca}`);
  } catch (e: unknown) {
    console.warn("[antares] cache miss or Redis error", requestId, e);
    return null;
  }
}

export function setCachedResult(ca: string, result: unknown, tokenAgeMinutes: number | null): void {
  if (!scanCacheRedis) return;
  const ttl = computeCacheTTL(tokenAgeMinutes);
  scanCacheRedis.setex(`antares:v2:${ca}`, ttl, JSON.stringify(result)).catch(() => {});
}
