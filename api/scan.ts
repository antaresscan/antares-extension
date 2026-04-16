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
  settled, apiError,
  isValidDexScreenerResponse, isValidRugCheckSummary,
  isHeliusLargestAccountsResponse, isHeliusSupplyResponse,
  isSolscanMarketsResponse, isSolscanMeta, isSolscanTransfersResponse,
  isRugCheckReport,
  sanitizeString, sanitizeUrl,
} from "./_lib/helpers";
import {
  heliusGetLargestAccounts, heliusGetTokenSupply, heliusGetCreatorReputation,
  heliusGetHoldersCount,
  heliusResolveAccountOwners,
  solscanGetHoldersCount, fetchSolscan, fetchDexCandles,
  type CreatorReputation,
} from "./_lib/fetchers";
import {
  DEXSCREENER_BASE, RUGCHECK_BASE, GOPLUS_BASE, LAYER_WEIGHTS, SCORING_VERSION,
} from "./_lib/constants";
import {
  layerDexScreener, layerRugCheck, layerGoPlus, layerHelius,
  layerSolscan, layerChart, layerCrossValidation,
} from "./_lib/layers";
import { computeFinalScore, classifySafeBlockedReasons } from "./_lib/scoring";
import { evaluatePostLayerFlags, applySafeGateOverride, applyEstablishedBonus, determineVerdict } from "./_lib/pipeline";
import { setCorsHeaders, getClientIp, checkRateLimit, validateCA, initRateLimiters } from "./_lib/middleware";
import { initCache, getCachedResult, setCachedResult, getCacheRedis } from "./_lib/cache";
import * as Sentry from "@sentry/node";
import { generateAISummary } from "./_lib/ai-summary";

import { initRugDb, recordRug } from "./_lib/rugdb";
import { logger } from "./_lib/logger";
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
}

const GLOBAL_TIMEOUT_MS = Number(process.env.VERCEL_TIMEOUT) || 9000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    return apiError(res, 405, "Method not allowed.");
  }

  const ip = getClientIp(req);
  const rateLimitOk = await checkRateLimit(res, ip);
  if (!rateLimitOk) return;

  const ca = validateCA(req.query.ca);
  if (!ca) return apiError(res, 400, "Invalid token address.");

  // Only serve cache when aiSummary is present — avoids serving stale null-summary results
  const cached = await getCachedResult<ScanResult>(ca, requestId);
  if (cached && cached.aiSummary) return res.json(cached);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Global timeout")), GLOBAL_TIMEOUT_MS)
  );

  try {
    const result = await Promise.race([runAnalysis(req, res, requestId, ca), timeoutPromise]);
    return result;
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "Global timeout") {
      return apiError(res, 504, "Analysis timed out. Try again.");
    }
    Sentry.captureException(e); return apiError(res, 500, "Unexpected error.");
  }
}

async function runAnalysis(req: VercelRequest, res: VercelResponse, requestId: string, ca: string) {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

  try {
    const [dexRes, rugRes, rugReportRes] = await Promise.all([
      settled(fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`, {}, 5000)),
      settled(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`, {}, 5000)),
      settled(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report`, {}, 8000)),
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
      const pairDataRaw = await settled(fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`, {}, 5000));
      const pairData = isValidDexScreenerResponse(pairDataRaw) ? pairDataRaw : null;
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint = resolvedPair?.baseToken?.address;
      if (resolvedPair) pair = pair ?? resolvedPair;
      if (baseMint && baseMint !== ca) {
        resolvedMint = baseMint;
        const [dexRetry, rugRetry] = await Promise.all([
          settled(fetchJson(`${DEXSCREENER_BASE}/tokens/${resolvedMint}`, {}, 5000)),
          settled(fetchJson(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`, {}, 5000)),
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

    if (resolvedMint !== ca) {
      const cachedByMint = await getCachedResult<ScanResult>(resolvedMint, requestId);
      if (cachedByMint && cachedByMint.aiSummary) return res.json(cachedByMint);
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
      heliusHoldersRaw, heliusSupplyRaw,
      solscanHoldersCount,
      solMeta, solTransfers, solMarkets,
    ] = await Promise.all([
      settled(fetchDexCandles(pairAddress)),
      settled(fetchJson(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${resolvedMint}`, {}, 4000)),
      HELIUS_API_KEY ? settled(heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY)) : null,
      HELIUS_API_KEY ? settled(heliusGetTokenSupply(resolvedMint, HELIUS_API_KEY)) : null,
      settled(solscanGetHoldersCount(resolvedMint)),
      settled(fetchSolscan(`/token/meta?address=${resolvedMint}`)),
      settled(fetchSolscan(`/token/transfer?address=${resolvedMint}&page=1&page_size=10`)),
      settled(fetchSolscan(`/token/markets?address=${resolvedMint}&page=1&page_size=1`)),
    ]);

    const candles: OHLCVCandle[] = Array.isArray(candlesRaw) ? candlesRaw : [];
    const goplus = pickGoPlusResult(goplusRaw, resolvedMint);
    const heliusResponse = isHeliusLargestAccountsResponse(heliusHoldersRaw) ? heliusHoldersRaw : null;
    const rawHolderAccounts: HeliusHolder[] = heliusResponse?.result?.value ?? [];
    const supplyResponse = isHeliusSupplyResponse(heliusSupplyRaw) ? heliusSupplyRaw : null;
    const totalSupplyUi: number = asNumber(supplyResponse?.result?.value?.uiAmount);

    const solMarketsData = isSolscanMarketsResponse(solMarkets) ? solMarkets : null;
    const resolvedHolderAccounts: HeliusHolder[] = HELIUS_API_KEY && rawHolderAccounts.length > 0
      ? await settled(heliusResolveAccountOwners(rawHolderAccounts, HELIUS_API_KEY)) ?? rawHolderAccounts.map(h => ({ ...h, owner: h.owner ?? h.address }))
      : rawHolderAccounts.map(h => ({ ...h, owner: h.owner ?? h.address }));
    const solMarketPool: SolscanMarketPool | null =
      Array.isArray(solMarketsData?.data) && solMarketsData!.data!.length > 0
      ? [...solMarketsData!.data!].sort((a: SolscanMarketPool, b: SolscanMarketPool) => asNumber(b.liquidity) - asNumber(a.liquidity))[0]
      : null;
    const solMetaData = isSolscanMeta(solMeta) ? solMeta : null;
    const solscanCreatedTime: number | null = solMetaData?.data?.created_time ?? null;
    const solscanTokenAgeHours: number | null =
      solscanCreatedTime !== null
      ? Math.floor((Date.now() / 1000 - solscanCreatedTime) / 3600)
      : pair?.pairCreatedAt
      ? Math.floor((Date.now() - pair.pairCreatedAt) / 3_600_000)
      : null;
    const dexTokenAgeHours: number | null = pair?.pairCreatedAt
      ? Math.floor((Date.now() - pair.pairCreatedAt) / 3_600_000)
      : null;
    const solscanVolume24h: number | null  = asNumber(solMarketPool?.volume)    || asNumber(pair?.volume?.h24) || null;
    const solscanTrades24h: number | null  = asNumber(solMarketPool?.trade)     || null;
    const solscanTraders24h: number | null = asNumber(solMarketPool?.trader)    || null;
    const solscanLiquidity: number | null  = asNumber(solMarketPool?.liquidity) || null;
    const tokenLogo    = solMetaData?.data?.icon || pair?.info?.imageUrl || null;
    const tokenCreator = solMetaData?.data?.creator || null;

    const creatorReputation: CreatorReputation | null = tokenCreator && HELIUS_API_KEY
      ? await settled(heliusGetCreatorReputation(tokenCreator, HELIUS_API_KEY))
      : null;

    const tokenDecimals = solMetaData?.data?.decimals ?? null;
    const tokenSupply   = solMetaData?.data?.supply   ?? null;
    const solTransfersData = isSolscanTransfersResponse(solTransfers) ? solTransfers : null;
    const recentTransfers: SolscanTransfer[] = solTransfersData?.data || [];
    const rugReport = isRugCheckReport(rugReportRes) ? rugReportRes : null;
    const rugTotalHolders: number | null =
      typeof rugReport?.totalHolders === "number" && rugReport.totalHolders > 0
      ? rugReport.totalHolders : null;
    let holders: number | null = solscanHoldersCount ?? rugTotalHolders ?? null;
    if ((holders === null || holders === 0) && HELIUS_API_KEY) {
      try {
        const fallbackCount = await heliusGetHoldersCount(resolvedMint, HELIUS_API_KEY);
        if (fallbackCount !== null && fallbackCount > 0) holders = fallbackCount;
      } catch { /* silent fallback */ }
    }

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
    const l2 = layerRugCheck(rugData, rugReport, resolvedMint, tokenName, {
      holders: solscanHoldersCount ?? rugTotalHolders ?? null,
      liquidity: asNumber(pair?.liquidity?.usd),
      tokenAgeHours: solscanTokenAgeHours,
      mintAuthority: rugData?.mintAuthorityEnabled === true,
      freezeAuthority: rugData?.freezeAuthorityEnabled === true,
      honeypot: false,
    });
    const l3 = layerGoPlus(goplus);
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
    const lpBurned = rugData?.lpBurned === true;
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

    // Compute top holder percentage for AI context
    const topHolderPct: number | null = (() => {
      if (resolvedHolderAccounts.length === 0 || totalSupplyUi <= 0) return null;
      const topAmt = asNumber(resolvedHolderAccounts[0]?.uiAmount);
      return topAmt > 0 ? (topAmt / totalSupplyUi) * 100 : null;
    })();

    const aiSummary = await generateAISummary({
      score, risk,
      flags: flags.map(f => ({ label: f.label, severity: f.severity, impact: f.impact })),
      tokenSymbol: sanitizeString(pair?.baseToken?.symbol) ?? null,
      holders, marketCap, liquidity,
      lpBurned: rugData?.lpBurned === true,
      lpLocked: rugData?.lpLocked === true,
      mintAuthority: allLayers.some(l => l.flags.some(f => /mint authority/i.test(f.label) && f.severity === "critical")),
      freezeAuthority: allLayers.some(l => l.flags.some(f => /freeze authority/i.test(f.label) && f.severity === "critical")),
      honeypot: l3.available && l3.trust === 0 && l3.flags.some(f => /honeypot/i.test(f.label)),
      tokenAgeHours: solscanTokenAgeHours ?? dexTokenAgeHours ?? null,
      sourcesUsed: sources_used,
      topHolderPct,
      volume24h,
      priceChange1h,
    }).catch(() => null);

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
      lpBurned: rugData != null ? (rugData.lpBurned === true) : null,
      lpLocked: rugData != null ? (rugData.lpLocked === true) : null,
      lpLockedPct: null,
      lpLockDurationDays: typeof rugData?.lpLockDurationDays === "number" ? rugData.lpLockDurationDays : null,
      candles: candles.slice(-20).map(c => ({ close: c.c })),
      scoring_version: SCORING_VERSION,
      fetchedAt: Date.now(),
      requestId,
      aiSummary: aiSummary ?? null,
    };

    // Cache only if aiSummary was generated — otherwise keep TTL short (30s) so the
    // next request retries AI generation instead of serving a null-summary forever.
    if (result.aiSummary) {
      setCachedResult(ca, result, tokenAgeMinutes);
      if (resolvedMint !== ca) setCachedResult(resolvedMint, result, tokenAgeMinutes);
    } else {
      const redis = getCacheRedis();
      if (redis) {
        redis.setex(`antares:v2:${ca}`, 30, result).catch(() => {});
        if (resolvedMint !== ca) redis.setex(`antares:v2:${resolvedMint}`, 30, result).catch(() => {});
      }
    }

    void recordRug({ mint: resolvedMint, symbol: sanitizeString(pair?.baseToken?.symbol) ?? null, score, risk, flags, creator: tokenCreator });
    return res.json(result);
  } catch (e) {
    logger.error("scan", "analysis error", { requestId, version: SCORING_VERSION, error: String(e) });
    Sentry.captureException(e);
    return apiError(res, 500, "Analysis error.");
  }
}
