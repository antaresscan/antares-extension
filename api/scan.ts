import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type {
  ScanFlag, Verdict, Severity,
    DexScreenerPair,
    RugCheckReport,
  HeliusHolder, HeliusLargestAccountsResponse, HeliusSupplyResponse,
  SolscanTransfer, SolscanMeta, SolscanMarketPool, SolscanMarketsResponse, SolscanTransfersResponse,
  OHLCVCandle,
  ScanResult, LayerSnapshot,
} from "./types";
import { CA_RE } from "./constants";
import {
  fetchJson, asNumber, pickGoPlusResult,
  settled, computeCacheTTL, apiError, isCorsAllowed,
  isValidDexScreenerResponse, isValidRugCheckSummary,
} from "./helpers";
import {
  heliusGetLargestAccounts, heliusGetTokenSupply, heliusGetCreatorReputation,
  solscanGetHoldersCount, fetchSolscan, fetchDexCandles,
  type CreatorReputation,
} from "./fetchers";
import {
  DEXSCREENER_BASE, RUGCHECK_BASE, GOPLUS_BASE,
} from "./constants";
import {
  layerDexScreener, layerRugCheck, layerGoPlus, layerHelius,
  layerSolscan, layerChart, layerIdentity, layerCrossValidation,
} from "./layers";
import { computeFinalScore, classifySafeBlockedReasons } from "./scoring";
import { evaluatePostLayerFlags, applySafeGateOverride, applyEstablishedBonus, determineVerdict } from "./pipeline";
import * as Sentry from "@sentry/node";

// ─── SENTRY INITIALIZATION ──────────────────────────────────────────────────
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  });
}

// ─── RATE LIMIT & SCAN CACHE ──────────────────────────────────────────────────
let ratelimit: Ratelimit | null = null;
let burstRatelimit: Ratelimit | null = null;
let scanCacheRedis: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  scanCacheRedis = redis;
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    analytics: false,
    prefix: "antares_rl",
  });
  // [2.8] Burst rate limiting — 5 req/10s per IP
  burstRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "10 s"),
    analytics: false,
    prefix: "antares_burst",
  });
}

// ─── CORS WHITELIST ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "https://dexscreener.com", "https://birdeye.so", "https://pump.fun",
  "https://jup.ag", "https://raydium.io", "https://solscan.io",
  "https://www.geckoterminal.com", "https://antares-extension.vercel.app"
];

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestId = randomUUID();
  res.setHeader("X-Request-Id", requestId);

  const origin = (req.headers.origin as string) || "";
  const corsOk = isCorsAllowed(origin, ALLOWED_ORIGINS);
  if (corsOk) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "GET" && req.method !== "OPTIONS") {
    return apiError(res, 405, "Method not allowed.");
  }

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ||
    "unknown";

  if (ratelimit) {
    const { success, remaining } = await ratelimit.limit(ip);
    res.setHeader("X-RateLimit-Limit", "30");
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!success) return apiError(res, 429, "Too many requests. Please slow down.");
  }
  // [2.8] Burst rate limiting — 5 req/10s per IP
  if (burstRatelimit) {
    const { success } = await burstRatelimit.limit(ip);
    if (!success) {
      res.setHeader("Retry-After", "10");
      return apiError(res, 429, "Burst limit exceeded. Retry in 10 seconds.");
    }
  }

  const ca = (req.query.ca as string | undefined)?.trim();
  if (!ca || !CA_RE.test(ca)) return apiError(res, 400, "Invalid token address.");

  // [1.3] Adaptive Redis cache — serve cached result if within TTL
  const cacheKey = `antares:v2:${ca}`;
  if (scanCacheRedis) {
    try {
      const cached = await scanCacheRedis.get(cacheKey);
      if (cached) return res.json(cached);
    } catch (e: unknown) { console.warn("[antares] cache miss or Redis error", requestId, e); }
  }

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
      const pairDataRaw  = await settled(fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`, {}, 5000));
      const pairData     = isValidDexScreenerResponse(pairDataRaw) ? pairDataRaw : null;
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint     = resolvedPair?.baseToken?.address;
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
        // [1.6] Structured log on mint resolution failure
        console.warn(JSON.stringify({ requestId, ca, stage: "mint_resolution_failed" }));
      }
    }

    if (pair?.baseToken?.address) resolvedMint = pair.baseToken.address;
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
      settled(fetchDexCandles(pairAddress)),                                                          // GeckoTerminal 6s
      settled(fetchJson(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${resolvedMint}`, {}, 4000)), // GoPlus 4s
      HELIUS_API_KEY ? settled(heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY)) : null,        // Helius holders 6s
      HELIUS_API_KEY ? settled(heliusGetTokenSupply(resolvedMint, HELIUS_API_KEY))     : null,        // Helius supply 6s
      settled(solscanGetHoldersCount(resolvedMint)),                                                  // Solscan 5s
      settled(fetchSolscan(`/token/meta?address=${resolvedMint}`)),                                   // Solscan 5s
      settled(fetchSolscan(`/token/transfer?address=${resolvedMint}&page=1&page_size=10`)),           // Solscan 5s
      settled(fetchSolscan(`/token/markets?address=${resolvedMint}&page=1&page_size=1`)),             // Solscan 5s
        ]);

    const candles: OHLCVCandle[] = Array.isArray(candlesRaw) ? candlesRaw : [];
    const goplus = pickGoPlusResult(goplusRaw, resolvedMint);
    const heliusResponse = heliusHoldersRaw as HeliusLargestAccountsResponse | null;
    const rawHolderAccounts: HeliusHolder[] =
      heliusResponse?.result?.value ?? [];
    const supplyResponse = heliusSupplyRaw as HeliusSupplyResponse | null;
    const totalSupplyUi: number = asNumber(supplyResponse?.result?.value?.uiAmount);

    const solMarketsData = solMarkets as SolscanMarketsResponse | null;
    const solMarketPool: SolscanMarketPool | null =
      Array.isArray(solMarketsData?.data) && solMarketsData!.data!.length > 0
      ? [...solMarketsData!.data!].sort((a: SolscanMarketPool, b: SolscanMarketPool) => asNumber(b.liquidity) - asNumber(a.liquidity))[0]
      : null;
    const solMetaData = solMeta as SolscanMeta | null;
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
    const tokenLogo     = solMetaData?.data?.icon || pair?.info?.imageUrl || null;
    const tokenCreator  = solMetaData?.data?.creator || null;

    // [5.1] Creator reputation — fetch in parallel, non-blocking
    const creatorReputation: CreatorReputation | null = tokenCreator && HELIUS_API_KEY
      ? await settled(heliusGetCreatorReputation(tokenCreator, HELIUS_API_KEY))
      : null;

    const tokenDecimals = solMetaData?.data?.decimals ?? null;
    const tokenSupply   = solMetaData?.data?.supply   ?? null;
    const solTransfersData = solTransfers as SolscanTransfersResponse | null;
    const recentTransfers: SolscanTransfer[] = solTransfersData?.data || [];
    const rugReport = rugReportRes as RugCheckReport | null;
    const rugTotalHolders: number | null =
      typeof rugReport?.totalHolders === "number" && rugReport.totalHolders > 0
      ? rugReport.totalHolders : null;
    const holders: number | null = solscanHoldersCount ?? rugTotalHolders ?? null;

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

    const l1 = layerDexScreener(pair, marketCap, tokenAgeMinutes);
    const l2 = layerRugCheck(rugData, rugReport, resolvedMint);
    const l3 = layerGoPlus(goplus);
    const l4 = layerHelius(rawHolderAccounts, totalSupplyUi);
    const l5 = layerSolscan(solscanHoldersCount, solscanTokenAgeHours, solscanTrades24h, solscanTraders24h);
    const l6 = layerChart(candles, pair, tokenAgeMinutes);
    const l7 = layerIdentity(pair?.baseToken?.symbol, pair?.baseToken?.name, resolvedMint);
    const l8 = layerCrossValidation(rugData, rawHolderAccounts, goplus, solscanTokenAgeHours, dexTokenAgeHours);

    const allLayers = [l1, l2, l3, l4, l5, l6, l7, l8];
    let score         = computeFinalScore(allLayers);
    let forceRug      = allLayers.some(l => l.forceRug);
    let safeBlocked   = allLayers.some(l => l.safeBlocked);

    // [BLOCK E] Post-layer flags via pipeline
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

    // [BLOCK F] Safe gate override via pipeline
    const safeBlockedReasons = classifySafeBlockedReasons(allLayers);
    const lpBurned = rugData?.lpBurned === true;
    const goPlusClean = l3.available && l3.trust >= 0.95 && !l3.forceRug;

    const newSafeBlocked = applySafeGateOverride({
      safeBlocked, safeBlockedReasons, forceRug,
      holders, lpBurned, goPlusClean,
    });
    if (newSafeBlocked !== safeBlocked) {
      console.log(JSON.stringify({ requestId, ca: resolvedMint, stage: "safe_gate_override", reasons: safeBlockedReasons }));
    }
    safeBlocked = newSafeBlocked;

    // [BLOCK G] Established token bonus via pipeline
    const tokenAgeHours = solscanTokenAgeHours ?? dexTokenAgeHours ?? null;
    const newScore = applyEstablishedBonus({
      score, tokenAgeHours, holders, lpBurned, goPlusClean,
    });
    if (newScore !== score) {
      console.log(JSON.stringify({ requestId, ca: resolvedMint, stage: "established_bonus_applied", score: newScore }));
    }
    score = newScore;

    // [BLOCK H] Verdict via pipeline
    const sources_used: string[] = allLayers
      .filter(l => l.available && l.source !== "crossvalidation" && l.source !== "identity")
      .map(l => l.source);

    const risk: Verdict = determineVerdict({
      score, forceRug, safeBlocked, sourcesUsedCount: sources_used.length,
    });

    const flags: ScanFlag[] = allLayers.flatMap(l => l.flags).concat(postLayerFlags);
    const severityOrder: Record<Severity, number> = { critical:0, warning:1, info:2, bonus:3 };
    flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const confidence = Math.round((sources_used.length / 5) * 100);
    const layersSnapshot: Record<string, LayerSnapshot> = Object.fromEntries(
      allLayers.map(l => [l.source, { trust: +l.trust.toFixed(3), available: l.available }])
    );

    const result: ScanResult = {
      score, risk, flags, pair, resolvedMint, confidence, sources_used,
      holders, marketCap, priceUsd, liquidity,
      volume24h, volume1h, priceChange5m, priceChange1h, priceChange24h,
      tokenSymbol:   pair?.baseToken?.symbol ?? null,
      tokenName:     pair?.baseToken?.name   ?? null,
      pairCreatedAt: pair?.pairCreatedAt     ?? null,
      safeBlocked, safeBlockedReasons, tokenLogo, tokenCreator, tokenDecimals, tokenSupply, recentTransfers,
      solscanTokenAgeHours,
      solscanVolume24h,
      solscanTrades24h,
      solscanTraders24h,
      layers: layersSnapshot,
      scoring_version: "6.1.0",
      fetchedAt: Date.now(),
    };

    // [1.3] Adaptive Redis cache — write with TTL based on token age
    if (scanCacheRedis) {
      const ttl = computeCacheTTL(tokenAgeMinutes);
      scanCacheRedis.setex(cacheKey, ttl, JSON.stringify(result)).catch(() => {});
    }

    return res.json(result);
  } catch (e) {
    console.error("[scan v6.1.0]", requestId, e);
    Sentry.captureException(e);
    return apiError(res, 500, "Analysis error.");
  }
}
