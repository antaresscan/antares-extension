// api/_lib/ath.ts — the highest price a token ever traded at (Solscan Pro, else CoinGecko), asked only for the few tokens whose verdict can depend on it.
//
// Why it exists: the engine reads 90 days of candles at most, and a token that lost 99 % of its value two years ago looks, in 90 days, like a quiet token. The all-time high
// says it (MELANIA -99 %, YZY -90 %, ZEREBRO -94 %: a top 10 that holds 80 % of the supply is then control, not exchanges and treasuries), where a serious token that lost
// next to nothing (CARDS -9 %, BC -8 %) keeps its relief. It is ONE number per token, and it moves slowly, so it is kept in Redis for a day.
//
// Where it comes from: Solscan Pro first (token/price, one USD price per day since 2021: the plan is already paid, and it is not rate limited like a public API), CoinGecko's
// public API when Solscan has nothing for the token, does not answer, or has no key here. The source that gave the number is kept with it and named in the flag.
//
// Rules, all of them to keep it from ever showing something wrong:
//   - it is only ASKED for a token that could use it (isTop10Candidate, a bridge-held mint authority, isAthFlagCandidate), so a source sees a few hundred tokens a day;
//   - it is a HELP, never a requirement of the scan: a refusal, a timeout or an answer of an unexpected shape give "no high" and the verdict the engine gave before this existed
//     (no relief, no softening, no flag), never a different or a wrong verdict. But such a scan says that it is missing something (`failed`): the handler keeps its result
//     only 30 seconds, like any scan born from missing data, so that one hiccup does not pin a worse verdict on CARDS for ten minutes. It is `failed` unless the sources
//     ANSWERED: Solscan silent and CoinGecko answering "no such token" is still a gap (Solscan may know the token), and nothing is remembered about it;
//   - a token that the sources answer they do not know (CoinGecko 404, Solscan without a price), or know without a high, is an ANSWER: it is remembered for 6 h so that it is not
//     asked again at each scan, and it is not a failure;
//   - CoinGecko's public API (no key) is rate limited and shared: measured live on 2026-10-16, it refused every call after the sixth in a minute. So after a refusal or a
//     silence NOBODY asks it for ATH_BACKOFF_S seconds (one Redis key shared by every instance), instead of each failed scan asking again; and an optional Demo key
//     (COINGECKO_DEMO_API_KEY, free, about 30 calls a minute) is sent when the environment has one. Solscan has its own pause of the same length, and a refused key
//     (401/403) already pauses Solscan for ten minutes (fetchSolscan). Nothing needs a key that is not there: without Solscan the code works as it did with CoinGecko alone;
//   - Solscan's feed has glitches like any feed: a day that stands ten times above both its neighbours is not a price (parseSolscanHigh);
//   - Redis missing or failing: nothing is read or written, the scan goes on (fail open), a preview deployment keeps its own entries (deployment.ts).
// Cost: one or two Redis commands per candidate scan, plus one Solscan request (100 compute units) per candidate token a day, and one CoinGecko request when Solscan has nothing.
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { fetchSolscan, solscanUsable } from "./fetchers";
import { fetchJson } from "./http";
import { logger } from "./logger";
import { ATH_COLLAPSE_PCT, ATH_COLLAPSE_EXIT_PCT, ATH_DAILY_DOUBT_FROM_PCT, SOLSCAN_PRICE_FROM, SOLSCAN_PRICE_SPIKE_FACTOR } from "./constants";

/** Who gave the number: named in the flag, so that anyone can see where "down 94 % from its high" comes from. */
export type AthSource = "solscan" | "coingecko";

export interface AllTimeHigh {
  /** The highest price ever, in USD. */
  ath: number;
  /** When it was reached (ISO date; just the day for Solscan), or null when the source does not say. */
  athDate: string | null;
  source: AthSource;
}

/** What asking for the all-time high came to. */
export interface AllTimeHighLookup {
  /** The high, or null when there is none to give (no source knows the token, or the answer could not be had). */
  high: AllTimeHigh | null;
  /** The answer could not be had (a source refused, did not answer or sent something unreadable, and no other one answered): the verdict that follows is born from missing data. A token that the sources answer they do not know is NOT a failure. */
  failed: boolean;
}

/** How long a known all-time high is kept. It changes only when a new high is made, and a token that makes one is nowhere near the line (ATH_COLLAPSE_PCT). */
export const ATH_TTL_S = 24 * 3600;
/** How long "the sources have no high for this token" is kept. */
export const ATH_NOT_LISTED_TTL_S = 6 * 3600;
const ATH_TIMEOUT_MS = 4000;
const SOLSCAN_ATH_TIMEOUT_MS = 3000;
/** After a refusal or a silence of CoinGecko (or of Solscan), nobody asks that source for this long (seconds). */
export const ATH_BACKOFF_S = 60;

export const athKey = (mint: string): string => `antares:ath:${deploymentNamespace()}${mint}`;
/** One key for the whole deployment: set when CoinGecko refused or was silent, so that the next scans do not ask it (see the rules above). */
export const athBackoffKey = (): string => `antares:ath-backoff:${deploymentNamespace()}`;
/** The same for Solscan (a 401/403 is handled apart, in fetchSolscan: it pauses the instance for ten minutes). */
export const athSolscanBackoffKey = (): string => `antares:ath-backoff-solscan:${deploymentNamespace()}`;

/** The CoinGecko request: the coin of a Solana contract, with everything but the market data left out (it is a few kilobytes instead of a hundred). */
export const athUrl = (mint: string): string =>
  `https://api.coingecko.com/api/v3/coins/solana/contract/${encodeURIComponent(mint)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;

/** The Solscan request: the daily USD prices of a token from SOLSCAN_PRICE_FROM to `today` (YYYYMMDD). */
export const solscanPriceEndpoint = (mint: string, today: string): string =>
  `/token/price?address=${encodeURIComponent(mint)}&from_time=${SOLSCAN_PRICE_FROM}&to_time=${today}`;

/** What CoinGecko says about the all-time high, or null when the answer is not a positive USD price. Never throws. */
export function parseAllTimeHigh(raw: unknown): AllTimeHigh | null {
  const md = (raw as { market_data?: { ath?: { usd?: unknown }; ath_date?: { usd?: unknown } } } | null | undefined)?.market_data;
  const ath = md?.ath?.usd;
  if (typeof ath !== "number" || !Number.isFinite(ath) || ath <= 0) return null;
  const date = md?.ath_date?.usd;
  return { ath, athDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? date : null, source: "coingecko" };
}

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
  return best ? { ath: best.price, athDate: best.day, source: "solscan" } : null;
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

/** What is kept in Redis for a token. `source` is absent from what was written before Solscan was asked: that was CoinGecko. `checked`: CoinGecko's intraday high was looked at for a Solscan number (see isInDoubt). */
interface Memory { known: boolean; ath: number | null; athDate: string | null; source?: AthSource; checked?: boolean }

type Redis = ReturnType<typeof getCacheRedis>;

/** What one source came to: a high, an ANSWER without one (the token is not there), or no answer at all. `unused` = nothing was sent (no key, key refused, paused). */
type Asked = { kind: "high"; high: AllTimeHigh } | { kind: "nothing" } | { kind: "failed" } | { kind: "unused" };

const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");

async function paused(redis: Redis, key: string): Promise<boolean> {
  try {
    return !!(redis && (await redis.get(key)));
  } catch (e: unknown) {
    logger.warn("ath", "backoff not read", { error: String(e) });
    return false;
  }
}

async function pause(redis: Redis, key: string): Promise<void> {
  try { if (redis) await redis.set(key, 1, { ex: ATH_BACKOFF_S }); } catch (e: unknown) { logger.warn("ath", "backoff not kept", { error: String(e) }); }
}

async function askSolscan(mint: string, redis: Redis): Promise<Asked> {
  if (!solscanUsable()) return { kind: "unused" };
  if (await paused(redis, athSolscanBackoffKey())) return { kind: "failed" };
  let status = 0;
  const raw = await fetchSolscan(solscanPriceEndpoint(mint, today()), { timeoutMs: SOLSCAN_ATH_TIMEOUT_MS, retries: 0, onStatus: (s) => { status = s; } });
  const high = parseSolscanHigh(raw);
  logger.info("ath", "solscan price", { mint, status, ...solscanSpan(raw), ath: high?.ath ?? null, athDate: high?.athDate ?? null }); // once per token and day (the answer is kept in Redis)
  if (high) return { kind: "high", high };
  if (status === 401 || status === 403) return { kind: "unused" }; // the key is refused: fetchSolscan stops asking for ten minutes, CoinGecko does the work
  if (status === 0 || status === 429 || status >= 500) {
    await pause(redis, athSolscanBackoffKey()); // silence, refusal or server error: let Solscan breathe
    return { kind: "failed" };
  }
  if (status !== 200 && status !== 404) logger.warn("ath", "solscan price refused the request", { status }); // a 400 on every token would mean that the request itself is wrong: say it
  return { kind: "nothing" }; // 200 without a usable price, 404, or a request it refuses: Solscan has no history for this token
}

async function askCoinGecko(mint: string, redis: Redis): Promise<Asked> {
  if (await paused(redis, athBackoffKey())) return { kind: "failed" }; // CoinGecko refused a moment ago: nobody asks again yet
  let status = 0;
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  const raw = await fetchJson<unknown>(athUrl(mint), { headers: { accept: "application/json", ...(demoKey ? { "x-cg-demo-api-key": demoKey } : {}) } }, ATH_TIMEOUT_MS, 0, (s) => { status = s; });
  const high = parseAllTimeHigh(raw);
  if (high) return { kind: "high", high };
  // CoinGecko ANSWERED that it has no such token (404), or answered about a token it has no high for (200 with something else): an answer, not a failure.
  if (status === 404 || (status === 200 && raw !== null)) return { kind: "nothing" };
  // A refusal (429), a server error or a silence (no status at all): let CoinGecko breathe. A reply that is unreadable in another way does not stop anyone.
  if (status === 0 || status === 429 || status >= 500) await pause(redis, athBackoffKey());
  return { kind: "failed" };
}

/** Does the line (ATH_COLLAPSE_PCT) stand within reach of the difference between a daily high and an intraday one? From ATH_DAILY_DOUBT_FROM_PCT up to the line. */
export function isInDoubt(dropPct: number | null | undefined): boolean {
  return dropPct != null && Number.isFinite(dropPct) && dropPct >= ATH_DAILY_DOUBT_FROM_PCT && dropPct < ATH_COLLAPSE_PCT;
}

/**
 * The all-time high of this token, from Redis or else from Solscan, else from CoinGecko. Never throws.
 * Ask only for a token that can use it (see the rules above).
 *
 * `priceUsd` is the price now. A Solscan number is a DAILY high, a little under the intraday one that the line (ATH_COLLAPSE_PCT) is written on: where the token stands within reach of
 * the line (isInDoubt) CoinGecko's high is asked as well and the higher of the two is kept, once (`checked` in Redis; a number that was kept before the token came near the line is
 * checked the day it does). If CoinGecko cannot be had at that moment the Solscan number is returned with `failed`: the token's side of the line is then not certain, and the scan
 * says so like any scan born from missing data.
 */
export async function getAllTimeHigh(mint: string, priceUsd?: number | null): Promise<AllTimeHighLookup> {
  const redis = getCacheRedis();
  let high: AllTimeHigh | null = null;
  let checked = false; // the number is CoinGecko's own, or CoinGecko's intraday high has been looked at for it
  let fromMemory = false;
  try {
    if (redis) {
      const kept = await redis.get<Memory>(athKey(mint));
      if (kept && typeof kept === "object" && typeof kept.known === "boolean") {
        if (!kept.known) return { high: null, failed: false };
        if (typeof kept.ath === "number" && kept.ath > 0) {
          const source: AthSource = kept.source === "solscan" ? "solscan" : "coingecko";
          high = { ath: kept.ath, athDate: typeof kept.athDate === "string" ? kept.athDate : null, source };
          checked = source === "coingecko" || kept.checked === true;
          fromMemory = true;
        }
      }
    }
  } catch (e: unknown) {
    logger.warn("ath", "not read", { error: String(e) });
  }
  let answeredNothing = false;
  if (!high) {
    const solscan = await askSolscan(mint, redis);
    if (solscan.kind === "high") {
      high = solscan.high;
    } else {
      const coingecko = await askCoinGecko(mint, redis);
      if (coingecko.kind === "high") { high = coingecko.high; checked = true; }
      // The token is unknown ONLY if every source that was asked answered so: a Solscan that did not answer leaves the question open.
      else answeredNothing = coingecko.kind === "nothing" && solscan.kind !== "failed";
    }
  }
  let uncertain = false;
  let changed = !fromMemory;
  if (high && high.source === "solscan" && !checked && isInDoubt(athDropPct(high, priceUsd))) {
    const coingecko = await askCoinGecko(mint, redis);
    if (coingecko.kind === "high") {
      if (coingecko.high.ath > high.ath) high = coingecko.high;
      checked = true;
    } else if (coingecko.kind === "nothing") checked = true; // CoinGecko does not know the token: the daily high is all there is
    else uncertain = true;
    changed = changed || checked;
  }
  try {
    if (redis) {
      if (high && changed) await redis.set(athKey(mint), { known: true, ath: high.ath, athDate: high.athDate, source: high.source, checked } satisfies Memory, { ex: ATH_TTL_S });
      else if (!high && answeredNothing) await redis.set(athKey(mint), { known: false, ath: null, athDate: null } satisfies Memory, { ex: ATH_NOT_LISTED_TTL_S });
    }
  } catch (e: unknown) {
    logger.warn("ath", "not kept", { error: String(e) });
  }
  return { high, failed: uncertain || (!high && !answeredNothing) };
}

