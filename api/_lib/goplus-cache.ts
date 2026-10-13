// api/_lib/goplus-cache.ts — GoPlus' answer for a token, kept for a while.
//
// GoPlus' free tier answers about 30 authenticated calls a minute, then code 4029 (the anonymous tier is the fallback, see goplus-auth.ts). A scan
// costs one call. The verdict of a scan is cached 20 s to 10 min (computeCacheTTL: the established tokens at 10 min), so a token that is looked at
// often is scanned cold, and asks GoPlus again, every 10 minutes at best, and every time the verdict cache is flushed (every engine version).
//
// What GoPlus tells about a token moves slowly once the token is not new: the burned share of the LP, the holder count, the structure of the mint.
// So its answer is reused, for as long as the token's AGE makes it safe:
//   under a day or age unknown: never (an LP can be burned minutes after the launch: the verdict must see it as soon as GoPlus does);
//   1 day to 1 week:            5 minutes;
//   a week or more:             30 minutes.
// An answer that is not a complete code-1 answer is never kept. Redis down or missing: the call is made, nothing else changes (fail open).
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { fetchGoPlusSecurity } from "./goplus-auth";
import { logger } from "./logger";

/** How long GoPlus' answer may be reused for a token of this age (minutes), in seconds; 0 = not at all. */
export function goplusCacheTtlSeconds(tokenAgeMinutes: number | null): number {
  if (tokenAgeMinutes === null || !Number.isFinite(tokenAgeMinutes) || tokenAgeMinutes < 0) return 0;
  if (tokenAgeMinutes < 1440) return 0;        // under a day
  if (tokenAgeMinutes < 10080) return 300;     // under a week
  return 1800;                                 // a week or more
}

/** A preview deployment keeps its own entries (deployment.ts), like the scan cache. */
export const goplusCacheKey = (mint: string): string => `antares:goplus:${deploymentNamespace()}${mint}`;

/** A complete answer: code 1 and at least one token in `result`. Anything else (rate limit, error, empty) is not worth keeping. */
function isCompleteAnswer(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as { code?: unknown; result?: unknown };
  return r.code === 1 && !!r.result && typeof r.result === "object" && Object.keys(r.result as object).length > 0;
}

/**
 * GoPlus' token security for a mint, from the cache when the token's age allows it, else from GoPlus (and kept).
 * `fresh` (the manual refresh of the page) skips the read but still writes, so the next scan benefits.
 */
export async function fetchGoPlusSecurityCached(mint: string, tokenAgeMinutes: number | null, opts: { fresh?: boolean } = {}): Promise<unknown> {
  const ttl = goplusCacheTtlSeconds(tokenAgeMinutes);
  if (ttl === 0) return fetchGoPlusSecurity(mint);
  const redis = getCacheRedis();
  const key = goplusCacheKey(mint);
  if (redis && !opts.fresh) {
    try {
      const hit = await redis.get<unknown>(key);
      if (isCompleteAnswer(hit)) return hit;
    } catch (e: unknown) {
      logger.warn("goplus-cache", "cache read failed, asking GoPlus", { error: String(e) });
    }
  }
  const raw = await fetchGoPlusSecurity(mint);
  if (redis && isCompleteAnswer(raw)) {
    try {
      const written = redis.set(key, raw as object, { ex: ttl });
      if (written && typeof (written as Promise<unknown>).catch === "function") (written as Promise<unknown>).catch((e: unknown) => logger.warn("goplus-cache", "cache write failed", { error: String(e) }));
    } catch (e: unknown) {
      logger.warn("goplus-cache", "cache write failed", { error: String(e) });
    }
  }
  return raw;
}
