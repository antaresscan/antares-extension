// api/_lib/ath.ts — the highest price a token ever traded at, from Solscan Pro and nothing else, asked only for the few tokens whose verdict can depend on it.
//
// Why it exists: the engine reads 90 days of candles at most, and a token that lost 99 % of its value two years ago looks, in 90 days, like a quiet token. The all-time high
// says it (MELANIA -99 %, ZEREBRO -94 %: a top 10 that holds 80 % of the supply is then control, not exchanges and treasuries), where a serious token that lost next to nothing
// (CARDS -9 %, BC -8 %) keeps its relief. It is ONE number per token, and it moves slowly, so it is kept in Redis for a day.
//
// Where it comes from: Solscan Pro `token/price`, one USD price per DAY since 2021 (the plan is already paid, there is no second price service to pay for). A daily price is a little
// under an intraday high and can miss the spike of a launch that pumped and dumped within hours (YZY, GRIFFAIN): the line is read on the daily numbers (constants.ts ATH_COLLAPSE_PCT)
// and what the daily series cannot see is decided by something else (LIVING_MARKET_MIN_ORGANIC_SCORE, api/_lib/jupiter.ts), not by a second price source.
//
// Rules, all of them to keep it from ever showing something wrong:
//   - it is only ASKED for a token that could use it (isTop10Candidate, a bridge-held mint authority, isAthFlagCandidate), so Solscan sees a few hundred tokens a day, 100 compute
//     units each, once a day per token;
//   - it is a HELP, never a requirement of the scan: a refusal, a timeout or an answer of an unexpected shape give "no high" and the verdict the engine gave before this existed
//     (no relief, no softening, no flag), never a different or a wrong verdict. But such a scan says that it is missing something (`failed`): the handler keeps its result
//     only 30 seconds, like any scan born from missing data, so that one hiccup does not pin a worse verdict on CARDS for ten minutes;
//   - a token that Solscan answers it has no price for (a 404, or a 200 without a row) is an ANSWER: it is remembered for 6 h so that it is not asked again at each scan, and it is
//     not a failure;
//   - after a silence, a 429 or a server error NOBODY asks for ATH_BACKOFF_S seconds (one Redis key shared by every instance), and a refused key (401/403) already pauses Solscan
//     for ten minutes (fetchSolscan);
//   - Solscan's feed has glitches like any feed: a day that stands ten times above both its neighbours is not a price (parseSolscanHigh);
//   - Redis missing or failing: nothing is read or written, the scan goes on (fail open), a preview deployment keeps its own entries (deployment.ts);
//   - the last high that was read is kept for ATH_STALE_S and served when Solscan does not answer: a high never goes down (a new high only makes it higher), so an old one is at worst a
//     little too low, which can only make a collapse look a little smaller, and a token cannot have fallen 90 % from a NEW high within a week without it showing in the 90 days of candles.
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { fetchSolscan, solscanUsable } from "./fetchers";
import { logger } from "./logger";
import { ATH_COLLAPSE_PCT, ATH_COLLAPSE_EXIT_PCT, SOLSCAN_PRICE_FROM, SOLSCAN_PRICE_SPIKE_FACTOR } from "./constants";

export interface AllTimeHigh {
  /** The highest daily price ever, in USD. */
  ath: number;
  /** The day it was reached (YYYY-MM-DD). */
  athDate: string | null;
}

/** What asking for the all-time high came to. */
export interface AllTimeHighLookup {
  /** The high, or null when there is none to give (Solscan has no price for the token, or the answer could not be had). */
  high: AllTimeHigh | null;
  /** The answer could not be had (Solscan refused, did not answer or sent something unreadable): the verdict that follows is born from missing data. A token Solscan has no price for is NOT a failure. */
  failed: boolean;
}

/** How long a known all-time high is kept. It changes only when a new high is made, and a token that makes one is nowhere near the line (ATH_COLLAPSE_PCT). */
export const ATH_TTL_S = 24 * 3600;
/** How long the last high read is kept to be served when Solscan does not answer. */
export const ATH_STALE_S = 7 * 24 * 3600;
/** How long "Solscan has no price for this token" is kept. */
export const ATH_NOT_LISTED_TTL_S = 6 * 3600;
const SOLSCAN_ATH_TIMEOUT_MS = 3000;
/** After a silence, a refusal or a server error of Solscan, nobody asks for this long (seconds). */
export const ATH_BACKOFF_S = 60;

export const athKey = (mint: string): string => `antares:ath:${deploymentNamespace()}${mint}`;
export const athLastKey = (mint: string): string => `antares:ath-last:${deploymentNamespace()}${mint}`;
/** One key for the whole deployment: set when Solscan was silent or refused, so that the next scans do not ask (a 401/403 is handled apart, in fetchSolscan: it pauses the instance for ten minutes). */
export const athBackoffKey = (): string => `antares:ath-backoff:${deploymentNamespace()}`;

/** The Solscan request: the daily USD prices of a token from SOLSCAN_PRICE_FROM to `today` (YYYYMMDD). */
export const solscanPriceEndpoint = (mint: string, today: string): string =>
  `/token/price?address=${encodeURIComponent(mint)}&from_time=${SOLSCAN_PRICE_FROM}&to_time=${today}`;

/** A Solscan day, 20250914 (number or text) or 2025-09-14, as 2025-09-14; null when it is neither. */
function solscanDay(raw: unknown): string | null {
  const text = typeof raw === "number" && Number.isFinite(raw) ? String(Math.trunc(raw)) : typeof raw === "string" ? raw.trim() : "";
  const m = text.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * The highest daily price of what Solscan sent ({ success, data: [{ date, price }] }), or null when there is no positive USD price in it. Never throws.
 * A day that stands more than SOLSCAN_PRICE_SPIKE_FACTOR times above EVERY neighbour it has is a glitch of the feed, not a price: it counts as the higher of its neighbours.
 */
export function parseSolscanHigh(raw: unknown): AllTimeHigh | null {
  const body = raw as { success?: unknown; data?: unknown } | null | undefined;
  if (!body || body.success === false || !Array.isArray(body.data)) return null;
  const days: Array<{ day: string; price: number }> = [];
  for (const row of body.data as Array<{ date?: unknown; price?: unknown } | null>) {
    const price = row?.price;
    const day = solscanDay(row?.date);
    if (day && typeof price === "number" && Number.isFinite(price) && price > 0) days.push({ day, price });
  }
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let best: { day: string; price: number } | null = null;
  for (let i = 0; i < days.length; i++) {
    const neighbours = [days[i - 1]?.price, days[i + 1]?.price].filter((n): n is number => n !== undefined);
    const glitch = neighbours.length > 0 && neighbours.every((n) => days[i].price > n * SOLSCAN_PRICE_SPIKE_FACTOR);
    const price = glitch ? Math.max(...neighbours) : days[i].price;
    if (!best || price > best.price) best = { day: days[i].day, price };
  }
  return best ? { ath: best.price, athDate: best.day } : null;
}

/** How many days Solscan gave and from which day to which (for the log: a high read on a short history would be a wrong high, and this is how it shows). */
export function solscanSpan(raw: unknown): { rows: number; firstDay: string | null; lastDay: string | null } {
  const data = (raw as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return { rows: 0, firstDay: null, lastDay: null };
  const days = (data as Array<{ date?: unknown } | null>).map((r) => solscanDay(r?.date)).filter((d): d is string => d !== null).sort();
  return { rows: data.length, firstDay: days[0] ?? null, lastDay: days[days.length - 1] ?? null };
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

/** What is kept in Redis for a token. */
interface Memory { known: boolean; ath: number | null; athDate: string | null }

const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/**
 * The all-time high of this token, from Redis or else from Solscan. Never throws.
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
  /** Solscan did not give a price: the last high read (up to ATH_STALE_S ago) if there is one, else a failure. */
  const unanswered = async (): Promise<AllTimeHighLookup> => {
    try {
      const last = redis ? await redis.get<Memory>(athLastKey(mint)) : null;
      if (last && typeof last === "object" && last.known === true && typeof last.ath === "number" && last.ath > 0) {
        logger.info("ath", "serving the last known high", { mint });
        return { high: { ath: last.ath, athDate: typeof last.athDate === "string" ? last.athDate : null }, failed: false };
      }
    } catch (e: unknown) {
      logger.warn("ath", "last high not read", { error: String(e) });
    }
    return { high: null, failed: true };
  };
  // No key here, or the key was refused less than ten minutes ago (fetchSolscan stops asking): there is no one to ask. A missing history, not a silence worth a pause.
  if (!solscanUsable()) return await unanswered();
  try {
    if (redis && (await redis.get(athBackoffKey()))) return await unanswered(); // Solscan was silent a moment ago: nobody asks again yet
  } catch (e: unknown) {
    logger.warn("ath", "backoff not read", { error: String(e) });
  }
  let status = 0;
  const raw = await fetchSolscan(solscanPriceEndpoint(mint, today()), { timeoutMs: SOLSCAN_ATH_TIMEOUT_MS, retries: 0, onStatus: (s) => { status = s; } });
  const high = parseSolscanHigh(raw);
  logger.info("ath", "solscan price", { mint, status, ...solscanSpan(raw), ath: high?.ath ?? null, athDate: high?.athDate ?? null }); // once per token and day (the answer is kept in Redis)
  // Solscan ANSWERED that it has no price for this token (404, a 200 without a usable row, or a request it refuses): an answer, not a failure.
  const answeredNothing = !high && (status === 200 || (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429));
  try {
    if (redis) {
      if (high) {
        await redis.set(athKey(mint), { known: true, ath: high.ath, athDate: high.athDate } satisfies Memory, { ex: ATH_TTL_S });
        await redis.set(athLastKey(mint), { known: true, ath: high.ath, athDate: high.athDate } satisfies Memory, { ex: ATH_STALE_S });
      }
      else if (answeredNothing) await redis.set(athKey(mint), { known: false, ath: null, athDate: null } satisfies Memory, { ex: ATH_NOT_LISTED_TTL_S });
    }
  } catch (e: unknown) {
    logger.warn("ath", "not kept", { error: String(e) });
  }
  // Silence, a refusal (429) or a server error: let Solscan breathe. A 401/403 is fetchSolscan's own ten-minute pause.
  if (!high && (status === 0 || status === 429 || status >= 500)) {
    try { if (redis) await redis.set(athBackoffKey(), 1, { ex: ATH_BACKOFF_S }); } catch (e: unknown) { logger.warn("ath", "backoff not kept", { error: String(e) }); }
  }
  if (!high && status >= 400 && status < 500 && status !== 404 && status !== 401 && status !== 403 && status !== 429) logger.warn("ath", "solscan price refused the request", { status }); // a 400 on every token would mean that the request itself is wrong: say it
  if (!high && !answeredNothing) return await unanswered();
  return { high, failed: false };
}
