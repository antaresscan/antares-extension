// api/_lib/jupiter.ts — is the market of this token ALIVE? Jupiter's organic score (free public API, no key), asked only for the few tokens whose relief depends on it.
//
// Why it exists: the relief of a concentrated top 10 and the softening of a bridge-held mint authority are for a token whose market is real. A daily price history cannot tell a real market
// from a dead one that only has a pool and a cap (YZY, MELANIA, BAN, JELLYJELLY: a daily price misses the spike of a launch that pumped and dumped within hours). Jupiter's organicScore
// (real trading activity, not wash trading or one bot) does: 0 for the tokens the owner doubts, 49 or more for every serious token the engine relieves (constants.ts
// LIVING_MARKET_MIN_ORGANIC_SCORE).
//
// Same rules as the all-time high (api/_lib/ath.ts): asked only when it can matter (a relief or a bridge), kept in Redis for a day, never a requirement of the scan (a refusal, a timeout or an
// unreadable answer give "unknown", which is no relief, the verdict of before; the scan then says it is missing data), a token Jupiter does not list is an ANSWER (6 h, not a failure),
// one shared pause of ORGANIC_BACKOFF_S seconds after a silence or a refusal, Redis missing or failing never stops a scan, a preview deployment keeps its own entries.
// Cost: one Redis command per candidate scan and one free request per candidate token a day.
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { fetchJson } from "./http";
import { logger } from "./logger";

/** What asking for the organic score came to. */
export interface OrganicLookup {
  /** Jupiter's organic score (0 to 100), or null when there is none to give (Jupiter does not list the token, or the answer could not be had). */
  score: number | null;
  /** The answer could not be had (Jupiter refused, did not answer or sent something unreadable). A token Jupiter does not list is NOT a failure. */
  failed: boolean;
}

export const ORGANIC_TTL_S = 24 * 3600;
export const ORGANIC_NOT_LISTED_TTL_S = 6 * 3600;
export const ORGANIC_BACKOFF_S = 60;
const ORGANIC_TIMEOUT_MS = 3000;

export const organicKey = (mint: string): string => `antares:organic:${deploymentNamespace()}${mint}`;
export const organicBackoffKey = (): string => `antares:organic-backoff:${deploymentNamespace()}`;

/** Jupiter's public token search (no key): by mint address. */
export const jupiterSearchUrl = (mint: string): string => `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`;

/** The organic score of THIS mint in a search answer (the search can return clones that share a name), or null when the answer has no such token or no valid score. Never throws. */
export function parseOrganicScore(raw: unknown, mint: string): number | null {
  if (!Array.isArray(raw)) return null;
  const hit = (raw as Array<{ id?: unknown; organicScore?: unknown } | null>).find((t) => t?.id === mint);
  const score = hit?.organicScore;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}

interface Memory { known: boolean; score: number | null }

/** The organic score of this token, from Redis or else from Jupiter. Never throws. */
export async function getOrganicScore(mint: string): Promise<OrganicLookup> {
  const redis = getCacheRedis();
  try {
    if (redis) {
      const kept = await redis.get<Memory>(organicKey(mint));
      if (kept && typeof kept === "object" && typeof kept.known === "boolean") {
        if (!kept.known) return { score: null, failed: false };
        if (typeof kept.score === "number" && Number.isFinite(kept.score)) return { score: kept.score, failed: false };
      }
    }
  } catch (e: unknown) {
    logger.warn("jupiter", "not read", { error: String(e) });
  }
  try {
    if (redis && (await redis.get(organicBackoffKey()))) return { score: null, failed: true }; // Jupiter refused a moment ago: nobody asks again yet
  } catch (e: unknown) {
    logger.warn("jupiter", "backoff not read", { error: String(e) });
  }
  let status = 0;
  const raw = await fetchJson<unknown>(jupiterSearchUrl(mint), { headers: { accept: "application/json" } }, ORGANIC_TIMEOUT_MS, 0, (s) => { status = s; });
  const score = parseOrganicScore(raw, mint);
  // Jupiter ANSWERED with a list that does not hold the token (or holds it without a score): it does not know it. An answer, not a failure.
  const answeredNothing = score === null && status === 200 && Array.isArray(raw);
  try {
    if (redis) {
      if (score !== null) await redis.set(organicKey(mint), { known: true, score } satisfies Memory, { ex: ORGANIC_TTL_S });
      else if (answeredNothing) await redis.set(organicKey(mint), { known: false, score: null } satisfies Memory, { ex: ORGANIC_NOT_LISTED_TTL_S });
    }
  } catch (e: unknown) {
    logger.warn("jupiter", "not kept", { error: String(e) });
  }
  if (score === null && !answeredNothing && (status === 0 || status === 429 || status >= 500)) {
    try { if (redis) await redis.set(organicBackoffKey(), 1, { ex: ORGANIC_BACKOFF_S }); } catch (e: unknown) { logger.warn("jupiter", "backoff not kept", { error: String(e) }); }
  }
  return { score, failed: score === null && !answeredNothing };
}
