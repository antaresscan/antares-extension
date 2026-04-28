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
  heliusGetLargestAccounts, heliusGetTokenSupply, heliusGetCreatorReputation,
  heliusGetHoldersCount,
  heliusResolveAccountOwners,
  publicRpcGetLargestAccounts, publicRpcGetTokenSupply, publicRpcGetMintInfo,
  solscanGetHoldersCount, fetchSolscan, fetchDexCandles,
  type CreatorReputation,
} from "./_lib/fetchers";
import {
  DEXSCREENER_BASE, RUGCHECK_BASE, GOPLUS_BASE, LAYER_WEIGHTS, SCORING_VERSION,
  LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS,
} from "./_lib/constants";
import {
  layerDexScreener, layerRugCheck, layerGoPlus, layerHelius,
  layerSolscan, layerChart, layerCrossValidation,
} from "./_lib/layers";
import { computeFinalScore, classifySafeBlockedReasons } from "./_lib/scoring";
import { evaluatePostLayerFlags, applySafeGateOverride, applyEstablishedBonus, determineVerdict } from "./_lib/pipeline";
import { setCorsHeaders, getClientIp, getInstallId, checkRateLimit, validateCA, initRateLimiters } from "./_lib/middleware";
import { initCache, getCachedResult, setCachedResult, getCacheRedis } from "./_lib/cache";
import * as Sentry from "@sentry/node";
import { generateAISummary } from "./_lib/ai-summary";

import { initRugDb, recordRug } from "./_lib/rugdb";
import { logger } from "./_lib/logger";
import { composeCriticalActors } from "./_lib/critical-actors";
import { buildInsiderGraph, initGraphCache } from "./_lib/insider-graph";
import { initHistoryCache, pushVerdictHistory, getVerdictHistory, deriveEvent } from "./_lib/verdict-history";
import { composeHolderActivity } from "./_lib/holder-activity";
import { composeOutcomeStats } from "./_lib/outcome-stats";
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
}

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initCache(redis);
  initRateLimiters(redis);
  initRugDb(redis);
  initGraphCache(redis);
  initHistoryCache(redis);
}

const GLOBAL_TIMEOUT_MS = Number(process.env.VERCEL_TIMEOUT) || 9000;

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

  const ip = getClientIp(req);
  const installId = getInstallId(req);
  const rateLimitOk = await checkRateLimit(res, ip, installId);
  if (!rateLimitOk) return;

  const ca = validateCA(req.query.ca);
  if (!ca) return apiError(res, 400, "Invalid token address.");

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
    return res.json(cached);
  }

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Global timeout")), GLOBAL_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([runAnalysis(req, res, requestId, ca, startTime), timeoutPromise]);
    return result;
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "Global timeout") {
      return apiError(res, 504, "Analysis timed out. Try again.");
    }
    Sentry.captureException(e); return apiError(res, 500, "Unexpected error.");
  }
}

async function runAnalysis(req: VercelRequest, res: VercelResponse, requestId: string, ca: string, startTime: number = Date.now()) {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

  // Dynamic per-fetch budget: each external call is capped by the time
  // remaining until the scan deadline. Ensures one slow upstream can't make
  // the whole pipeline hit the global 9s timeout — scoring still runs with
  // whatever data came back in time.
  const scanDeadline = startTime + (GLOBAL_TIMEOUT_MS - 500);
  const remainingMs = () => Math.max(200, scanDeadline - Date.now());

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
        return res.json(cachedByMint);
      }
    }
    if (dexData?.pairs && dexData.pairs.length > 1) {
      pair = dexData.pairs.reduce((best: DexScreenerPair, p: DexScreenerPair) =>
        asNumber(p?.liquidity?.usd) > asNumber(best?.liquidity?.usd) ? p : best
      , dexData.pairs[0]);
    }

    const pairAddress = pair?.pairAddress ?? ca;
    const tokenAgeMinutes: number | null = pair?.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 60000 : null;

    const [
      candlesRaw, goplusRaw,
      heliusHoldersRaw, heliusSupplyRaw, heliusHoldersCountRaw,
      solscanHoldersCount,
      solMeta, solTransfers, solMarkets,
    ] = await Promise.all([
      withBudget(fetchDexCandles(pairAddress), remainingMs()),
      withBudget(fetchJson(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${resolvedMint}`, {}, 4000), remainingMs()),
      HELIUS_API_KEY ? withBudget(heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY), remainingMs()) : null,
      HELIUS_API_KEY ? withBudget(heliusGetTokenSupply(resolvedMint, HELIUS_API_KEY), remainingMs()) : null,
      HELIUS_API_KEY ? withBudget(heliusGetHoldersCount(resolvedMint, HELIUS_API_KEY), remainingMs()) : null,
      withBudget(solscanGetHoldersCount(resolvedMint), remainingMs()),
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
    const goplus = pickGoPlusResult(goplusRaw, resolvedMint);
    const heliusResponse = isHeliusLargestAccountsResponse(heliusHoldersRaw) ? heliusHoldersRaw : null;
    let rawHolderAccounts: HeliusHolder[] = heliusResponse?.result?.value ?? [];
    const supplyResponse = isHeliusSupplyResponse(heliusSupplyRaw) ? heliusSupplyRaw : null;
    let totalSupplyUi: number = asNumber(supplyResponse?.result?.value?.uiAmount);

    // Free public Solana RPC fallback for the two Helius RPC calls that
    // matter for holder concentration. Same JSON-RPC interface, same
    // response shape, no API key. Triggered when Helius is unset or
    // returned no usable data — gives a token-distribution signal even
    // for users running without a paid Helius tier.
    if (rawHolderAccounts.length === 0) {
      try {
        const fallback = await withBudget(publicRpcGetLargestAccounts(resolvedMint), remainingMs());
        const parsed = isHeliusLargestAccountsResponse(fallback) ? fallback : null;
        rawHolderAccounts = parsed?.result?.value ?? [];
      } catch { /* keep empty — section will gracefully degrade */ }
    }
    if (totalSupplyUi <= 0) {
      try {
        const fallback = await withBudget(publicRpcGetTokenSupply(resolvedMint), remainingMs());
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
        const mintInfo = await withBudget(publicRpcGetMintInfo(resolvedMint), remainingMs());
        if (mintInfo) totalSupplyUi = mintInfo.supplyUi;
      } catch { /* keep 0 — concentration calc will be null */ }
    }

    const solMarketsData = isSolscanMarketsResponse(solMarkets) ? solMarkets : null;
    const resolvedHolderAccounts: HeliusHolder[] = HELIUS_API_KEY && rawHolderAccounts.length > 0
      ? await withBudget(heliusResolveAccountOwners(rawHolderAccounts, HELIUS_API_KEY), remainingMs()) ?? rawHolderAccounts.map(h => ({ ...h, owner: h.owner ?? h.address }))
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
      ? await withBudget(heliusGetCreatorReputation(tokenCreator, HELIUS_API_KEY), remainingMs())
      : null;

    const tokenDecimals = solMetaData?.data?.decimals ?? null;
    const tokenSupply   = solMetaData?.data?.supply   ?? null;
    const solTransfersData = isSolscanTransfersResponse(solTransfers) ? solTransfers : null;
    const recentTransfers: SolscanTransfer[] = solTransfersData?.data || [];
    const rugReport = isRugCheckReport(rugReportRes) ? rugReportRes : null;
    const rugTotalHolders: number | null =
      typeof rugReport?.totalHolders === "number" && rugReport.totalHolders > 0
      ? rugReport.totalHolders : null;
    // Holders count: query all available sources and take the MAX. Single-
    // source failures often manifest as 0 / 1 / null (Solscan rate-limited
    // or mid-indexing, RugCheck stale, etc.); the previous behaviour took
    // the first non-null value, which meant a stale Solscan returning 1
    // would override Helius reporting 50,000. Always-call Helius is fine
    // because the fallback path was already paying that latency anyway.
    // Holders count: take MAX across every free source we have. GoPlus
    // exposes `holder_count` directly in the same payload we already
    // fetch for honeypot detection — they index this themselves and
    // their number matches DexScreener / Solscan. That made the
    // previous "1 holder" lie disappear on real tokens.
    const heliusHoldersCount: number | null = typeof heliusHoldersCountRaw === "number" && heliusHoldersCountRaw > 0
      ? heliusHoldersCountRaw : null;
    const top20NonZero = rawHolderAccounts.filter(h => asNumber(h?.uiAmount) > 0).length;
    const goplusHolderCount: number | null = (() => {
      const raw = goplus?.holder_count;
      if (raw == null) return null;
      const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const holderCandidates = [
      solscanHoldersCount,
      rugTotalHolders,
      heliusHoldersCount,
      goplusHolderCount,
      top20NonZero > 0 ? top20NonZero : null,
    ].filter((n): n is number => typeof n === "number" && n > 0);
    const holders: number | null = holderCandidates.length > 0 ? Math.max(...holderCandidates) : null;

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
    // Shared maturity context — both rugcheck and goplus need it now to
    // classify unburned-LP as soft (CAUTION) for established tokens
    // instead of hard (DANGER). Building it once here keeps the two
    // layer calls strictly in sync.
    const maturityCtx = {
      holders: solscanHoldersCount ?? rugTotalHolders ?? null,
      liquidity: asNumber(pair?.liquidity?.usd),
      tokenAgeHours: solscanTokenAgeHours,
      mintAuthority: rugData?.mintAuthorityEnabled === true,
      freezeAuthority: rugData?.freezeAuthorityEnabled === true,
      honeypot: false,
    };
    const l2 = layerRugCheck(rugData, rugReport, resolvedMint, tokenName, maturityCtx);
    const l3 = layerGoPlus(goplus, maturityCtx);
    const l4 = layerHelius(resolvedHolderAccounts, totalSupplyUi);
    const l5 = layerSolscan(solscanHoldersCount, solscanTokenAgeHours, solscanTrades24h, solscanTraders24h);
    const l6 = layerChart(candles, pair, tokenAgeMinutes);
    const l7 = layerCrossValidation(rugData, resolvedHolderAccounts, goplus, solscanTokenAgeHours, dexTokenAgeHours, totalSupplyUi);

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
    const _gpBP = (goplus?.dex && Array.isArray(goplus.dex) && goplus.dex.length > 0) ? Math.max(...goplus.dex.map((d: { burn_percent?: number }) => typeof d.burn_percent === "number" ? d.burn_percent : 0)) : 0; const lpBurned = _gpBP >= 50 || rugData?.lpBurned === true;
    // Surface lpLocked from RugCheck instead of hard-wiring false. The
    // response was previously claiming "LP not locked" even when
    // RugCheck reported a real lock — which read like a contradiction
    // when the verdict surfaced LP-locked bonuses elsewhere.
    const lpLocked = rugData?.lpLocked === true;

    // ─── LP fail-closed safety net ────────────────────────────────────
    // If neither RugCheck nor GoPlus can confirm LP is burned or
    // locked, AND no layer has emitted an LP-related flag, force the
    // safe gate closed. Without this, brand-new tokens (low holders,
    // RugCheck has no record yet) where GoPlus is also rate-limited
    // slip through with SAFE verdicts despite the front-end correctly
    // showing "LP LOCK ✗" — exactly the user-reported HORNY/MAGA case
    // (SAFE 931 with 20 holders, $48K liq, no LP data from any source).
    // Treat unverified LP as not-burned by default — fail-closed.
    if (!lpBurned && !lpLocked) {
      const anyLpFlag = allLayers.some(l =>
        l.flags.some(f => /\bLP\b|liquidity (?:not|is)|dev can rug/i.test(f.label))
      );
      if (!anyLpFlag) {
        postLayerFlags.push(makeFlag(
          "LP not burned or locked — dev can rug liquidity",
          "warning",
          0
        ));
        safeBlocked = true;
        if (!safeBlockedReasons.includes("lp")) safeBlockedReasons.push("lp");
      }
    }
    const goPlusClean = l3.available && l3.trust >= 0.95 && !l3.forceRug;
    const tokenAgeHours = solscanTokenAgeHours ?? dexTokenAgeHours ?? null;
    const sourcesAvailableCount = allLayers
      .filter(l => l.available && l.source !== "crossvalidation")
      .length;

    const newSafeBlocked = applySafeGateOverride({
      safeBlocked, safeBlockedReasons, forceRug,
      holders, lpBurned, goPlusClean,
      tokenAgeHours, sourcesAvailableCount,
    });
    if (newSafeBlocked !== safeBlocked) {
      logger.info("scan", "safe gate override", { requestId, ca: resolvedMint, reasons: safeBlockedReasons });
    }
    safeBlocked = newSafeBlocked;

    if (safeBlocked) score = Math.min(score, 500);
    if (forceRug) score = Math.min(score, 100);

    const newScore = applyEstablishedBonus({ score, tokenAgeHours, holders, lpBurned, goPlusClean });
    if (newScore !== score) {
      logger.info("scan", "established bonus applied", { requestId, ca: resolvedMint, score: newScore });
    }
    score = newScore;

    const sources_used: string[] = allLayers
      .filter(l => l.available && l.source !== "crossvalidation")
      .map(l => l.source);

    const risk: Verdict = determineVerdict({
      score, forceRug, safeBlocked, safeBlockedReasons, sourcesUsedCount: sources_used.length,
    });

    const flags: ScanFlag[] = allLayers.flatMap(l => l.flags).concat(postLayerFlags);
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
    const topHolderPct: number | null = (() => {
      if (realHolderAccounts.length === 0 || totalSupplyUi <= 0) return null;
      const topAmt = asNumber(realHolderAccounts[0]?.uiAmount);
      return topAmt > 0 ? (topAmt / totalSupplyUi) * 100 : null;
    })();
    const top10HolderPct: number | null = (() => {
      if (realHolderAccounts.length === 0 || totalSupplyUi <= 0) return null;
      const top10Sum = realHolderAccounts.slice(0, 10)
        .reduce((sum, h) => sum + asNumber(h?.uiAmount), 0);
      return top10Sum > 0 ? Math.min(100, (top10Sum / totalSupplyUi) * 100) : null;
    })();

    // ─── V5 Critical Actors preview ───────────────────────────────────
    // Compose the 3 hero cards (Dev / Insider / Cluster). The cluster
    // detection requires `buildInsiderGraph` which makes Helius RPC
    // calls — guarded by withBudget so a tight scan budget skips
    // gracefully and we still emit Dev + Insider cards. Subsequent
    // scans benefit from the graph cache (INSIDER_GRAPH_CACHE_TTL).
    const insiderGraphResult = (HELIUS_API_KEY && realHolderAccounts.length >= 3 && totalSupplyUi > 0)
      ? await withBudget(
          buildInsiderGraph(
            resolvedMint,
            realHolderAccounts.map(h => ({ address: h.owner, uiAmount: h.uiAmount })),
            totalSupplyUi,
            HELIUS_API_KEY,
            new Set(LP_PROGRAM_ADDRESSES),
          ),
          remainingMs(),
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
      mintAuthority: allLayers.some(l => l.flags.some(f => /mint authority/i.test(f.label) && f.severity === "critical")),
      freezeAuthority: allLayers.some(l => l.flags.some(f => /freeze authority/i.test(f.label) && f.severity === "critical")),
      honeypot: l3.available && l3.trust === 0 && l3.flags.some(f => /honeypot/i.test(f.label)),
      tokenAgeHours: solscanTokenAgeHours ?? dexTokenAgeHours ?? null,
      sourcesUsed: sources_used,
      topHolderPct,
      volume24h,
      priceChange1h,
    }).catch(() => null);

    // ─── V5 Verdict Timeline ──────────────────────────────────────────
    // Append the current scan to the per-token history ZSET (deduped on
    // tight refresh windows + identical verdict/score) and read back
    // the last N entries so the Timeline tab on the page can show real
    // verdict progression instead of a static mock.
    const currentEntry = {
      ts: Date.now(),
      verdict: risk,
      score,
      event: deriveEvent(risk, flags),
    };
    void pushVerdictHistory(resolvedMint, currentEntry);
    const verdictHistory = await getVerdictHistory(resolvedMint).catch(() => []);
    // First scan or Redis unavailable — synthesize a single "now" entry
    // so the timeline is never empty when the section is open.
    const finalHistory = verdictHistory.length > 0 ? verdictHistory : [currentEntry];

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
      honeypot: l3.available && l3.trust === 0 && l3.flags.some(f => /honeypot/i.test(f.label)),
      mintAuthority: allLayers.some(l => l.flags.some(f => /mint authority/i.test(f.label) && f.severity === "critical")),
      freezeAuthority: allLayers.some(l => l.flags.some(f => /freeze authority/i.test(f.label) && f.severity === "critical")),
      lpBurned,
      lpLocked,
      lpLockedPct: _gpBP > 0 ? _gpBP : null,
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
    if (result.aiSummary) {
      setCachedResult(ca, result, tokenAgeMinutes, result.risk);
      if (resolvedMint !== ca) setCachedResult(resolvedMint, result, tokenAgeMinutes, result.risk);
    } else {
      const redis = getCacheRedis();
      if (redis) {
        redis.setex(`antares:v4:${ca}`, 30, result).catch(() => {});
        if (resolvedMint !== ca) redis.setex(`antares:v4:${resolvedMint}`, 30, result).catch(() => {});
      }
    }

    void recordRug({ mint: resolvedMint, symbol: sanitizeString(pair?.baseToken?.symbol) ?? null, score, risk, flags, creator: tokenCreator });

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
      scoringVersion: SCORING_VERSION,
    });

    return res.json(result);
  } catch (e) {
    logger.error("scan", "analysis error", { requestId, version: SCORING_VERSION, error: String(e) });
    Sentry.captureException(e);
    return apiError(res, 500, "Analysis error.");
  }
}
