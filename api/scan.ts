import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type {
  DexScreenerPair,
  HeliusHolder,
  SolscanTransfer, SolscanMarketPool,
  OHLCVCandle,
  ScanResult,
} from "./_lib/types";
import {
  fetchJson, asNumber, pickGoPlusResult,
  withBudget, apiError,
  isValidDexScreenerResponse, isValidRugCheckSummary,
  isHeliusLargestAccountsResponse, isHeliusSupplyResponse,
  isSolscanMarketsResponse, isSolscanMeta, isSolscanTransfersResponse,
  isRugCheckReport,
  sanitizeString, sanitizeUrl,
  isChartGapDegraded, isReportGapDegraded, isLayerGap, isScanIncomplete, limitedDataEnabled, withServeWindows, retryOnFastNull,
} from "./_lib/helpers";
import {
  heliusGetLargestAccounts, heliusGetMintAccount, heliusGetHolderPages, heliusGetCreatorReputation,
  heliusResolveAccountOwners,
  publicRpcGetLargestAccounts, publicRpcGetTokenSupply, publicRpcGetMintInfo, publicRpcGetMintAccount,
  fetchSolscan, fetchDexCandles, fetchDexCandlesDaily,
  type CreatorReputation,
} from "./_lib/fetchers";
import { readHeliusKey } from "./_lib/helius";
import { parseMintState, mintSupplyUi, deriveAuthorityFacts, parseChainHolders, pickHolderCount, positiveCount } from "./_lib/facts";
import { fetchGoPlusSecurityCached } from "./_lib/goplus-cache";
import {
  DEXSCREENER_BASE, RUGCHECK_BASE, RUGCHECK_WAIT_MS, LAYER_WEIGHTS, SCORING_VERSION,
  LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS, SOLSCAN_AGE_AND_HOLDERS_ONLY,
  HELIUS_FAST_FAIL_MS, HELIUS_RETRY_DELAY_MS, HELIUS_RETRY_JITTER_MS, HELIUS_RETRY_MIN_LEFT_MS,
} from "./_lib/constants";
import { selectBestPair } from "./_lib/dex-pair-select";
import { decide } from "./_lib/decide";
import { toPublicFlag } from "./_lib/pipeline";
import { setCorsHeaders, getClientIp, getInstallId, checkRateLimit, checkColdScanLimit, validateCA, initRateLimiters } from "./_lib/middleware";
import { initQuota, checkDailyQuota, setQuotaHeaders, secondsUntilReset } from "./_lib/quota";
import { enforceProGate } from "./_lib/pro-gate";
import { initUserStorage, pushScanHistory, resolveTierAndBypass } from "./_lib/user";
import { initCache, getCachedResult, setCachedResult, setShortCachedResult, setLastGoodResult, getLastGoodResult, acquireScanLock, releaseScanLock, waitForCachedResult } from "./_lib/cache";
import { serveLastGood } from "./_lib/last-good";
import { initSentry, captureError } from "./_lib/sentry";
import { generateAISummary } from "./_lib/ai-summary";

import { initRugDb, recordRug } from "./_lib/rugdb";
import { initCondemned, getCondemned, condemn, condemnedEntryOf, shouldCondemn, applyCondemnation } from "./_lib/condemned";
import { isPreviewDeployment } from "./_lib/deployment";
import { logger } from "./_lib/logger";
import { composeCriticalActors } from "./_lib/critical-actors";
import { initUsage, flushUsage } from "./_lib/usage";
import { deriveEvent } from "./_lib/verdict-history";
// initHistoryCache / pushVerdictHistory / getVerdictHistory are no
// longer imported — the Verdict Timeline feature was decommissioned
// (see the "Verdict Timeline (decommissioned)" block lower in this
// file for the full rationale). `deriveEvent` is still imported
// because the current-scan entry still tags the verdict with a
// human-readable event label.
import { composeHolderActivity } from "./_lib/holder-activity";
// Route through the centralised initSentry() — it sets sendDefaultPii=false
// and wires beforeSend(scrubEvent) so `?ca=<contract>`, the client IP, and
// any email/JWT/auth header attached to an event are stripped before leaving
// the process. The previous direct Sentry.init() here bypassed both, leaking
// PII on the hottest endpoint (~95% of traffic) and silently violating the
// "Sentry: never the contract address or your IP" claim in privacy.html.
initSentry();

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initCache(redis);
  initRateLimiters(redis);
  initQuota(redis);
  initUserStorage(redis);
  initRugDb(redis);
  initCondemned(redis);
  // initGraphCache deliberately not called: the scan no longer builds the insider graph (api/graph.ts does, on demand).
  initUsage(redis);
  // initHistoryCache deliberately not called — verdict-history is
  // decommissioned (see decom block lower in this file).
}

// 24s internal budget against the 25s vercel.json maxDuration. The 9s
// previous limit timed out heavy blue-chips like BONK/PENGU/TRUMP on
// cold starts (millions of holders + many candles + multi-source
// enrich). 25s is enough headroom even for the heaviest tokens while
// still bounding worst-case wait for users on warm calls.
const GLOBAL_TIMEOUT_MS = Number(process.env.VERCEL_TIMEOUT) || 24000;
// Time kept free after the AI summary for the cache writes and the response.
const AI_RESERVE_MS = 1500;
// Time kept free at the very end of the budget for scoring, the cache writes
// and the response. The data-gathering deadline is GLOBAL_TIMEOUT_MS minus
// this, so a slow scan ANSWERS with what it has instead of finishing in the
// same instant the global timer cuts it (which used to give a 504 whenever
// every upstream was merely slow: 20 of 20 scans in the simulation).
const SCAN_RESERVE_MS = 2500;
// A serial step (owner resolution, creator reputation, fallback RPCs, insider
// graph) is only worth starting when at least this much time is left.
const MIN_STEP_MS = 1500;
// Below this much remaining time a request that waited on another scan's lock
// cannot run a meaningful scan of its own: it asks the client to retry.
const MIN_OWN_SCAN_MS = 8000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = randomUUID();
  const startTime = Date.now();
  res.setHeader("X-Request-Id", requestId);

  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    return apiError(res, 405, "Method not allowed.");
  }

  // Override the CDN cache header set by setCorsHeaders. /api/scan
  // responses include per-user data (X-Antares-Quota-Tier — the tier
  // the overlay displays) and a CDN cache-by-URL keys all callers to
  // the same response. So the first anonymous scan's "Free" gets
  // served to every signed-in user for 15-45s, and the lambda is
  // never invoked, the session is never validated, the binding is
  // never checked. That's why the founder kept seeing Free in the
  // overlay even after every other fix landed correctly. Internal
  // Redis cache (getCachedResult) still absorbs duplicate scoring
  // work — only the per-user tier resolution runs on every call,
  // which is what we want.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  // Validate input BEFORE any async work (see /api/graph for the
  // same rationale). e2e contract: /api/scan (no ca) and ?ca= must
  // return 400, never 500.
  const ca = validateCA(req.query.ca);
  if (!ca) return apiError(res, 400, "Invalid token address.");

  const ip = getClientIp(req);
  const installId = getInstallId(req);
  const rateLimitOk = await checkRateLimit(res, ip, installId);
  if (!rateLimitOk) return;

  // Daily quota gate — runs after CA validation (don't charge invalid CAs
  // against the user's budget) but before the cache lookup (cache hits still
  // count, otherwise users could spam the same token for free). install_id
  // is the primary identity key; falling back to IP keeps anonymous traffic
  // bounded and prevents quota-bypass via missing header.
  const identityKey = installId ?? ip;
  // Session-gated tier resolution + dev quota bypass in one pass:
  //   - tier: what the overlay should display (Free overlay locks
  //     features even when bypassQuota is true)
  //   - bypassQuota: dev users (env-var or bound dev email) skip the
  //     50/day Free counter so they can flip the Options dropdown to
  //     Free and test the locked UX without burning quota
  const { tier: effectiveTier, bypassQuota } = await resolveTierAndBypass(
    req,
    identityKey,
  );
  // The Pro/Free line is drawn here, on the server: from now on every scan this response sends is the Free view when the caller
  // is Free (verdict, score, the Sell/Mint/Freeze/LP line, public market data). See api/_lib/pro-gate.ts.
  enforceProGate(res, effectiveTier);
  const quota = await checkDailyQuota(identityKey, effectiveTier, { bypassQuota });
  setQuotaHeaders(res, quota);
  if (!quota.allowed) {
    res.setHeader("Retry-After", String(secondsUntilReset(quota)));
    return apiError(
      res,
      429,
      `Daily limit reached (${quota.limit} scans on Free tier). Resets at midnight UTC. Upgrade to Pro for unlimited scans.`,
    );
  }

  // ?fresh=1 bypasses the Redis cache so users can manually trigger a
  // fresh scan from the page — the front-end refresh button passes this
  // flag. The result still gets written to cache for the next request,
  // so the bypass costs one upstream batch and benefits everyone after.
  const fresh = req.query?.fresh === "1" || req.query?.fresh === "true";

  // Only serve cache when aiSummary is present — avoids serving stale null-summary results
  const cached = fresh ? null : await getCachedResult<ScanResult>(ca, requestId);
  if (cached && cached.aiSummary) {
    logger.metric("scan.cache_hit", {
      requestId,
      mint: ca,
      verdict: cached.risk,
      score: cached.score,
      latencyMs: Date.now() - startTime,
      hitKey: "ca",
    });
    // History push intentionally skipped on cache-hit paths. The first
    // miss (the bottom of this handler) already recorded the scan; a
    // user refreshing the same page within the cache TTL would
    // otherwise stamp identical history entries every reload and
    // burn 1–2 Redis commands per refresh for zero new information.
    return res.json(withServeWindows(cached));
  }

  // ─── Single-flight coalescing (cache-stampede protection) ────────────
  // Cache miss. When a token trends, many users hit the same uncached CA
  // inside the ~10s cold-scan window. Without coordination each one runs
  // its own full cold scan → N× upstream quota burned + inconsistent
  // verdicts (degraded scans resolve different source subsets). Instead:
  // the first miss wins the lock and runs THE scan; everyone else waits
  // for it to land in the cache and reads the identical result.
  //
  // fresh=1 bypasses coalescing — the manual refresh button must always
  // trigger a real scan. Fail-open throughout: any Redis hiccup → scan.
  let holdsLock = false;
  if (!fresh) {
    holdsLock = await acquireScanLock(ca, requestId);
    if (!holdsLock) {
      // Wait for the lock holder until OUR scan deadline. The holder is bound
      // by the same deadline, so its result is in the cache by then. The old
      // fixed 18 s window ended before a slow holder did: every waiter then
      // started its own full scan (1 scan became 200 in the simulation, 4 804
      // upstream calls).
      const waitMs = Math.max(0, GLOBAL_TIMEOUT_MS - SCAN_RESERVE_MS - (Date.now() - startTime));
      const coalesced = await waitForCachedResult<ScanResult>(ca, requestId, { timeoutMs: waitMs });
      if (coalesced && coalesced.aiSummary) {
        logger.metric("scan.coalesced", {
          requestId,
          mint: ca,
          verdict: coalesced.risk,
          score: coalesced.score,
          latencyMs: Date.now() - startTime,
        });
        return res.json(withServeWindows(coalesced));
      }
      // The holder didn't deliver (it crashed, or Redis lost the write). If
      // too little time is left for a meaningful scan, don't launch a doomed
      // one: ask the client to come back, the cache is usually warm by then.
      if (GLOBAL_TIMEOUT_MS - (Date.now() - startTime) < MIN_OWN_SCAN_MS) {
        res.setHeader("Retry-After", "2");
        return apiError(res, 503, "Scan in progress. Retry shortly.");
      }
      // Otherwise fall through and scan ourselves with whatever budget
      // remains — runAnalysis self-bounds via remainingMs().
    }
  }

  // Abuse guard, COLD scans only. We are about to do the expensive part (~20
  // upstream calls plus Gemini). Cache hits and requests that were served by
  // another scan's result returned above and are never counted, so a token
  // everybody watches costs nobody anything. The per-install limiters cannot
  // stop a script that rotates the client-chosen install id; this one is keyed
  // by network. When refusing, release the lock we hold so other requests for
  // this token are not blocked behind a scan that will never start.
  const cold = await checkColdScanLimit(ip);
  if (!cold.ok) {
    if (holdsLock) void releaseScanLock(ca, requestId);
    logger.metric("scan.cold_limited", { requestId, retryAfterSec: cold.retryAfterSec });
    res.setHeader("Retry-After", String(cold.retryAfterSec));
    return apiError(res, 429, "Too many new-token scans from your network. Retry shortly.");
  }

  // Anchored on the request's start: a request that spent time waiting on a
  // lock must not get a fresh 24 s on top (that could outlive Vercel's 25 s
  // kill and return a bare platform error).
  let globalTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    globalTimer = setTimeout(
      () => reject(new Error("Global timeout")),
      Math.max(0, GLOBAL_TIMEOUT_MS - (Date.now() - startTime)),
    );
  });

  try {
    const result = await Promise.race([runAnalysis(req, res, requestId, ca, startTime, installId), timeoutPromise]);
    return result;
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "Global timeout") {
      return apiError(res, 504, "Analysis timed out. Try again.");
    }
    captureError(e, { endpoint: "scan", requestId, ca });
    return apiError(res, 500, "Unexpected error.");
  } finally {
    clearTimeout(globalTimer);
    // Always release the lock — even on error/timeout — so the next scan
    // of this CA isn't blocked. TTL expiry is only the crash backstop.
    if (holdsLock) void releaseScanLock(ca, requestId);
  }
}

async function runAnalysis(req: VercelRequest, res: VercelResponse, requestId: string, ca: string, startTime: number = Date.now(), installId: string | null = null) {
  const HELIUS_API_KEY = readHeliusKey();

  // Dynamic per-fetch budget: each external call is capped by the time
  // remaining until the scan deadline. Ensures one slow upstream can't make
  // the whole pipeline hit the global 9s timeout — scoring still runs with
  // whatever data came back in time.
  const scanDeadline = startTime + (GLOBAL_TIMEOUT_MS - SCAN_RESERVE_MS);
  const remainingMs = () => Math.max(200, scanDeadline - Date.now());
  // RugCheck is waited for at most RUGCHECK_WAIT_MS (constants.ts): for the very largest tokens it answers late or never.
  const rugcheckWaitMs = () => Math.min(remainingMs(), RUGCHECK_WAIT_MS);
  // For the SERIAL steps that follow the parallel phases. `withBudget(fn(), ms)`
  // starts the call even when no time is left (it only stops WAITING for it);
  // this starts a step only if it still has a chance to finish.
  const stepBudget = <T>(start: () => Promise<T>): Promise<T | null> =>
    scanDeadline - Date.now() < MIN_STEP_MS ? Promise.resolve(null) : withBudget(start(), remainingMs());
  // The two Helius reads that give the holder distribution and the authorities (the holder-count pages are not asked twice: 10 credits a page, and
  // the count has other sources). When one answers nothing AT ONCE (rate limit, shut breaker, a burst of scans) it is asked once more, a moment
  // later and not at the same instant as the other scans' second tries (constants.ts).
  const heliusAskTwice = <T>(run: () => Promise<T | null>): Promise<T | null> =>
    retryOnFastNull(run, {
      fastMs: HELIUS_FAST_FAIL_MS,
      delayMs: HELIUS_RETRY_DELAY_MS + Math.random() * HELIUS_RETRY_JITTER_MS,
      minLeftMs: HELIUS_RETRY_MIN_LEFT_MS,
      timeLeftMs: () => scanDeadline - Date.now(),
    });

  try {
    const [dexRes, rugRes, rugReportRes] = await Promise.all([
      withBudget(fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`, {}, 5000), remainingMs()),
      withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`, {}, 5000), rugcheckWaitMs()),
      withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report`, {}, 5000), rugcheckWaitMs()),
    ]);

    let dexData = isValidDexScreenerResponse(dexRes) ? dexRes : null;
    let rugData = isValidRugCheckSummary(rugRes) ? rugRes : null;
    // The first pool where the scanned token is the BASE (audit A-26): /tokens/<mint> also lists the pools where it is only the quote, and
    // the base token of THOSE is another token (scanning USDC could resolve the scan to the SOL of a SOL/USDC pool).
    let pair: DexScreenerPair | null = dexData?.pairs?.find((p) => p?.baseToken?.address === ca) ?? dexData?.pairs?.[0] ?? null;
    let resolvedMint = ca;

    const rugMissing =
      !rugData ||
      rugData?.error === "not found" ||
      rugData?.message?.toLowerCase?.().includes("not found");

    if (!pair || !rugData || rugMissing) {
      const pairDataRaw = await withBudget(fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`, {}, 5000), remainingMs());
      const pairData = isValidDexScreenerResponse(pairDataRaw) ? pairDataRaw : null;
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint = resolvedPair?.baseToken?.address;
      if (resolvedPair) pair = pair ?? resolvedPair;
      if (baseMint && baseMint !== ca) {
        resolvedMint = baseMint;
        const [dexRetry, rugRetry] = await Promise.all([
          withBudget(fetchJson(`${DEXSCREENER_BASE}/tokens/${resolvedMint}`, {}, 5000), remainingMs()),
          withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`, {}, 5000), rugcheckWaitMs()),
        ]);
        const dexRetryTyped = isValidDexScreenerResponse(dexRetry) ? dexRetry : null;
        const rugRetryTyped = isValidRugCheckSummary(rugRetry) ? rugRetry : null;
        if (dexRetryTyped?.pairs?.[0]) { dexData = dexRetryTyped; pair = dexRetryTyped.pairs.find((p) => p?.baseToken?.address === resolvedMint) ?? dexRetryTyped.pairs[0]; }
        if (rugRetryTyped) rugData = rugRetryTyped;
      } else if (!baseMint) {
        logger.warn("scan", "mint resolution failed", { requestId, ca });
      }
    }

    if (pair?.baseToken?.address) resolvedMint = pair.baseToken.address;

    const fresh = req.query?.fresh === "1" || req.query?.fresh === "true";
    if (resolvedMint !== ca) {
      const cachedByMint = !fresh ? await getCachedResult<ScanResult>(resolvedMint, requestId) : null;
      if (cachedByMint && cachedByMint.aiSummary) {
        logger.metric("scan.cache_hit", {
          requestId,
          mint: resolvedMint,
          verdict: cachedByMint.risk,
          score: cachedByMint.score,
          latencyMs: Date.now() - startTime,
          hitKey: "resolvedMint",
        });
        // History push intentionally skipped on cache-hit (see the
        // comment on the CA-cache branch above for the rationale —
        // duplicate entries on refresh, no new signal, costs Redis).
        return res.json(withServeWindows(cachedByMint));
      }
    }
    if (dexData?.pairs && dexData.pairs.length > 1) {
      pair = selectBestPair(dexData.pairs, resolvedMint) ?? pair;
    }

    const pairAddress = pair?.pairAddress ?? ca;
    // The full RugCheck report (bundle, snipers, rug history, creator sells) is about the TOKEN. Phase 1 asked for it under the address
    // the page gave us, and when that was a PAIR address (DexScreener puts the pair in its URLs) RugCheck answers 400: the report stayed
    // empty while every other source was read for the resolved mint, and those four checks were skipped without a word (audit A-07). Now
    // that the mint is known, read it for the mint, in parallel with phase 2.
    const rugReportPromise: Promise<unknown> = resolvedMint === ca
      ? Promise.resolve(rugReportRes)
      : withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report`, {}, 5000), rugcheckWaitMs());
    const tokenAgeMinutes: number | null = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 60000 : null;

    // GoPlus is started here, not inside the list below, because its holder count is also an INPUT of the holder pages: when it already
    // says the token has far more holders than the pages can count, the Helius pages stop after the first one (they could not change
    // the count shown, see heliusGetHolderPages). The answer itself is read from the same promise below.
    const goplusPromise = withBudget(fetchGoPlusSecurityCached(resolvedMint, tokenAgeMinutes, { fresh }), remainingMs());
    const goplusHolderCount: Promise<number | null> = goplusPromise
      .then((raw) => positiveCount(pickGoPlusResult(raw, resolvedMint)?.holder_count))
      .catch(() => null);
    // Solscan's token/meta is started here too: it gives the age AND the holder count, and the count decides whether the Helius pages after
    // page 1 are needed at all (heliusGetHolderPages). The answer itself is read from the same promise below.
    const solMetaPromise = withBudget(fetchSolscan(`/token/meta?address=${resolvedMint}`), remainingMs());
    const solscanHolderCount: Promise<number | null> = solMetaPromise
      .then((raw) => (isSolscanMeta(raw) ? positiveCount(raw.data?.holder) : null))
      .catch(() => null);

    const [
      candlesRaw, candlesDailyRaw, goplusRaw,
      heliusHoldersRaw, heliusSupplyRaw, heliusHolderPagesRaw,
      solMeta, solTransfers, solMarkets,
      rugReportResolvedRaw,
    ] = await Promise.all([
      withBudget(fetchDexCandles(pairAddress), remainingMs()),
      withBudget(fetchDexCandlesDaily(pairAddress, resolvedMint), remainingMs()),
      goplusPromise,
      HELIUS_API_KEY ? withBudget(heliusAskTwice(() => heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY)), remainingMs()) : null,
      HELIUS_API_KEY ? withBudget(heliusAskTwice(() => heliusGetMintAccount(resolvedMint, HELIUS_API_KEY)), remainingMs()) : null,
      HELIUS_API_KEY ? withBudget(heliusGetHolderPages(resolvedMint, HELIUS_API_KEY, goplusHolderCount, solscanHolderCount), remainingMs()) : null,
      // (No Solscan holders-count call: the public endpoint it used answers
      // 404 for every token, so it only ever contributed `null`.)
      solMetaPromise,
      // page_size=50 (was 10): the Holder Activity tab classifies the
      // last hour of activity per top-6 holder. With only 10 token-wide
      // transfers we frequently saw all holders rendered Static because
      // none of those 10 transfers happened to involve any of the 6
      // tracked wallets — even on liquid tokens. 50 covers ~6-12 hours
      // of typical-volume tokens, plenty for a 1h-window classifier,
      // and stays well within Solscan's free-tier per-page cap.
      SOLSCAN_AGE_AND_HOLDERS_ONLY ? null : withBudget(fetchSolscan(`/token/transfer?address=${resolvedMint}&page=1&page_size=50`), remainingMs()),
      SOLSCAN_AGE_AND_HOLDERS_ONLY ? null : withBudget(fetchSolscan(`/token/markets?address=${resolvedMint}&page=1&page_size=1`), remainingMs()),
      rugReportPromise,
    ]);

    const candles: OHLCVCandle[] = Array.isArray(candlesRaw) ? candlesRaw : [];
    const dailyCandles: OHLCVCandle[] = Array.isArray(candlesDailyRaw) ? candlesDailyRaw : [];
    const goplus = pickGoPlusResult(goplusRaw, resolvedMint);
    const heliusResponse = isHeliusLargestAccountsResponse(heliusHoldersRaw) ? heliusHoldersRaw : null;
    let rawHolderAccounts: HeliusHolder[] = heliusResponse?.result?.value ?? [];
    // heliusSupplyRaw is a getAccountInfo(jsonParsed) response on the mint: supply AND authorities in one request.
    let mintState = parseMintState(heliusSupplyRaw);
    let totalSupplyUi: number = mintSupplyUi(mintState);
    if (!mintState) {
      try { mintState = parseMintState(await stepBudget(() => publicRpcGetMintAccount(resolvedMint))); }
      catch { /* the authorities stay "not verified" */ }
      if (mintState && totalSupplyUi <= 0) totalSupplyUi = mintSupplyUi(mintState);
    }
    // Contract facts: the chain first, GoPlus second; never defaulted to "OK".
    const authFacts = deriveAuthorityFacts(mintState, goplus, resolvedMint);

    // Free public Solana RPC fallback for the two Helius RPC calls that
    // matter for holder concentration. Same JSON-RPC interface, same
    // response shape, no API key. Triggered when Helius is unset or
    // returned no usable data — gives a token-distribution signal even
    // for users running without a paid Helius tier.
    if (rawHolderAccounts.length === 0) {
      try {
        const fallback = await stepBudget(() => publicRpcGetLargestAccounts(resolvedMint));
        const parsed = isHeliusLargestAccountsResponse(fallback) ? fallback : null;
        rawHolderAccounts = parsed?.result?.value ?? [];
      } catch { /* keep empty — section will gracefully degrade */ }
    }
    if (totalSupplyUi <= 0) {
      try {
        const fallback = await stepBudget(() => publicRpcGetTokenSupply(resolvedMint));
        const parsed = isHeliusSupplyResponse(fallback) ? fallback : null;
        totalSupplyUi = asNumber(parsed?.result?.value?.uiAmount);
      } catch { /* keep 0 — try next fallback */ }
    }
    // Last-resort: getAccountInfo on the mint reads the SPL-Token mint state
    // directly. Always works on free public RPCs (cheap call) and gives both
    // raw supply and decimals — we divide to get uiAmount. Triggers only if
    // the dedicated getTokenSupply path returned 0.
    if (totalSupplyUi <= 0) {
      try {
        const mintInfo = await stepBudget(() => publicRpcGetMintInfo(resolvedMint));
        if (mintInfo) totalSupplyUi = mintInfo.supplyUi;
      } catch { /* keep 0 — concentration calc will be null */ }
    }

    const solMarketsData = isSolscanMarketsResponse(solMarkets) ? solMarkets : null;
    const resolvedHolderAccounts: HeliusHolder[] = HELIUS_API_KEY && rawHolderAccounts.length > 0
      ? await stepBudget(() => heliusResolveAccountOwners(rawHolderAccounts, HELIUS_API_KEY)) ?? rawHolderAccounts.map(h => ({ ...h, owner: h.owner ?? h.address }))
      : rawHolderAccounts.map(h => ({ ...h, owner: h.owner ?? h.address }));
    const solMarketPool: SolscanMarketPool | null =
      Array.isArray(solMarketsData?.data) && solMarketsData!.data!.length > 0
      ? [...solMarketsData!.data!].sort((a: SolscanMarketPool, b: SolscanMarketPool) => asNumber(b.liquidity) - asNumber(a.liquidity))[0]
      : null;
    const solMetaAnswer = isSolscanMeta(solMeta) ? solMeta : null;
    const solscanCreatedTime: number | null = solMetaAnswer?.data?.created_time ?? null;
    // SOLSCAN_AGE_AND_HOLDERS_ONLY (constants.ts): nothing but the age is taken from the answer. The logo, the creator (and the Helius call that reads
    // his history), the decimals, the supply and "Solscan answered" stay what they were while Solscan refused the key.
    const solMetaData = SOLSCAN_AGE_AND_HOLDERS_ONLY ? null : solMetaAnswer;
    // Token age: take the MAX of Solscan token-mint time and DexScreener
    // pair-creation time. The two measure different events (mint vs pair
    // listing) and either source can fail or return stale data; the older
    // is the safer floor on actual token age. Previously we took whichever
    // came first which would underreport age when Solscan was rate-limited.
    const dexTokenAgeHours: number | null = pair?.pairCreatedAt
      ? Math.floor((Date.now() - pair.pairCreatedAt) / 3_600_000)
      : null;
    const solscanOnlyAge: number | null = solscanCreatedTime !== null
      ? Math.floor((Date.now() / 1000 - solscanCreatedTime) / 3600)
      : null;
    const solscanTokenAgeHours: number | null = (() => {
      if (solscanOnlyAge === null && dexTokenAgeHours === null) return null;
      if (solscanOnlyAge === null) return dexTokenAgeHours;
      if (dexTokenAgeHours === null) return solscanOnlyAge;
      return Math.max(solscanOnlyAge, dexTokenAgeHours);
    })();

    // Last-resort supply fallback from Solscan Pro meta when both Helius and
    // public RPC failed — only effective if SOLSCAN_API_KEY is set. The
    // earlier Helius → public-RPC chain covers free deployments.
    if (totalSupplyUi <= 0 && solMetaData?.data?.supply && typeof solMetaData.data.decimals === "number") {
      const rawSupply = asNumber(solMetaData.data.supply);
      if (rawSupply > 0) {
        totalSupplyUi = rawSupply / Math.pow(10, solMetaData.data.decimals);
      }
    }
    const solscanVolume24h: number | null  = asNumber(solMarketPool?.volume)    || asNumber(pair?.volume?.h24) || null;
    const solscanTrades24h: number | null  = asNumber(solMarketPool?.trade)     || null;
    const solscanTraders24h: number | null = asNumber(solMarketPool?.trader)    || null;
    const solscanLiquidity: number | null  = asNumber(solMarketPool?.liquidity) || null;
    const tokenLogo    = solMetaData?.data?.icon || pair?.info?.imageUrl || null;
    const tokenCreator = solMetaData?.data?.creator || null;

    const creatorReputation: CreatorReputation | null = tokenCreator && HELIUS_API_KEY
      ? await stepBudget(() => heliusGetCreatorReputation(tokenCreator, HELIUS_API_KEY))
      : null;

    const tokenDecimals = solMetaData?.data?.decimals ?? null;
    const tokenSupply   = solMetaData?.data?.supply   ?? null;
    const solTransfersData = isSolscanTransfersResponse(solTransfers) ? solTransfers : null;
    const recentTransfers: SolscanTransfer[] = solTransfersData?.data || [];
    const rugReport = isRugCheckReport(rugReportResolvedRaw) ? rugReportResolvedRaw : null;
    const rugTotalHolders: number | null =
      typeof rugReport?.totalHolders === "number" && rugReport.totalHolders > 0
      ? rugReport.totalHolders : null;
    // Holder count, by ORDER of reliability (see pickHolderCount): the chain through Helius when its pages reach the end
    // of the list (exact and current: up to HOLDER_MAX_PAGES x 1000 holders, which covers where GoPlus and RugCheck fail
    // or overcount), then Solscan (as exact, no cap; it also stops the pages after page 1), then GoPlus, then RugCheck
    // (counts emptied accounts too), never below the chain floor. Never the size of the top-20 list.
    const holders: number | null = pickHolderCount({
      chain: parseChainHolders(heliusHolderPagesRaw),
      solscan: solMetaAnswer?.data?.holder,
      goplus: goplus?.holder_count,
      rugcheck: rugTotalHolders,
    });

    const priceUsd: number | null = (() => {
      const n = parseFloat(pair?.priceUsd ?? "");
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const marketCap: number | null = (() => {
      const mc = asNumber(pair?.marketCap), fdv = asNumber(pair?.fdv);
      const computed = totalSupplyUi > 0 && priceUsd ? totalSupplyUi * priceUsd : 0;
      return mc > 0 ? mc : computed > 0 ? computed : fdv > 0 ? fdv : null;
    })();
    const liquidity      = asNumber(pair?.liquidity?.usd) || solscanLiquidity  || null;
    const volume24h      = asNumber(pair?.volume?.h24)    || solscanVolume24h  || null;
    const volume1h       = asNumber(pair?.volume?.h1)     || null;
    const priceChange5m  = pair?.priceChange?.m5  ?? null;
    const priceChange1h  = pair?.priceChange?.h1  ?? null;
    const priceChange24h = pair?.priceChange?.h24 ?? null;

    const tokenName: string | null = sanitizeString(pair?.baseToken?.name) ?? null;

    // A token that has already rugged stays a RUG (api/_lib/condemned.ts): read its record before the decision, so the AI summary and
    // everything after it speak of the verdict the user will see. A slow or failed read is "not condemned": it never delays or changes a scan.
    const condemnedEntry = await withBudget(getCondemned(resolvedMint), 800);

    // From what the upstreams said to the verdict: a pure function (api/_lib/decide.ts), nothing is read or written there.
    const decision = applyCondemnation(decide({
      pair, dexData, resolvedMint, marketCap, tokenAgeMinutes, holders, rugData, rugReport, tokenName, goplus, authFacts, totalSupplyUi,
      solscanTokenAgeHours, dexTokenAgeHours, resolvedHolderAccounts, solscanTrades24h, solscanTraders24h,
      solscanAnswered: solMetaData !== null || solTransfersData !== null || solMarketsData !== null,
      candles, dailyCandles, recentTransfers, creatorReputation,
    }), condemnedEntry);
    for (const note of decision.notes) logger.info("scan", note.message, { requestId, ca: resolvedMint, ...note.data });
    const { score, risk, rugKind, flags, safeBlocked, safeBlockedReasons, confidence, sources_used, layersSnapshot, lpBurned, lpLocked } = decision;

    // Compute holder concentration: top1 + top10 percentages of total supply.
    // CRITICAL: filter out LP program accounts and foundation wallets first
    // — they hold large amounts on behalf of pools (Raydium, Orca, PumpSwap…)
    // and are not real holders. Without this filter, "Single wallet holds X%"
    // would fire for the LP itself and the concentration bar would show the
    // LP balance as user concentration. Same filter as layerHelius for
    // consistency between the flags and the displayed numbers.
    const realHolderAccounts: HeliusHolder[] = resolvedHolderAccounts.filter(
      h => !LP_PROGRAM_ADDRESSES.has(h.owner) && !FOUNDATION_WALLETS.has(h.owner),
    );
    // Fallback chain for top-N holder concentration:
    //   1. Helius-derived from realHolderAccounts (richest signal)
    //   2. RugCheck topHolders.top10Percentage / top1Percentage
    //
    // The previous version returned null when Helius was unavailable
    // even on tokens where RugCheck had the same data. The Insider
    // Watch tab + the Sniper Map's concentration view both rely on
    // these fields — leaving them null left those tabs blank on
    // every token where Helius was down (BONK, large established
    // tokens that are too big for Helius to walk in time).
    const rugTopHolders = (rugData as { topHolders?: { top1Percentage?: number; top1HolderPercentage?: number; top10Percentage?: number } } | null)?.topHolders;
    const topHolderPct: number | null = (() => {
      if (realHolderAccounts.length > 0 && totalSupplyUi > 0) {
        const topAmt = asNumber(realHolderAccounts[0]?.uiAmount);
        if (topAmt > 0) return (topAmt / totalSupplyUi) * 100;
      }
      const rcTop1 = asNumber(rugTopHolders?.top1Percentage ?? rugTopHolders?.top1HolderPercentage);
      return rcTop1 > 0 ? Math.min(100, rcTop1) : null;
    })();
    const top10HolderPct: number | null = (() => {
      if (realHolderAccounts.length > 0 && totalSupplyUi > 0) {
        const top10Sum = realHolderAccounts.slice(0, 10)
          .reduce((sum, h) => sum + asNumber(h?.uiAmount), 0);
        if (top10Sum > 0) return Math.min(100, (top10Sum / totalSupplyUi) * 100);
      }
      const rcTop10 = asNumber(rugTopHolders?.top10Percentage);
      return rcTop10 > 0 ? Math.min(100, rcTop10) : null;
    })();

    // ─── V5 Critical Actors preview ───────────────────────────────────
    // Compose the hero cards (Dev / Insider). The Cluster card needs the insider graph, which is NOT built here any more:
    // it cost ~120 Helius credits per cold scan (20 getSignaturesForAddress + one Enhanced Transactions request at 100) for a
    // display-only feature that feeds no verdict. The graph is built on demand by api/graph.ts, when token.html opens the
    // Insider Watch tab. composeCriticalActors and composeHolderActivity already handle `insiderGraph: null`.
    const criticalActors = composeCriticalActors({
      tokenCreator,
      creatorReputation,
      realHolderAccounts,
      totalSupplyUi,
      insiderGraph: null,
    });

    // ─── V5 Holder Activity ───────────────────────────────────────────
    // Derived in-process from recentTransfers (Solscan, last ~50 txs)
    // and the top realHolderAccounts. No extra RPC calls.
    const holderActivity = composeHolderActivity({
      realHolderAccounts,
      tokenCreator,
      totalSupplyUi,
      recentTransfers,
      insiderGraph: null,
    });

    const aiSummary = await generateAISummary({
      score, risk,
      flags: flags.map(f => ({ label: f.label, severity: f.severity, impact: f.impact })),
      tokenSymbol: sanitizeString(pair?.baseToken?.symbol) ?? null,
      holders, marketCap, liquidity,
      lpBurned,
      lpLocked,
      mintAuthority: authFacts.mint,
      freezeAuthority: authFacts.freeze,
      honeypot: authFacts.sellBlocked,
      tokenAgeHours: solscanTokenAgeHours ?? dexTokenAgeHours ?? null,
      sourcesUsed: sources_used,
      topHolderPct,
      volume24h,
      priceChange1h,
    }, {
      // The summary is cosmetic: it may use what is left of the scan budget,
      // minus a reserve for the cache writes and the response, and never
      // more than AI_PHASE_BUDGET_MS. Out of time -> local fallback summary.
      budgetMs: remainingMs() - AI_RESERVE_MS,
    }).catch(() => null);

    // ─── Verdict Timeline (decommissioned) ───────────────────────────
    // Was a per-token ZSET (push current verdict, read back last N
    // entries) feeding the Timeline tab in the overlay. The Timeline
    // tab was replaced by Insider Watch and the frontend stopped
    // reading `verdictHistory` long ago; the writes/reads kept burning
    // ~5 Redis commands per scan for no consumer. Removed on
    // 2026-05-11 during the Upstash budget audit. The field stays on
    // `ScanResult` (optional) with a single "current" entry so any
    // stale frontend that still parses it doesn't crash on a null.
    const currentEntry = {
      ts: Date.now(),
      verdict: risk,
      score,
      event: deriveEvent(risk, flags),
    };
    const finalHistory = [currentEntry];

    let result: ScanResult = {
      score, risk, rugKind, flags: flags.map(toPublicFlag), pair, resolvedMint, confidence, sources_used,
      holders, marketCap, priceUsd, liquidity,
      volume24h, volume1h, priceChange5m, priceChange1h, priceChange24h,
      tokenSymbol: sanitizeString(pair?.baseToken?.symbol) ?? null,
      tokenName: sanitizeString(pair?.baseToken?.name) ?? null,
      pairCreatedAt: pair?.pairCreatedAt ?? null,
      safeBlocked, safeBlockedReasons, tokenLogo: sanitizeUrl(tokenLogo), tokenCreator,
      tokenDecimals, tokenSupply, recentTransfers,
      solscanTokenAgeHours, solscanVolume24h, solscanTrades24h, solscanTraders24h,
      layers: layersSnapshot,
      honeypot: authFacts.sellBlocked,
      mintAuthority: authFacts.mint,
      freezeAuthority: authFacts.freeze,
      lpBurned,
      lpLocked,
      lpLockedPct: decision.lpBurnedPct > 0 ? Math.round(decision.lpBurnedPct * 100) / 100 : null,
      candles: candles.slice(-20).map(c => ({ close: c.c })),
      topHolderPct,
      top10HolderPct,
      criticalActors,
      verdictHistory: finalHistory,
      holderActivity,
      scoring_version: SCORING_VERSION,
      fetchedAt: Date.now(),
      requestId,
      aiSummary: aiSummary ?? null,
    };

    // Cache only if aiSummary was generated — otherwise keep TTL short (30s) so the
    // next request retries AI generation instead of serving a null-summary forever.
    // The verdict is passed so computeCacheTTL can apply asymmetric caching:
    // bad verdicts cache long (stale-RUG is safe), good verdicts on young
    // tokens cache short (stale-SAFE is dangerous).
    //
    // A result produced under deadline pressure (the data budget was used up),
    // or with no source at all, is kept only briefly too: a verdict born from
    // missing data must not stick for everyone for the full TTL. That is how a
    // bad answer for a well-known token could survive for 10 minutes.
    // The same goes for a SAFE or CAUTION born without the chart layer on a token old enough to have candles: usually a GeckoTerminal
    // rate limit, after which the next try can give another verdict (audit M11). Bad verdicts keep their long TTL.
    // And for a scan with no DexScreener pool at all: DexScreener answers "no pairs" during an outage too (about an hour, 2026-10-07), the
    // answer cannot be told from a token that really has no pool, and a verdict born from a market nobody read (a RUG for a token the market
    // would have cleared) must not stick for 30 minutes.
    // And for a scan made while Helius, RugCheck or GoPlus did not answer (they are missing for under 1 % of tokens, whatever the verdict: an outage).
    const deadlineSpent = scanDeadline - Date.now() < MIN_STEP_MS;
    const chartGap = isChartGapDegraded(result.risk, result.layers?.chart?.available, tokenAgeMinutes);
    const reportGap = isReportGapDegraded(result.risk, resolvedMint !== ca, rugReport !== null);
    const layerGap = isLayerGap(result.layers);
    const degraded = sources_used.length === 0 || deadlineSpent || pair === null || chartGap || reportGap || layerGap;
    result.degraded = degraded;
    // 2026-10-14: replayed on the 1 121 tokens of the corpus with ONE source silent, the verdict a scan reaches without it is not the token's: without Helius
    // 172 SAFE read CAUTION and 132 RUG read DANGER, without RugCheck 4 DANGER read SAFE, without GoPlus 21 SAFE read CAUTION. So a scan made while a source
    // did not answer carries NO verdict for the user: `sourceGap` makes the overlay show "Limited data", count down and ask again (the answer is kept 30 s).
    // The badge, the alerts and the history ignore it, and so does the rug database (below). "No pool" is not in this list (it cannot be told from a token that
    // has none), and an issuer's asset whose market cannot be read keeps its own answer (the last verdict, with its age: api/_lib/last-good.ts).
    // LIMITED_DATA=off (helpers.ts limitedDataEnabled) is the emergency switch: no scan is marked, the engine's verdict is shown as before.
    result.sourceGap = limitedDataEnabled() && isScanIncomplete({ layers: result.layers, sourcesUsed: sources_used.length, deadlineSpent, chartGap, reportGap });
    // An issuer-backed token (stablecoin, tokenized stock, LST...): the verdict of the last time its market WAS read is kept; when DexScreener
    // cannot be read, that verdict is served again with its age ("Scanned 6 min ago") instead of a verdict born from no market, unless this
    // scan itself found something worse (a fact from another source). See api/_lib/last-good.ts.
    if (decision.issuerBacked) {
      if (decision.issuerBacked.marketRead) {
        if (!degraded) setLastGoodResult(resolvedMint, result);
      } else {
        const memory = serveLastGood(await getLastGoodResult<ScanResult>(resolvedMint), result);
        if (memory) result = memory;
      }
    }
    if (result.aiSummary && !degraded) {
      setCachedResult(ca, result, tokenAgeMinutes, result.risk);
      if (resolvedMint !== ca) setCachedResult(resolvedMint, result, tokenAgeMinutes, result.risk);
    } else {
      // No AI summary yet, or a degraded result — short-TTL cache so a
      // same-CA reload within 30s skips re-running the whole pipeline, but
      // the cache expires fast enough to pick up a complete answer next time.
      setShortCachedResult(ca, result, 30);
      if (resolvedMint !== ca) setShortCachedResult(resolvedMint, result, 30);
    }

    // A preview deployment must not write into production's rug database (see deployment.ts).
    if (!isPreviewDeployment() && !result.sourceGap) void recordRug({ mint: resolvedMint, symbol: sanitizeString(pair?.baseToken?.symbol) ?? null, score, risk, flags, creator: tokenCreator });

    // A RUG confirmed by a fact, on complete data, condemns the token for good (the first record is kept; a record that exists is not rewritten).
    if (!condemnedEntry && shouldCondemn({ risk, rugKind, degraded, preview: isPreviewDeployment() })) {
      void condemn(condemnedEntryOf(decision, resolvedMint, sanitizeString(pair?.baseToken?.symbol) ?? null));
    }

    // Emit a structured outcome event for every completed scan. Downstream
    // log aggregators can chart verdict distribution, layer availability,
    // and latency distribution without needing to re-derive them from logs.
    logger.metric("scan.outcome", {
      requestId,
      mint: resolvedMint,
      verdict: risk,
      score,
      layers: result.layers,
      latencyMs: Date.now() - startTime,
      sourcesUsed: sources_used.length,
      partial: sources_used.length < Object.keys(LAYER_WEIGHTS).length,
      // true = ran out of time or had no source: the signal to alert on.
      degraded,
      // true = a source was silent: no verdict is shown for this scan ("Limited data"), see sourceGap above.
      limited: result.sourceGap === true,
      scoringVersion: SCORING_VERSION,
    });

    if (installId && !result.sourceGap) {
      void pushScanHistory(installId, {
        ca: result.resolvedMint ?? ca,
        score: result.score,
        verdict: result.risk,
        scannedAt: Date.now(),
        symbol: result.tokenSymbol ?? undefined,
        name: result.tokenName ?? undefined,
      });
    }

    // Write the upstream-usage counters of this cold scan (one Redis command, at most 300 ms, never an error for the user).
    await flushUsage();
    return res.json(withServeWindows(result));
  } catch (e) {
    logger.error("scan", "analysis error", { requestId, version: SCORING_VERSION, error: String(e) });
    captureError(e, { endpoint: "scan", requestId, ca });
    return apiError(res, 500, "Analysis error.");
  }
}
