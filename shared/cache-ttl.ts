/**
 * Dynamic TTL for local scan cache, mirroring the backend Redis TTL logic.
 * Newer tokens change quickly → shorter TTL.
 * Older stable tokens → longer TTL.
 */
export function getLocalCacheTTL(tokenAgeHours?: number | null): number {
  if (tokenAgeHours == null) return 60_000          // 1 min default (unknown age)
  if (tokenAgeHours < 0.5)  return 20_000           // <30 min → 20s (very fresh)
  if (tokenAgeHours < 1)    return 45_000           // <1h → 45s
  if (tokenAgeHours < 24)   return 120_000          // <1d → 2 min
  if (tokenAgeHours < 168)  return 300_000          // <1 week → 5 min
  return 600_000                                     // >1 week → 10 min
}
