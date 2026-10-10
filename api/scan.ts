import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type {
  ScanFlag, Verdict, Severity,
  DexScreenerPair,
  HeliusHolder,
  SolscanTransfer, SolscanMarketPool,
  OHLCVCandle,
  ScanResult, LayerSnapshot,
} from "./_lib/types";
import {
  fetchJson, asNumber, pickGoPlusResult,
  withBudget, apiError,
  isValidDexScreenerResponse, isValidRugCheckSummary,
  isHeliusLargestAccountsResponse, isHeliusSupplyResponse,
  isSolscanMarketsResponse, isSolscanMeta, isSolscanTransfersResponse,
  isRugCheckReport,
  sanitizeString, sanitizeUrl,
  makeFlag,
} from "./_lib/helpers";
import {
  heliusGetLargestAccounts, heliusGetMintAccount, heliusGetHolderPages, heliusGetCreatorReputation,
  heliusResolveAccountOwners,
  publicRpcGetLargestAccounts, publicRpcGetTokenSupply, publicRpcGetMintInfo, publicRpcGetMintAccount,
  fetchSolscan, fetchDexCandles, fetchDexCandlesDaily,
  type CreatorReputation,
} from "./_lib/fetchers";
import { readHeliusKey } from "./_lib/helius";
import { parseMintState, mintSupplyUi, deriveAuthorityFacts, weightedBurnPct, parseChainHolders, pickHolderCount } from "./_lib/facts";
import { fetchGoPlusSecurity } from "./_lib/goplus-auth";
import {
  DEXSCREENER_BASE, RUGCHECK_BASE, LAYER_WEIGHTS, SCORING_VERSION,
  LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS,
  HARD_BLOCK_REASONS,
} from "./_lib/constants";
import {
  layerDexScreener, layerRugCheck, layerGoPlus, layerHelius,
  layerSolscan, layerChart, layerCrossValidation,
} from "./_lib/layers";
import { computeLpPctOfSupply, getLpRiskBucket } from "./_lib/lp-risk-matrix";
import { selectBestPair } from "./_lib/dex-pair-select";
import { computeFinalScore, classifySafeBlockedReasons } from "./_lib/scoring";
import { evaluatePostLayerFlags, applySafeGateOverride, applyEstablishedBonus, determineVerdict } from "./_lib/pipeline";
import { setCorsHeaders, getClientIp, getInstallId, checkRateLimit, checkColdScanLimit, validateCA, initRateLimiters } from "./_lib/middleware";
import { initQuota, checkDailyQuota, setQuotaHeaders, secondsUntilReset } from "./_lib/quota";
import { initUserStorage, pushScanHistory, resolveTierAndBypass } from "./_lib/user";
import { initCache, getCachedResult, setCachedResult, setShortCachedResult, acquireScanLock, releaseScanLock, waitForCachedResult } from "./_lib/cache";
import { initSentry, captureError } from "./_lib/sentry";
import { generateAISummary } from "./_lib/ai-summary";

import { initRugDb, recordRug } from "./_lib/rugdb";
import { isPreviewDeployment } from "./_lib/deployment";
import { logger } from "./_lib/logger";
import { composeCriticalActors } from "./_lib/critical-actors";
import { buildInsiderGraph, initGraphCache } from "./_lib/insider-graph";
import { deriveEvent } from "./_lib/verdict-history";
// initHistoryCache / pushVerdictHistory / getVerdictHistory are no
// longer imported — the Verdict Timeline feature was decommissioned
// (see the "Verdict Timeline (decommissioned)" block lower in this
// file for the full rationale). `deriveEvent` is still imported
// because the current-scan entry still tags the verdict with a
// human-readable event label.
import { composeHolderActivity } from "./_lib/holder-activity";
import { composeOutcomeStats } from "./_lib/outcome-stats";
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
  initGraphCache(redis);
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
    return res.json(cached);
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
    holdsLock = await acquireScanLock(ca);
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
        return res.json(coalesced);
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
    if (holdsLock) void releaseScanLock(ca);
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
    if (holdsLock) void releaseScanLock(ca);
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
  // For the SERIAL steps that follow the parallel phases. `withBudget(fn(), ms)`
  // starts the call even when no time is left (it only stops WAITING for it);
  // this starts a step only if it still has a chance to finish.
  const stepBudget = <T>(start: () => Promise<T>): Promise<T | null> =>
    scanDeadline - Date.now() < MIN_STEP_MS ? Promise.resolve(null) : withBudget(start(), remainingMs());

  try {
    const [dexRes, rugRes, rugReportRes] = await Promise.all([
      withBudget(fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`, {}, 5000), remainingMs()),
      withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`, {}, 5000), remainingMs()),
      withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report`, {}, 5000), remainingMs()),
    ]);

    let dexData = isValidDexScreenerResponse(dexRes) ? dexRes : null;
    let rugData = isValidRugCheckSummary(rugRes) ? rugRes : null;
    let pair: DexScreenerPair | null = dexData?.pairs?.[0] ?? null;
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
          withBudget(fetchJson(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`, {}, 5000), remainingMs()),
        ]);
        const dexRetryTyped = isValidDexScreenerResponse(dexRetry) ? dexRetry : null;
        const rugRetryTyped = isValidRugCheckSummary(rugRetry) ? rugRetry : null;
        if (dexRetryTyped?.pairs?.[0]) { dexData = dexRetryTyped; pair = dexRetryTyped.pairs[0]; }
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
        return res.json(cachedByMint);
      }
    }
    if (dexData?.pairs && dexData.pairs.length > 1) {
      pair = selectBestPair(dexData.pairs) ?? pair;
    }

    const pairAddress = pair?.pairAddress ?? ca;
    const tokenAgeMinutes: number | null = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 60000 : null;

    const [
      candlesRaw, candlesDailyRaw, goplusRaw,
      heliusHoldersRaw, heliusSupplyRaw, heliusHolderPagesRaw,
      solMeta, solTransfers, solMarkets,
    ] = await Promise.all([
      withBudget(fetchDexCandles(pairAddress), remainingMs()),
      withBudget(fetchDexCandlesDaily(pairAddress, resolvedMint), remainingMs()),
      withBudget(fetchGoPlusSecurity(resolvedMint), remainingMs()),
      HELIUS_API_KEY ? withBudget(heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY), remainingMs()) : null,
      HELIUS_API_KEY ? withBudget(heliusGetMintAccount(resolvedMint, HELIUS_API_KEY), remainingMs()) : null,
      HELIUS_API_KEY ? withBudget(heliusGetHolderPages(resolvedMint, HELIUS_API_KEY), remainingMs()) : null,
      // (No Solscan holders-count call: the public endpoint it used answers
      // 404 for every token, so it only ever contributed `null`.)
      withBudget(fetchSolscan(`/token/meta?address=${resolvedMint}`), remainingMs()),
      // page_size=50 (was 10): the Holder Activity tab classifies the
      // last hour of activity per top-6 holder. With only 10 token-wide
      // transfers we frequently saw all holders rendered Static because
      // none of those 10 transfers happened to involve any of the 6
      // tracked wallets — even on liquid tokens. 50 covers ~6-12 hours
      // of typical-volume tokens, plenty for a 1h-window classifier,
      // and stays well within Solscan's free-tier per-page cap.
      withBudget(fetchSolscan(`/token/transfer?address=${resolvedMint}&page=1&page_size=50`), remainingMs()),
      withBudget(fetchSolscan(`/token/markets?address=${resolvedMint}&page=1&page_size=1`), remainingMs()),
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
    const authFacts = deriveAuthorityFacts(mintState, goplus);

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
    const solMetaData = isSolscanMeta(solMeta) ? solMeta : null;
    const solscanCreatedTime: number | null = solMetaData?.data?.created_time ?? null;
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
    const rugReport = isRugCheckReport(rugReportRes) ? rugReportRes : null;
    const rugTotalHolders: number | null =
      typeof rugReport?.totalHolders === "number" && rugReport.totalHolders > 0
      ? rugReport.totalHolders : null;
    // Holder count, by ORDER of reliability (see pickHolderCount): the chain through Helius when its pages reach the end
    // of the list (exact and current: up to HOLDER_MAX_PAGES x 1000 holders, which covers where GoPlus and RugCheck fail
    // or overcount), then GoPlus, then RugCheck (counts emptied accounts too), never below the chain floor. Never the
    // size of the top-20 list.
    const holders: number | null = pickHolderCount({
      chain: parseChainHolders(heliusHolderPagesRaw),
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

    // 7 layers
    const l1 = layerDexScreener(pair, marketCap, tokenAgeMinutes);
    // Shared maturity context — rugcheck, goplus, and helius all need
    // the same view of "is this an established token" so soft signals
    // (unburned LP, top-1 concentration on a 100k-holder memecoin) get
    // the established-context treatment consistently. Building once.
    //
    // We use the unified `holders` value (max of all sources) so the
    // helius dampening sees the same holder count the response reports.
    // Earlier version restricted to solscan+rugcheck only, which made
    // the maturity dampening miss every token where Helius/GoPlus
    // were the only sources reporting holders (most blue-chips).
    //
    // _earlyLpBurned ORs rugcheck and goplus signals so MEW/FARTCOIN
    // (LP burn confirmed by GoPlus only) get the established-context
    // treatment in helius, not just in rugcheck/goplus.
    const _gpEarlyBurnPct = weightedBurnPct(goplus?.dex) ?? 0;
    const _earlyLpBurned = rugData?.lpBurned === true ? true
      : _gpEarlyBurnPct >= 50 ? true
      : rugData?.lpBurned === false ? false
      : null;
    // Compute the share of total supply that sits in the LP. Feeds the
    // 2-axis LP risk matrix (api/_lib/lp-risk-matrix.ts) so the verdict
    // reflects actual rug-pull capacity, not just "is LP locked?". See
    // computeLpPctOfSupply for the back-compute math (DexScreener
    // doesn't expose liquidity.base directly in our schema, so we derive
    // it from liquidity.usd × priceUsd × totalSupply, accurate to ~5%
    // on classic AMM pools).
    const _lpPctOfSupply = computeLpPctOfSupply(
      asNumber(pair?.liquidity?.usd),
      asNumber(pair?.priceUsd),
      totalSupplyUi,
    );
    const maturityCtx = {
      holders: holders,
      liquidity: asNumber(pair?.liquidity?.usd),
      tokenAgeHours: solscanTokenAgeHours,
      mintAuthority: authFacts.mint === true && !authFacts.trusted,
      freezeAuthority: authFacts.freeze === true && !authFacts.trusted,
      honeypot: authFacts.sellBlocked === true,
      lpBurned: _earlyLpBurned,
      lpPctOfSupply: _lpPctOfSupply,
    };
    const l2 = layerRugCheck(rugData, rugReport, resolvedMint, tokenName, maturityCtx);
    const l3 = layerGoPlus(goplus, maturityCtx, authFacts);
    // Collect all DEXScreener pair addresses for this token.
    // For AMMs that use per-pool PDAs as vault authority (PumpSwap, Meteora DBC…)
    // the pair address IS the decoded authority of the LP vault token account.
    // Passing it here lets layerHelius exclude the LP vault without any extra
    // RPC calls — the data is already in memory from the DEXScreener fetch.
    const dexPairAddresses = new Set<string>(
      (dexData?.pairs ?? [])
        .map((p: DexScreenerPair) => p.pairAddress)
        .filter((a: unknown): a is string => typeof a === "string" && a.length > 0)
    );
    const l4 = layerHelius(resolvedHolderAccounts, totalSupplyUi, maturityCtx, dexPairAddresses);
    // Holder count: null, as it effectively always was (the Solscan holders endpoint is dead).
    const l5 = layerSolscan(null, solscanTokenAgeHours, solscanTrades24h, solscanTraders24h, solMetaData !== null || solTransfersData !== null || solMarketsData !== null);
    const l6 = layerChart(candles, pair, tokenAgeMinutes, maturityCtx, dailyCandles.length >= 2 ? dailyCandles : undefined);
    const l7 = layerCrossValidation(rugData, resolvedHolderAccounts, goplus, solscanTokenAgeHours, dexTokenAgeHours, totalSupplyUi, authFacts);

    const allLayers = [l1, l2, l3, l4, l5, l6, l7];
    let score       = computeFinalScore(allLayers);
    let forceRug    = allLayers.some(l => l.forceRug);
    let safeBlocked = allLayers.some(l => l.safeBlocked);

    const buys5m  = asNumber(pair?.txns?.m5?.buys);
    const sells5m = asNumber(pair?.txns?.m5?.sells);
    const liqUsd  = asNumber(pair?.liquidity?.usd);
    const ageMin  = tokenAgeMinutes ?? 0;
    const volLiqRatio = liqUsd > 0 ? asNumber(pair?.volume?.h24) / liqUsd : 0;

    const postLayerResult = evaluatePostLayerFlags({
      buys5m, sells5m, liqUsd, ageMin,
      recentTransfers, creatorReputation, volLiqRatio,
    });
    const postLayerFlags = postLayerResult.flags;
    if (postLayerResult.forceRug) forceRug = true;
    if (postLayerResult.safeBlocked) safeBlocked = true;

    const safeBlockedReasons = classifySafeBlockedReasons(allLayers);
    const _gpBP = weightedBurnPct(goplus?.dex) ?? 0; const lpBurned = _gpBP >= 50 || rugData?.lpBurned === true;
    // Surface lpLocked from RugCheck instead of hard-wiring false. The
    // response was previously claiming "LP not locked" even when
    // RugCheck reported a real lock — which read like a contradiction
    // when the verdict surfaced LP-locked bonuses elsewhere.
    const lpLocked = rugData?.lpLocked === true;
    const goPlusClean = l3.available && l3.trust >= 0.95 && !l3.forceRug;
    const tokenAgeHours = solscanTokenAgeHours ?? dexTokenAgeHours ?? null;

    // ─── LP fail-closed safety net ────────────────────────────────────
    // When neither RugCheck nor GoPlus can confirm LP is burned or
    // locked AND no layer has emitted an LP-related flag, force the
    // safe gate closed. Without this, brand-new tokens (low holders,
    // RugCheck has no record yet, GoPlus rate-limited) slip through
    // with SAFE verdicts despite the front-end correctly showing
    // "LP LOCK ✗" — exactly the user-reported HORNY/MAGA case.
    //
    // Maturity gate is intentionally LENIENT here (OR'd, not AND'd
    // like in the layer-level checks) because this branch only runs
    // when we have NO source-level LP signal. Failing CAUTION on a
    // mature-looking token whose API metadata happens to be missing
    // (e.g. age unknown when Solscan is degraded) is far worse for
    // the user than failing DANGER on a clean-but-tiny token. We
    // reserve hard 'lp' for tokens that score "young AND small AND
    // unknown-age" on every available signal.
    if (!lpBurned && !lpLocked) {
      const anyLpFlag = allLayers.some(l =>
        l.flags.some(f => /\bLP\b|liquidity (?:not|is)|dev can rug|unverified LP|holds .+% of supply|rug (?:capacity|exposure|risk|impact)/i.test(f.label))
      );
      if (!anyLpFlag) {
        // Fail-closed safety net: when neither RugCheck nor GoPlus emitted
        // an LP flag (typically because both upstreams returned null lpBurned
        // and lpLocked — blue chips often hit this because RugCheck is
        // patchy on long-established mints), we still need to surface SOME
        // LP signal so the user sees the unverified status.
        //
        // SCORING_VERSION 7.6.0+: this path now ALSO uses the 2-axis LP
        // risk matrix (api/_lib/lp-risk-matrix.ts) — same logic as the
        // layer-level paths — so blue chips with tiny LP % land in the
        // info bucket (no safeBlock) instead of being capped at CAUTION
        // by the old `looksMature` binary. This was the root cause of
        // BONK / WIF still showing CAUTION after the layer-level matrix
        // shipped: the safety net was running with the legacy code path
        // because the layer never emitted an LP flag in the first place.
        const bucket = getLpRiskBucket(_lpPctOfSupply, tokenAgeHours);
        postLayerFlags.push(makeFlag(bucket.flagLabel, bucket.severity, 0));
        if (bucket.safeBlock) {
          safeBlocked = true;
          // Critical buckets classify as hard 'lp'; soft buckets as 'lp_unverified'
          // (back-compat with classifySafeBlockedReasons regex order).
          const reason = bucket.severity === "critical" ? "lp" : "lp_unverified";
          if (!safeBlockedReasons.includes(reason)) safeBlockedReasons.push(reason);
        }
        if (bucket.forceRug) {
          forceRug = true;
        }
      }
    }
    const sourcesAvailableCount = allLayers
      .filter(l => l.available && l.source !== "crossvalidation")
      .length;

    const newSafeBlocked = applySafeGateOverride({
      safeBlocked, safeBlockedReasons, forceRug,
      holders, lpBurned, goPlusClean,
      tokenAgeHours, sourcesAvailableCount,
      mint: resolvedMint,
    });
    if (newSafeBlocked !== safeBlocked) {
      logger.info("scan", "safe gate override", { requestId, ca: resolvedMint, reasons: safeBlockedReasons });
    }
    safeBlocked = newSafeBlocked;

    // Reason-aware score clipping. Splitting hard from soft reasons
    // here is what lets a mature token with only `lp_unverified` /
    // `holders` reasons land on CAUTION (≥700) instead of being
    // forced to DANGER (<700) by a blanket cap at 500.
    //   forceRug          → 100 (RUG)
    //   hard reason       → 500 (DANGER)
    //   soft reason only  → 850 (high CAUTION ceiling, lets the
    //                       layer geometric mean express how good
    //                       the rest of the profile actually is)
    if (forceRug) {
      score = Math.min(score, 100);
    } else if (safeBlocked) {
      const hasHardReasonForClip = safeBlockedReasons.some(r => HARD_BLOCK_REASONS.has(r));
      score = Math.min(score, hasHardReasonForClip ? 500 : 850);
    }

    const newScore = applyEstablishedBonus({ score, tokenAgeHours, holders, lpBurned, goPlusClean });
    if (newScore !== score) {
      logger.info("scan", "established bonus applied", { requestId, ca: resolvedMint, score: newScore });
    }
    score = newScore;

    const sources_used: string[] = allLayers
      .filter(l => l.available && l.source !== "crossvalidation")
      .map(l => l.source);

    const _allFlagsForVerdict: ScanFlag[] = allLayers.flatMap(l => l.flags).concat(postLayerFlags);
    // Count token-side warning/critical flags so determineVerdict can apply
    // the "clean blue-chip" path when literally zero issues are visible.
    // Match the same filter the overlay uses (components.ts:721) — bonus +
    // info excluded — so the "No issues found" UX state lines up with the
    // verdict logic. Was the root cause of BONK/WIF showing "No issues found
    // / CAUTION" simultaneously after the LP matrix shipped.
    // Pipeline-status flags excluded too so the clean-blue-chip SAFE
    // path triggers consistently with what the user sees in the panel
    // (which now also drops them). Otherwise a Helius blip would silently
    // block SAFE without showing any reason in the UI.
    const _PIPELINE_STATUS = /^(Helius|GoPlus|RugCheck|Solscan|DexScreener|Birdeye|Helius RPC) (unavailable|rate[- ]limited|timed out|degraded)\b|Holder data unreliable|broken upstream/i;
    // Pump-only flags are informational market signals, not structural rug risks.
    // They must remain visible to the user but must never count toward the
    // 3-warnings → forced-DANGER threshold in determineVerdict.
    const _PUMP_PRICE_ONLY = /Pumped \+[\d,]+% (in 24h|over \d+ days)|Large 24h pump|Extreme pump .* on newborn token|Vertical pump detected|Extreme (24h )?pump \+[\d,]+%( in 1h)? — high retrace risk/i;
    const _tokenFlags = _allFlagsForVerdict.filter(
      (f) =>
        (f.severity === "warning" || f.severity === "critical") &&
        !_PIPELINE_STATUS.test(f.label) &&
        !_PUMP_PRICE_ONLY.test(f.label),
    );
    const _warningFlagsCount = _tokenFlags.length;
    const _criticalFlagsCount = _tokenFlags.filter(f => f.severity === "critical").length;
    // Pump-only flags are left out of the counts above (so a pump alone never reaches the 3-warnings floor) but they are
    // visible: they must keep the token out of SAFE. Without this they were invisible to the "zero visible warnings -> SAFE" grants.
    const _pumpPriceOnlyFlagsCount = _allFlagsForVerdict.filter(
      (f) => (f.severity === "warning" || f.severity === "critical") && _PUMP_PRICE_ONLY.test(f.label),
    ).length;

    const risk: Verdict = determineVerdict({
      score, forceRug, safeBlocked, safeBlockedReasons,
      sourcesUsedCount: sources_used.length,
      warningFlagsCount: _warningFlagsCount,
      criticalFlagsCount: _criticalFlagsCount,
      pumpPriceOnlyFlagsCount: _pumpPriceOnlyFlagsCount,
    });

    // ── Flag deduplication ────────────────────────────────────────────────────
    // Multiple layers can fire semantically identical flags for the same signal
    // (e.g. layerDexScreener AND layerChart both flag "pump +553%"). We keep
    // only one flag per distinct risk signal, preferring the most severe.
    //
    // Two passes:
    //  1. Exact label → keep the occurrence with the highest severity.
    //  2. Pump-percentage → if two flags both mention "pump" and share the same
    //     rounded percentage (±0 tolerance), keep only the most severe.
    //     Catches "Large 24h pump +553% on token <24h" vs
    //     "Pumped +553% in 24h — exit liquidity risk on thin LP".
    const _severityRank: Record<string, number> = { critical:0, warning:1, info:2, bonus:3 };
    const _dedupe = (input: ScanFlag[]): ScanFlag[] => {
      // Pass 1: exact label
      const byLabel = new Map<string, ScanFlag>();
      for (const f of input) {
        const existing = byLabel.get(f.label);
        if (!existing || _severityRank[f.severity] < _severityRank[existing.severity]) {
          byLabel.set(f.label, f);
        }
      }
      const pass1 = [...byLabel.values()];

      // Pass 2: pump-percentage — extract the first integer % from pump flags
      // and group by it, keeping the most severe representative.
      const pumpPctMap = new Map<number, ScanFlag>();
      const nonPump: ScanFlag[] = [];
      for (const f of pass1) {
        if (!/pump|pumped/i.test(f.label)) { nonPump.push(f); continue; }
        const m = f.label.match(/\+(\d+)%/);
        if (!m) { nonPump.push(f); continue; }
        const pct = parseInt(m[1], 10);
        const existing = pumpPctMap.get(pct);
        if (!existing || _severityRank[f.severity] < _severityRank[existing.severity]) {
          pumpPctMap.set(pct, f);
        }
      }
      return [...nonPump, ...pumpPctMap.values()];
    };
    const flags: ScanFlag[] = _dedupe(_allFlagsForVerdict);
    const severityOrder: Record<Severity, number> = { critical:0, warning:1, info:2, bonus:3 };
    flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const confidence = Math.round(sources_used.reduce((sum, src) => sum + (LAYER_WEIGHTS[src] ?? 0), 0) * 100);
    const layersSnapshot: Record<string, LayerSnapshot> = Object.fromEntries(
      allLayers.map(l => [l.source, { trust: +l.trust.toFixed(3), available: l.available }])
    );

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
    // Compose the 3 hero cards (Dev / Insider / Cluster). The cluster
    // detection requires `buildInsiderGraph` which makes Helius RPC
    // calls — guarded by withBudget so a tight scan budget skips
    // gracefully and we still emit Dev + Insider cards. Subsequent
    // scans benefit from the graph cache (INSIDER_GRAPH_CACHE_TTL).
    const insiderGraphResult = (HELIUS_API_KEY && realHolderAccounts.length >= 3 && totalSupplyUi > 0)
      ? await stepBudget(() =>
          buildInsiderGraph(
            resolvedMint,
            realHolderAccounts.map(h => ({ address: h.owner, uiAmount: h.uiAmount })),
            totalSupplyUi,
            HELIUS_API_KEY,
            new Set(LP_PROGRAM_ADDRESSES),
          ),
        ).catch(() => null)
      : null;
    const criticalActors = composeCriticalActors({
      tokenCreator,
      creatorReputation,
      realHolderAccounts,
      totalSupplyUi,
      insiderGraph: insiderGraphResult,
    });

    // ─── V5 Holder Activity ───────────────────────────────────────────
    // Derived in-process from recentTransfers (Solscan, last ~50 txs)
    // and the top realHolderAccounts. No extra RPC calls.
    const holderActivity = composeHolderActivity({
      realHolderAccounts,
      tokenCreator,
      totalSupplyUi,
      recentTransfers,
      insiderGraph: insiderGraphResult,
    });

    // ─── V5 Outcome Stats (TTR ring + Outcome Histogram) ──────────────
    // Heuristic profile-match v1: pick fast-rug / high-risk / slow-death
    // distribution from current verdict + age + concentration + vol/liq.
    // The corpus-backed KNN matcher (J3-J5 backtest harness) replaces
    // pickProfile in a follow-up; the response shape is stable.
    const outcomeStats = composeOutcomeStats({
      risk,
      tokenAgeHours: solscanTokenAgeHours ?? dexTokenAgeHours ?? null,
      top10HolderPct,
      liquidity,
      volume24h,
      flags,
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

    const result: ScanResult = {
      score, risk, flags, pair, resolvedMint, confidence, sources_used,
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
      lpLockedPct: _gpBP > 0 ? Math.round(_gpBP * 100) / 100 : null,
      candles: candles.slice(-20).map(c => ({ close: c.c })),
      topHolderPct,
      top10HolderPct,
      criticalActors,
      verdictHistory: finalHistory,
      holderActivity,
      outcomeStats,
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
    const degraded = sources_used.length === 0 || scanDeadline - Date.now() < MIN_STEP_MS;
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
    if (!isPreviewDeployment()) void recordRug({ mint: resolvedMint, symbol: sanitizeString(pair?.baseToken?.symbol) ?? null, score, risk, flags, creator: tokenCreator });

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
      scoringVersion: SCORING_VERSION,
    });

    if (installId) {
      void pushScanHistory(installId, {
        ca: result.resolvedMint ?? ca,
        score: result.score,
        verdict: result.risk,
        scannedAt: Date.now(),
        symbol: result.tokenSymbol ?? undefined,
        name: result.tokenName ?? undefined,
      });
    }

    return res.json(result);
  } catch (e) {
    logger.error("scan", "analysis error", { requestId, version: SCORING_VERSION, error: String(e) });
    captureError(e, { endpoint: "scan", requestId, ca });
    return apiError(res, 500, "Analysis error.");
  }
}
