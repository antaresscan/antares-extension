import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const HELIUS_BASE = "https://mainnet.helius-rpc.com";
const SOLSCAN_BASE = "https://pro-api.solscan.io/v2.0"; // ← AJOUT

const CA_RE = /^[A-Za-z0-9]{32,44}$/;

// ─── RATE LIMIT ───────────────────────────────────────────────────────────────
let ratelimit: Ratelimit | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    analytics: false,
    prefix: "antares_rl",
  });
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Severity = "critical" | "warning" | "info" | "bonus";
type ScanFlag = { label: string; severity: Severity; impact: number };
type ChartResult = { flags: ScanFlag[]; penalty: number; forceRug: boolean; safeBlocked: boolean };

function setHeaders(res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
}

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 5000) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: t.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { t.clear(); }
}

async function fetchJsonPost(url: string, body: object, timeoutMs = 5000) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { t.clear(); }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null;
}

function asNumber(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function pickGoPlusResult(raw: any, ca: string) {
  if (!raw || !isObject(raw.result)) return null;
  return raw.result[ca] || raw.result[ca.toLowerCase()] || raw.result[ca.toUpperCase()] || null;
}

function getTop10Percentage(rugData: any): number {
  return asNumber(rugData?.topHolders?.top10Percentage);
}

function getTop1Percentage(rugData: any): number {
  return asNumber(rugData?.topHolders?.top1Percentage ?? rugData?.topHolders?.top1HolderPercentage);
}

function getLpLockDurationDays(rugData: any): number {
  const raw = rugData?.lpLockDurationDays ?? rugData?.lpLockDuration ?? rugData?.lockDurationDays ?? 0;
  return asNumber(raw);
}

function riskIncludes(rugData: any, matcher: RegExp): boolean {
  if (!Array.isArray(rugData?.risks)) return false;
  return rugData.risks.some((r: any) => matcher.test(String(r?.name || "")));
}

function makeFlag(label: string, severity: Severity, impact: number): ScanFlag {
  return { label, severity, impact };
}

// ─── CHART HELPERS ────────────────────────────────────────────────────────────
function _mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function _std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  return Math.sqrt(_mean(xs.map(x => (x - m) ** 2)));
}
function _pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / Math.abs(from)) * 100;
}

// ─── IDENTITY RISK ────────────────────────────────────────────────────────────
const KNOWN_BRANDS = [
  "TRUMP", "DOGE", "PEPE", "SHIB", "BONK", "WIF", "BRETT",
  "FLOKI", "MAGA", "BIDEN", "ELON", "SOLANA", "SOL", "BTC",
  "ETH", "SUI", "APT", "ARB", "OP", "MATIC", "AVAX",
];

function analyzeIdentity(symbol?: string | null, name?: string | null): ChartResult {
  const flags: ScanFlag[] = [];
  let penalty = 0, forceRug = false, safeBlocked = false;
  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nm  = String(name   || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/(?:2|V2|V3|OFFICIAL|REAL|OG|NEW|PLUS)$/.test(sym) || /(?:2|V2|V3|OFFICIAL|REAL|OG|NEW|PLUS)$/.test(nm)) {
    flags.push(makeFlag("Copycat branding detected (v2/official/real suffix)", "critical", 250));
    penalty += 250; safeBlocked = true;
  }
  for (const brand of KNOWN_BRANDS) {
    const symMatch = sym.startsWith(brand) || sym.endsWith(brand);
    if ((symMatch || nm.includes(brand)) && sym !== brand) {
      flags.push(makeFlag(`Brand imitation: ${brand}-style copycat token`, "critical", 250));
      penalty += 250; safeBlocked = true; break;
    }
  }
  return { flags, penalty, forceRug, safeBlocked };
}

// ─── CHART PATTERN RISK ───────────────────────────────────────────────────────
async function fetchDexCandles(
  pairAddress: string, chainId = "solana"
): Promise<Array<{ o: number; h: number; l: number; c: number; v: number; ts: number }>> {
  const url = `https://io.dexscreener.com/dex/chart/amm/v3/${chainId}/${pairAddress}?res=1&cb=1`;
  const raw = await fetchJson(url, {}, 5000);
  if (!raw || !Array.isArray(raw.bars)) return [];
  return raw.bars.map((b: any) => ({
    ts: asNumber(b.t), o: asNumber(b.o), h: asNumber(b.h),
    l: asNumber(b.l), c: asNumber(b.c), v: asNumber(b.v),
  }));
}

function analyzeChartPatterns(
  candles: Array<{ o: number; h: number; l: number; c: number; v: number; ts: number }>,
  pair: any, tokenAgeMinutes: number | null
): ChartResult {
  const flags: ScanFlag[] = [];
  let penalty = 0, forceRug = false, safeBlocked = false;
  if (!candles || candles.length < 8) return { flags, penalty, forceRug, safeBlocked };
  const recent = candles.slice(-40);
  const closes = recent.map(c => c.c);
  const volumes = recent.map(c => c.v);
  const greens = recent.filter(c => c.c > c.o).length;
  const greenRatio = greens / recent.length;
  const first = closes[0], last = closes[closes.length - 1];
  const peak = Math.max(...closes), trough = Math.min(...closes);
  const runUpPct = _pct(first, peak);
  const drawdownFromPeak = _pct(peak, last);
  const pullbackRange = peak > 0 ? ((peak - trough) / peak) * 100 : 0;
  const returns = closes.slice(1).map((c, i) => _pct(closes[i], c));
  const returnStd = _std(returns);
  const risingCount = closes.slice(1).filter((c, i) => c > closes[i]).length;
  const liquidity = asNumber(pair?.liquidity?.usd);
  const vol24h = asNumber(pair?.volume?.h24);
  const vol1h  = asNumber(pair?.volume?.h1);
  const pc5m   = asNumber(pair?.priceChange?.m5);
  const pc1h   = asNumber(pair?.priceChange?.h1);
  const pc24h  = asNumber(pair?.priceChange?.h24);
  const v24Liq = liquidity > 0 ? vol24h / liquidity : 0;
  const v1hLiq = liquidity > 0 ? vol1h  / liquidity : 0;
  if (greenRatio >= 0.82 && runUpPct >= 100 && pullbackRange <= 10) {
    flags.push(makeFlag("Crashcoin pattern: near-perfect parabolic chart", "critical", 200));
    penalty += 200; safeBlocked = true;
  }
  if (pc5m > 35 && pc1h > 120) {
    flags.push(makeFlag("Vertical pump detected (+35% 5m / +120% 1h)", "warning", 150));
    penalty += 150; safeBlocked = true;
  }
  if (v24Liq > 12 || v1hLiq > 4) {
    flags.push(makeFlag("Liquidity mirage: volume >> liquidity (wash suspect)", "warning", 130));
    penalty += 130; safeBlocked = true;
  }
  if (recent.length >= 10 && risingCount >= Math.floor(recent.length * 0.8) && returnStd < 3.5) {
    flags.push(makeFlag("Over-controlled chart: artificial stair-step", "warning", 110));
    penalty += 110; safeBlocked = true;
  }
  if (drawdownFromPeak < -55) {
    flags.push(makeFlag("Blow-off top: price collapsed >55% from peak", "critical", 230));
    penalty += 230; forceRug = true; safeBlocked = true;
  }
  if (tokenAgeMinutes !== null && tokenAgeMinutes < 90 && volumes.length >= 10) {
    const recentVol = volumes.slice(-5);
    const olderVol  = volumes.slice(-10, -5);
    if (olderVol.length && _mean(recentVol) < _mean(olderVol) * 0.45 && last >= peak * 0.88) {
      flags.push(makeFlag("Early volume exhaustion near highs", "warning", 110));
      penalty += 110; safeBlocked = true;
    }
  }
  if (_pct(first, last) > 300 && greenRatio > 0.78) {
    flags.push(makeFlag("Parabolic launch: high risk exit liquidity setup", "warning", 130));
    penalty += 130; safeBlocked = true;
  }
  if (pc24h < -60 && pc1h < -20) {
    flags.push(makeFlag("Active dump: -60% 24h + -20% 1h (slow rug suspected)", "critical", 200));
    penalty += 200; forceRug = true; safeBlocked = true;
  }
  return { flags, penalty, forceRug, safeBlocked };
}

// ─── HELIUS ───────────────────────────────────────────────────────────────────
async function heliusGetLargestAccounts(mint: string, apiKey: string) {
  return fetchJsonPost(`${HELIUS_BASE}/?api-key=${apiKey}`, {
    jsonrpc: "2.0", id: "holders", method: "getTokenLargestAccounts", params: [mint],
  });
}
async function heliusGetTokenSupply(mint: string, apiKey: string) {
  return fetchJsonPost(`${HELIUS_BASE}/?api-key=${apiKey}`, {
    jsonrpc: "2.0", id: "supply", method: "getTokenSupply", params: [mint],
  });
}

async function heliusGetHoldersCount(mint: string, apiKey: string): Promise<number | null> {
  const res = await fetchJsonPost(`${HELIUS_BASE}/?api-key=${apiKey}`, {
    jsonrpc: "2.0", id: "holders-count",
    method: "getTokenAccounts",
    params: { mint, limit: 1, page: 1 },
  }, 6000);
  const total = res?.result?.total ?? res?.total;
  return typeof total === "number" ? total : null;
}

async function fetchLivePrice(mint: string): Promise<number | null> {
  const d = await fetchJson(`${DEXSCREENER_BASE}/tokens/${mint}`, {}, 4000);
  const p = d?.pairs?.[0]?.priceUsd;
  const n = parseFloat(p);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── SOLSCAN ─────────────────────────────────────────────────────────────────
async function fetchSolscan(endpoint: string) {
  const key = process.env.SOLSCAN_API_KEY || "";
  if (!key) return null;
  return fetchJson(`${SOLSCAN_BASE}${endpoint}`, { headers: { token: key } }, 5000);
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req as any).socket?.remoteAddress ||
    "unknown";

  if (ratelimit) {
    const { success } = await ratelimit.limit(ip);
    if (!success) return res.status(429).json({ error: "Too many requests. Please slow down." });
  }

  const ca = req.query.ca as string | undefined;
  if (!ca || !CA_RE.test(ca)) return res.status(400).json({ error: "Invalid token address." });

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

  try {
    const [dexRes, rugRes] = await Promise.all([
      fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`),
      fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`),
    ]);

    let dexData = dexRes;
    let rugData = rugRes;
    let pair = dexData?.pairs?.[0] ?? null;
    let resolvedMint = ca;

    const rugMissing =
      !rugData ||
      rugData?.error === "not found" ||
      rugData?.message?.toLowerCase?.().includes("not found");

    if (!pair || !rugData || rugMissing) {
      const pairData = await fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`);
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint = resolvedPair?.baseToken?.address;
      if (resolvedPair) pair = pair ?? resolvedPair;
      if (baseMint && baseMint !== ca) {
        resolvedMint = baseMint;
        const [dexRetry, rugRetry] = await Promise.all([
          fetchJson(`${DEXSCREENER_BASE}/tokens/${resolvedMint}`),
          fetchJson(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`),
        ]);
        if (dexRetry?.pairs?.[0]) { dexData = dexRetry; pair = dexRetry.pairs[0]; }
        if (rugRetry) rugData = rugRetry;
      }
    }

    if (dexData?.pairs?.length > 1) {
      pair = dexData.pairs.reduce((best: any, p: any) =>
        asNumber(p?.liquidity?.usd) > asNumber(best?.liquidity?.usd) ? p : best
      , dexData.pairs[0]);
    }

    const pairAddress = pair?.pairAddress ?? ca;

    const [
      candlesRaw, goplusRaw,
      heliusHoldersRaw, heliusSupplyRaw, holdersCount,
      solMeta, solTransfers,
    ] = await Promise.all([
      fetchDexCandles(pairAddress),
      fetchJson(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${resolvedMint}`),
      HELIUS_API_KEY ? heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY) : Promise.resolve(null),
      HELIUS_API_KEY ? heliusGetTokenSupply(resolvedMint, HELIUS_API_KEY)    : Promise.resolve(null),
      HELIUS_API_KEY ? heliusGetHoldersCount(resolvedMint, HELIUS_API_KEY)   : Promise.resolve(null),
      fetchSolscan(`/token/meta?address=${resolvedMint}`),
      fetchSolscan(`/token/transfer?address=${resolvedMint}&page=1&page_size=10`),
    ]);

    const candles       = Array.isArray(candlesRaw) ? candlesRaw : [];
    const goplus        = pickGoPlusResult(goplusRaw, resolvedMint);
    const holderAccounts: Array<{ address: string; uiAmount: number }> =
      heliusHoldersRaw?.result?.value ?? [];
    const totalSupplyUi: number = asNumber(heliusSupplyRaw?.result?.value?.uiAmount);

    const holders: number | null = holdersCount ?? null;

    // ─── SOLSCAN DATA ──────────────────────────────────────────────────────────
    const tokenLogo     = solMeta?.data?.icon || pair?.info?.imageUrl || null;
    const tokenCreator  = solMeta?.data?.creator || null;
    const tokenDecimals = solMeta?.data?.decimals ?? null;
    const tokenSupply   = solMeta?.data?.supply ?? null;
    const recentTransfers = solTransfers?.data || [];

    const priceUsd: number | null = (() => {
      const raw = pair?.priceUsd;
      const n = parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    const marketCap: number | null = (() => {
      const mc  = asNumber(pair?.marketCap);
      const fdv = asNumber(pair?.fdv);
      if (totalSupplyUi > 0 && priceUsd && priceUsd > 0) {
        const computed = totalSupplyUi * priceUsd;
        if (mc > 0) return mc;
        if (computed > 0) return computed;
      }
      if (mc > 0)  return mc;
      if (fdv > 0) return fdv;
      return null;
    })();

    const liquidity      = asNumber(pair?.liquidity?.usd) || null;
    const volume24h      = asNumber(pair?.volume?.h24)     || null;
    const volume1h       = asNumber(pair?.volume?.h1)      || null;
    const priceChange5m  = pair?.priceChange?.m5  ?? null;
    const priceChange1h  = pair?.priceChange?.h1  ?? null;
    const priceChange24h = pair?.priceChange?.h24 ?? null;

    let tokenAgeMinutes: number | null = null;
    if (pair?.pairCreatedAt) tokenAgeMinutes = (Date.now() - pair.pairCreatedAt) / 60000;

    let score = 1000;
    const flags: ScanFlag[] = [];
    const sources_used: string[] = [];

    if (pair)                      sources_used.push("DexScreener");
    if (rugData)                   sources_used.push("RugCheck");
    if (goplus)                    sources_used.push("GoPlus");
    if (holderAccounts.length > 0) sources_used.push("Helius");
    if (solMeta?.data)             sources_used.push("Solscan"); // ← AJOUT

    const addPenalty = (label: string, severity: Severity, impact: number) => {
      score -= impact;
      flags.push(makeFlag(label, severity, impact));
    };
    const addBonus = (label: string, points: number) => {
      score += points;
      flags.push(makeFlag(label, "bonus", -points));
    };

    let forceRisk: "RUG" | null = null;
    let safeBlocked = false;

    const mintAuthorityEnabled =
      Boolean(rugData?.mintAuthorityEnabled) ||
      Boolean(goplus?.mint_authority && String(goplus.mint_authority).trim() !== "");
    const freezeAuthorityEnabled =
      Boolean(rugData?.freezeAuthorityEnabled) ||
      Boolean(goplus?.freeze_authority && String(goplus.freeze_authority).trim() !== "");

    if (mintAuthorityEnabled)   addPenalty("Mint Authority enabled", "critical", 300);
    if (freezeAuthorityEnabled) addPenalty("Freeze Authority enabled", "critical", 300);
    if (mintAuthorityEnabled && freezeAuthorityEnabled) {
      forceRisk = "RUG";
      flags.push(makeFlag("Override: Mint + Freeze authority both active", "critical", 0));
    }

    if (goplus) {
      if (goplus.is_honeypot === "1" || goplus.is_honeypot === 1 || goplus.is_honeypot === true) {
        addPenalty("GoPlus honeypot detected", "critical", 300); forceRisk = "RUG";
      }
      if (goplus.cannot_sell_all === "1")   { addPenalty("Cannot sell all", "critical", 300); forceRisk = "RUG"; }
      if (goplus.is_blacklisted === "1")      addPenalty("Blacklist capability detected", "critical", 300);
      if (goplus.transfer_pausable === "1")   addPenalty("Transfer pausable", "critical", 300);
      if (goplus.hidden_owner === "1")        addPenalty("Hidden owner detected", "critical", 300);
      if (goplus.is_proxy === "1" || goplus.is_proxy === 1 || goplus.is_proxy === true)
        addPenalty("Upgradeable/proxy contract", "critical", 300);
      if (asNumber(goplus.sell_tax) > 0.1)         addPenalty("Sell tax > 10%", "critical", 250);
      if (asNumber(goplus.buy_tax) > 0.1)          addPenalty("Buy tax > 10%", "critical", 250);
      if (asNumber(goplus.owner_percent) > 0.05)   addPenalty("Owner holds > 5%", "critical", 250);
      if (asNumber(goplus.creator_percent) > 0.05) addPenalty("Creator holds > 5%", "critical", 250);
      if (goplus.is_mintable === "1")              addPenalty("Token is mintable", "warning", 150);
      if (goplus.slippage_modifiable === "1")      addPenalty("Slippage/tax modifiable", "warning", 150);
      if (goplus.is_anti_whale_modifiable === "1") addPenalty("Anti-whale rules modifiable", "warning", 150);
      if (goplus.trading_cooldown === "1")         addPenalty("Trading cooldown enabled", "warning", 150);
      if (goplus.is_whitelisted === "1")           addPenalty("Whitelist system detected", "warning", 150);
    }

    if (rugData) {
      if (rugData.metaMutable === true) {
        addPenalty("Metadata mutable", "warning", 150);
      } else if (rugData.metaMutable !== false) {
        addPenalty("Metadata not immutable", "info", 50);
      }
      if (!rugData.lpBurned && !rugData.lpLocked) {
        addPenalty("LP not burned or locked", "warning", 200); safeBlocked = true;
      }
      const lockDurationDays = getLpLockDurationDays(rugData);
      if (rugData.lpLocked && lockDurationDays > 0 && lockDurationDays < 30)
        addPenalty("LP lock duration < 30 days", "warning", 150);
    }

    if (pair) {
      const liq = asNumber(pair?.liquidity?.usd);
      const vol = asNumber(pair?.volume?.h24);
      const pc24 = asNumber(pair?.priceChange?.h24);
      const pc1  = asNumber(pair?.priceChange?.h1);
      const pc5  = asNumber(pair?.priceChange?.m5);

      if (liq < 1000)       addPenalty("Very low liquidity", "critical", 200);
      else if (liq < 5000)  addPenalty("Low liquidity", "warning", 100);
      else if (liq < 20000) addPenalty("Liquidity < $20k", "info", 30);

      if (liq > 0 && vol / liq > 20) addPenalty("Wash trading suspected (vol/liq > 20)", "critical", 120);
      else if (liq > 0 && vol / liq > 5) addPenalty("High vol/liquidity ratio", "warning", 60);

      if (rugData?.lpBurned === true) addBonus("LP Burned ✓", 100);
      const lockDays = getLpLockDurationDays(rugData);
      if (rugData?.lpLocked === true && lockDays > 180) addBonus("LP Locked > 180 days ✓", 80);

      if (pc1 > 200 && pc5 > 50) addPenalty("Coordinated pump pattern", "warning", 100);
      if (pc24 < -80) addPenalty("Brutal dump 24h", "critical", 150);
    }

    if (rugData) {
      const top10 = getTop10Percentage(rugData);
      const top1  = getTop1Percentage(rugData);
      if (top10 > 70)      addPenalty("Top 10 holders > 70%", "critical", 150);
      else if (top10 > 50) addPenalty("Top 10 holders > 50%", "warning", 80);
      if (top1 > 20) addPenalty("Top 1 holder > 20%", "critical", 150);
      if (riskIncludes(rugData, /sniper/i))                 addPenalty("Sniper activity detected", "critical", 150);
      if (riskIncludes(rugData, /bundler|bundle/i))          addPenalty("Bundler detected", "critical", 200);
      if (riskIncludes(rugData, /rug/i))                     addPenalty("Rug pull history", "critical", 200);
      if (riskIncludes(rugData, /creator.*sell|dev.*sell/i)) addPenalty("Dev wallet sold tokens", "warning", 100);
    }

    if (holderAccounts.length > 0 && totalSupplyUi > 0) {
      const top1Amount = asNumber(holderAccounts[0]?.uiAmount);
      const top1Pct    = top1Amount / totalSupplyUi;
      if (top1Pct > 0.3)       { addPenalty(`Single wallet holds ${Math.round(top1Pct * 100)}% of supply`, "critical", 200); forceRisk = "RUG"; }
      else if (top1Pct > 0.2)    addPenalty(`Single wallet holds ${Math.round(top1Pct * 100)}% of supply`, "critical", 150);
      else if (top1Pct > 0.1)    addPenalty(`Single wallet holds ${Math.round(top1Pct * 100)}% of supply`, "warning", 80);

      const top10Amount = holderAccounts.slice(0, 10).reduce((s: number, h: any) => s + asNumber(h?.uiAmount), 0);
      const top10Pct    = top10Amount / totalSupplyUi;
      if (top10Pct > 0.8)      addPenalty(`Top 10 wallets hold ${Math.round(top10Pct * 100)}% of supply`, "critical", 150);
      else if (top10Pct > 0.6) addPenalty(`Top 10 wallets hold ${Math.round(top10Pct * 100)}% of supply`, "warning", 80);
      else if (top10Pct < 0.3) addBonus("Well distributed supply ✓", 50);
    }

    if (tokenAgeMinutes !== null) {
      if (tokenAgeMinutes < 1)       addPenalty("Freshly launched, extreme risk", "critical", 150);
      else if (tokenAgeMinutes < 5)  addPenalty("Token very new (< 5 min)", "warning", 80);
      else if (tokenAgeMinutes < 60) addPenalty("Token < 1 hour old", "info", 30);
    }

    if (pair) {
      const buys5m  = asNumber(pair?.txns?.m5?.buys);
      const sells5m = asNumber(pair?.txns?.m5?.sells);
      const txns5m  = buys5m + sells5m;
      const mc      = marketCap ?? 0;
      const socials  = pair?.info?.socials  || [];
      const websites = pair?.info?.websites || [];
      const hasTwitter  = Array.isArray(socials) && socials.some((s: any) => /twitter|x/i.test(String(s?.type || s?.url || "")));
      const hasTelegram = Array.isArray(socials) && socials.some((s: any) => /telegram/i.test(String(s?.type || s?.url || "")));
      const hasWebsite  = Array.isArray(websites) && websites.length > 0;
      if (!hasWebsite && !hasTwitter && !hasTelegram) addPenalty("No website / Twitter / Telegram", "warning", 80);
      if (txns5m < 5 && mc > 50000) addPenalty("Low 5m transactions vs market cap", "warning", 80);
      if (sells5m > 0 && buys5m > sells5m * 5) addPenalty("Buy/sell imbalance (coordinated pump)", "warning", 60);
    } else {
      addPenalty("Not indexed on DexScreener", "warning", 100);
    }

    const identity = analyzeIdentity(pair?.baseToken?.symbol, pair?.baseToken?.name);
    score -= identity.penalty;
    flags.push(...identity.flags);
    if (identity.forceRug) forceRisk = "RUG";
    if (identity.safeBlocked) safeBlocked = true;

    const chart = analyzeChartPatterns(candles, pair, tokenAgeMinutes);
    score -= chart.penalty;
    flags.push(...chart.flags);
    if (chart.forceRug) forceRisk = "RUG";
    if (chart.safeBlocked) safeBlocked = true;

    score = Math.max(0, Math.min(1000, score));

    let risk: "SAFE" | "CAUTION" | "DANGER" | "RUG";
    if (forceRisk === "RUG")              risk = "RUG";
    else if (safeBlocked && score >= 800) risk = "CAUTION";
    else if (score >= 800)                risk = "SAFE";
    else if (score >= 600)                risk = "CAUTION";
    else if (score >= 350)                risk = "DANGER";
    else                                  risk = "RUG";

    const confidence = Math.round((sources_used.length / 5) * 100); // 5 sources désormais

    flags.sort((a, b) => {
      const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, bonus: 3 };
      return order[a.severity] - order[b.severity];
    });

    return res.json({
      score,
      risk,
      flags,
      pair,
      resolvedMint,
      confidence,
      sources_used,
      holders,
      marketCap,
      priceUsd,
      liquidity,
      volume24h,
      volume1h,
      priceChange5m,
      priceChange1h,
      priceChange24h,
      tokenSymbol:      pair?.baseToken?.symbol ?? null,
      tokenName:        pair?.baseToken?.name   ?? null,
      pairCreatedAt:    pair?.pairCreatedAt     ?? null,
      safeBlocked,
      tokenLogo,        // ← AJOUT
      tokenCreator,     // ← AJOUT
      tokenDecimals,    // ← AJOUT
      tokenSupply,      // ← AJOUT
      recentTransfers,  // ← AJOUT
      scoring_version: "4.3",
      fetchedAt: Date.now(),
    });
  } catch (e) {
    console.error("[scan v4.3]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
