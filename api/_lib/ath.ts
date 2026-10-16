// api/_lib/ath.ts — the highest price a token ever traded at (CoinGecko), asked only for the few tokens whose verdict can depend on it.
//
// Why it exists: the engine reads 90 days of candles at most, and a token that lost 99 % of its value two years ago looks, in 90 days, like a quiet token. The all-time high
// says it (MELANIA -99 %, YZY -90 %, ZEREBRO -94 %: a top 10 that holds 80 % of the supply is then control, not exchanges and treasuries), where a serious token that lost
// next to nothing (CARDS -9 %, BC -8 %) keeps its relief. It is ONE number per token, and it moves slowly, so it is kept in Redis for a day.
//
// Rules, all of them to keep it from ever showing something wrong:
//   - it is only ASKED for a token that could use it (isTop10Candidate, a bridge-held mint authority, isAthFlagCandidate), so CoinGecko's public API (no key, a few calls a
//     minute) sees a few hundred tokens a day;
//   - it is a HELP, never a requirement of the scan: a refusal, a timeout or an answer of an unexpected shape give "no high" and the verdict the engine gave before this existed
//     (no relief, no softening, no flag), never a different or a wrong verdict. But such a scan says that it is missing something (`failed`): the handler keeps its result
//     only 30 seconds, like any scan born from missing data, so that one hiccup of CoinGecko does not pin a worse verdict on CARDS for ten minutes;
//   - a token CoinGecko does not list (404), or lists without a high, is an ANSWER: it is remembered for 6 h so that it is not asked again at each scan, and it is not a failure;
//   - CoinGecko's public API (no key) is rate limited and shared: measured live on 2026-10-16, it refused every call after the sixth in a minute. So after a refusal or a
//     silence NOBODY asks for ATH_BACKOFF_S seconds (one Redis key shared by every instance), instead of each failed scan asking again; and an optional Demo key
//     (COINGECKO_DEMO_API_KEY, free, about 30 calls a minute) is sent when the environment has one. Nothing needs it: without it the code works as described here;
//   - Redis missing or failing: nothing is read or written, the scan goes on (fail open), a preview deployment keeps its own entries (deployment.ts).
// Cost: one or two Redis commands per candidate scan, plus one CoinGecko request per candidate token a day.
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { fetchJson } from "./http";
import { logger } from "./logger";
import { ATH_COLLAPSE_PCT, ATH_COLLAPSE_EXIT_PCT } from "./constants";

export interface AllTimeHigh {
  /** The highest price ever, in USD. */
  ath: number;
  /** When it was reached (ISO date), or null when CoinGecko does not say. */
  athDate: string | null;
}

/** What asking for the all-time high came to. */
export interface AllTimeHighLookup {
  /** The high, or null when there is none to give (CoinGecko does not know the token, or the answer could not be had). */
  high: AllTimeHigh | null;
  /** The answer could not be had (CoinGecko refused, did not answer or sent something unreadable): the verdict that follows is born from missing data. A token CoinGecko does not know is NOT a failure. */
  failed: boolean;
}

/** How long a known all-time high is kept. It changes only when a new high is made, and a token that makes one is nowhere near the line (ATH_COLLAPSE_PCT). */
export const ATH_TTL_S = 24 * 3600;
/** How long "CoinGecko has no high for this token" is kept. */
export const ATH_NOT_LISTED_TTL_S = 6 * 3600;
const ATH_TIMEOUT_MS = 4000;
/** After a refusal or a silence of CoinGecko, nobody asks for this long (seconds). */
export const ATH_BACKOFF_S = 60;

export const athKey = (mint: string): string => `antares:ath:${deploymentNamespace()}${mint}`;
/** One key for the whole deployment: set when CoinGecko refused or was silent, so that the next scans do not ask (see the rules above). */
export const athBackoffKey = (): string => `antares:ath-backoff:${deploymentNamespace()}`;

/** The CoinGecko request: the coin of a Solana contract, with everything but the market data left out (it is a few kilobytes instead of a hundred). */
export const athUrl = (mint: string): string =>
  `https://api.coingecko.com/api/v3/coins/solana/contract/${encodeURIComponent(mint)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;

/** What CoinGecko says about the all-time high, or null when the answer is not a positive USD price. Never throws. */
export function parseAllTimeHigh(raw: unknown): AllTimeHigh | null {
  const md = (raw as { market_data?: { ath?: { usd?: unknown }; ath_date?: { usd?: unknown } } } | null | undefined)?.market_data;
  const ath = md?.ath?.usd;
  if (typeof ath !== "number" || !Number.isFinite(ath) || ath <= 0) return null;
  const date = md?.ath_date?.usd;
  return { ath, athDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? date : null };
}

/** How far the price stands below the all-time high, in percent (0 at or above it). null when either number is not a positive finite number. */
export function athDropPct(ath: AllTimeHigh | null | undefined, priceUsd: number | null | undefined): number | null {
  if (!ath || !(ath.ath > 0) || priceUsd == null || !Number.isFinite(priceUsd) || !(priceUsd > 0)) return null;
  return Math.max(0, (1 - priceUsd / ath.ath) * 100);
}

/** How long the side of the line a token is on is remembered (it is renewed at each scan that reads it). */
export const ATH_SIDE_TTL_S = 7 * 24 * 3600;
export const athSideKey = (mint: string): string => `antares:ath-side:${deploymentNamespace()}${mint}`;

/**
 * Has the token collapsed (true), is its history clean (false), or is it unknown (null: no fall to judge)? A line with a memory: a token enters "collapsed" at ATH_COLLAPSE_PCT and
 * leaves it only below ATH_COLLAPSE_EXIT_PCT, so that a few percent of price next to the line do not flip a verdict from one scan to the next. The side it was on is kept in Redis for
 * a week; with no memory (first scan, Redis missing or failing) it is the plain line. Never throws.
 */
export async function judgeHistory(mint: string, dropPct: number | null | undefined): Promise<boolean | null> {
  if (dropPct == null || !Number.isFinite(dropPct)) return null;
  const redis = getCacheRedis();
  let wasCollapsed: boolean | null = null;
  try {
    if (redis) {
      const kept = await redis.get<unknown>(athSideKey(mint));
      if (kept === "collapsed" || kept === "clean") wasCollapsed = kept === "collapsed";
    }
  } catch (e: unknown) {
    logger.warn("ath", "side not read", { error: String(e) });
  }
  const collapsed = dropPct >= (wasCollapsed === true ? ATH_COLLAPSE_EXIT_PCT : ATH_COLLAPSE_PCT);
  try {
    if (redis) await redis.set(athSideKey(mint), collapsed ? "collapsed" : "clean", { ex: ATH_SIDE_TTL_S });
  } catch (e: unknown) {
    logger.warn("ath", "side not kept", { error: String(e) });
  }
  return collapsed;
}

interface Memory { known: boolean; ath: number | null; athDate: string | null }

/**
 * The all-time high of this token, from Redis or else from CoinGecko. Never throws.
 * Ask only for a token that can use it (see the rules above).
 */
export async function getAllTimeHigh(mint: string): Promise<AllTimeHighLookup> {
  const redis = getCacheRedis();
  try {
    if (redis) {
      const kept = await redis.get<Memory>(athKey(mint));
      if (kept && typeof kept === "object" && typeof kept.known === "boolean") {
        if (!kept.known) return { high: null, failed: false };
        if (typeof kept.ath === "number" && kept.ath > 0) return { high: { ath: kept.ath, athDate: typeof kept.athDate === "string" ? kept.athDate : null }, failed: false };
      }
    }
  } catch (e: unknown) {
    logger.warn("ath", "not read", { error: String(e) });
  }
  try {
    if (redis && (await redis.get(athBackoffKey()))) return { high: null, failed: true }; // CoinGecko refused a moment ago: nobody asks again yet
  } catch (e: unknown) {
    logger.warn("ath", "backoff not read", { error: String(e) });
  }
  let status = 0;
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  const raw = await fetchJson<unknown>(athUrl(mint), { headers: { accept: "application/json", ...(demoKey ? { "x-cg-demo-api-key": demoKey } : {}) } }, ATH_TIMEOUT_MS, 0, (s) => { status = s; });
  const high = parseAllTimeHigh(raw);
  // CoinGecko ANSWERED that it has no such token (404), or answered about a token it has no high for (200 without one): an answer, not a failure.
  const answeredNothing = status === 404 || (status === 200 && raw !== null && high === null);
  try {
    if (redis) {
      if (high) await redis.set(athKey(mint), { known: true, ath: high.ath, athDate: high.athDate } satisfies Memory, { ex: ATH_TTL_S });
      else if (answeredNothing) await redis.set(athKey(mint), { known: false, ath: null, athDate: null } satisfies Memory, { ex: ATH_NOT_LISTED_TTL_S });
    }
  } catch (e: unknown) {
    logger.warn("ath", "not kept", { error: String(e) });
  }
  const failed = !high && !answeredNothing;
  // A refusal (429), a server error or a silence (no status at all): let CoinGecko breathe. A reply that is unreadable in another way does not stop anyone.
  if (failed && (status === 0 || status === 429 || status >= 500)) {
    try { if (redis) await redis.set(athBackoffKey(), 1, { ex: ATH_BACKOFF_S }); } catch (e: unknown) { logger.warn("ath", "backoff not kept", { error: String(e) }); }
  }
  return { high, failed };
}
