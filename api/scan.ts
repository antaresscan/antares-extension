import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type {
  Severity, ScanFlag, SafeBlockedReason, LayerResult, Verdict,
  DexScreenerPair, DexScreenerResponse, DexScreenerSocial,
  RugCheckSummary, RugCheckReport, RugCheckRisk,
  GoPlusTokenResult, GoPlusResponse,
  HeliusHolder, HeliusLargestAccountsResponse, HeliusSupplyResponse, HeliusTokenAccountsResponse,
  SolscanTransfer, SolscanMeta, SolscanMarketPool, SolscanMarketsResponse, SolscanTransfersResponse,
  OHLCVCandle, GeckoTerminalOHLCVResponse,
  ScanResult, LayerSnapshot,
} from "./types";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE    = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE      = "https://api.gopluslabs.io/api/v1";
const HELIUS_BASE      = "https://mainnet.helius-rpc.com";
const SOLSCAN_PUBLIC_BASE = "https://public-api.solscan.io";
const SOLSCAN_BASE     = "https://pro-api.solscan.io/v2.0";

const CA_RE = /^[A-Za-z0-9]{32,44}$/;

// ─── CONSTANTES GLOBALES ──────────────────────────────────────────────────────
const LP_PROGRAM_ADDRESSES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAB",
]);

const FOUNDATION_WALLETS = new Set([
  "B9n3tgBJ8f1K2VXrF5aTBNXXmj5V8sKXrk3GV5uPump",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  "9yrPkpCTBCqJmSmTtkMZoxFWMkrAPEQK6DkfaESMpump",
]);

const OFFICIAL_MINTS = new Set([
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
]);

const KNOWN_BRANDS = [
  "TRUMP","DOGE","PEPE","SHIB","BONK","WIF","BRETT",
  "FLOKI","MAGA","BIDEN","ELON","SOLANA","SOL","BTC",
  "ETH","SUI","APT","ARB","OP","MATIC","AVAX",
];

const COPYCAT_SUFFIXES = ["2","V2","V3","OFFICIAL","REAL","NEW","PLUS","INU"];

const LAYER_WEIGHTS = {
  dexscreener: 0.20,
  rugcheck:    0.20,
  goplus:      0.25,
  helius:      0.20,
  solscan:     0.10,
  chart:       0.05,
};

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

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Types imported from ./types

// ─── UTILS ────────────────────────────────────────────────────────────────────
function setHeaders(res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
}
function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}
async function fetchJson(url: string, init: RequestInit = {}, ms = 5000) {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, { ...init, signal: t.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { t.clear(); }
}
async function fetchJsonPost(url: string, body: object, ms = 5000) {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { t.clear(); }
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}
function pickGoPlusResult(raw: unknown, ca: string): GoPlusTokenResult | null {
  if (!isObject(raw)) return null;
  const result = (raw as GoPlusResponse).result;
  if (!result || typeof result !== "object") return null;
  return result[ca] || result[ca.toLowerCase()] || result[ca.toUpperCase()] || null;
}
function makeFlag(label: string, severity: Severity, impact: number): ScanFlag {
  return { label, severity, impact };
}
function getLpLockDurationDays(rugData: RugCheckSummary): number {
  const raw = rugData?.lpLockDurationDays ?? rugData?.lpLockDuration ?? rugData?.lockDurationDays ?? 0;
  return asNumber(raw);
}
function riskIncludes(data: RugCheckSummary | RugCheckReport | null | undefined, matcher: RegExp): boolean {
  if (!data || !Array.isArray(data.risks)) return false;
  return data.risks.some((r: RugCheckRisk) => matcher.test(String(r?.name || "")));
}
function _mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
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

function settled<T>(p: Promise<T>): Promise<T | null> {
  return p.then(v => v).catch(() => null);
}

function computeCacheTTL(tokenAgeMinutes: number | null): number {
  if (tokenAgeMinutes === null) return 20;
  if (tokenAgeMinutes < 60) return 15;
  if (tokenAgeMinutes < 1440) return 30;
  return 120;
}

// ─── HELIUS HELPERS ───────────────────────────────────────────────────────────
async function heliusGetLargestAccounts(mint: string, key: string) {
  return fetchJsonPost(`${HELIUS_BASE}/?api-key=${key}`, {
    jsonrpc: "2.0", id: "holders", method: "getTokenLargestAccounts", params: [mint],
  }, 6000);
}
async function heliusGetTokenSupply(mint: string, key: string) {
  return fetchJsonPost(`${HELIUS_BASE}/?api-key=${key}`, {
    jsonrpc: "2.0", id: "supply", method: "getTokenSupply", params: [mint],
  }, 6000);
}
async function heliusGetHoldersCount(mint: string, key: string): Promise<number | null> {
  const res = await fetchJsonPost(`${HELIUS_BASE}/?api-key=${key}`, {
    jsonrpc: "2.0", id: "holders-count",
    method: "getTokenAccounts",
    params: { mint, limit: 1, page: 1 },
  }, 6000) as HeliusTokenAccountsResponse | null;
  const total = res?.result?.total ?? res?.total;
  return typeof total === "number" ? total : null;
}
async function solscanGetHoldersCount(mint: string): Promise<number | null> {
  const res = await fetchJson(
    `${SOLSCAN_PUBLIC_BASE}/token/holders?tokenAddress=${mint}&limit=1&offset=0`,
    { headers: { "User-Agent": "Antares/1.0" } }, 5000
  );
  const total = res?.total;
  return typeof total === "number" && total > 0 ? total : null;
}
async function fetchSolscan(endpoint: string) {
  const key = process.env.SOLSCAN_API_KEY || "";
  if (!key) return null;
  return fetchJson(`${SOLSCAN_BASE}${endpoint}`, { headers: { token: key } }, 5000);
}

// ─── P1 FIX — GeckoTerminal candles (remplace io.dexscreener.com bloqué Cloudflare) ───
async function fetchDexCandles(
  pairAddress: string, _chainId = "solana"
): Promise<OHLCVCandle[]> {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=5&limit=40`;
  const raw = await fetchJson(url, {
    headers: { "Accept": "application/json;version=20230302" }
  }, 6000) as GeckoTerminalOHLCVResponse | null;
  const ohlcv = raw?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) return [];
  // Format GeckoTerminal: [timestamp, open, high, low, close, volume]
  return ohlcv.map((b: number[]) => ({
    ts: asNumber(b[0]),
    o:  asNumber(b[1]),
    h:  asNumber(b[2]),
    l:  asNumber(b[3]),
    c:  asNumber(b[4]),
    v:  asNumber(b[5]),
  }));
}

// ─── BUNDLE DETECTION HELPER ─────────────────────────────────────────────────
function extractBundlePct(rugReportData: RugCheckReport | null): number {
  if (!rugReportData) return 0;
  const top1 = asNumber(
    rugReportData?.topHolders?.top1Percentage ??
    rugReportData?.topHolders?.top1HolderPercentage
  );
  if (Array.isArray(rugReportData?.risks)) {
    const bundleRisk = rugReportData.risks.find((r: RugCheckRisk) =>
      /bundle/i.test(String(r?.name || ""))
    );
    if (bundleRisk) {
      const scoreVal = asNumber(bundleRisk.score);
      if (top1 > 0) return top1 / 100;
      if (scoreVal >= 8000) return 0.40;
      if (scoreVal >= 5000) return 0.25;
      return 0.20;
    }
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — DexScreener
// ═══════════════════════════════════════════════════════════════════════════════
function layerDexScreener(
  pair: DexScreenerPair | null,
  marketCap: number | null,
  tokenAgeMinutes: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!pair) return {
    source: "dexscreener", trust: 1.0, available: false,
    flags: [makeFlag("Not indexed on DexScreener", "warning", 0)],
    forceRug: false, safeBlocked: false,
  };

  const liq  = asNumber(pair?.liquidity?.usd);
  const vol  = asNumber(pair?.volume?.h24);
  const pc24 = asNumber(pair?.priceChange?.h24);
  const pc1  = asNumber(pair?.priceChange?.h1);
  const pc6  = asNumber(pair?.priceChange?.h6);
  const pc5  = asNumber(pair?.priceChange?.m5);
  const buys5m  = asNumber(pair?.txns?.m5?.buys);
  const sells5m = asNumber(pair?.txns?.m5?.sells);
  const txns5m  = buys5m + sells5m;
  const mc = marketCap ?? 0;
  const socials  = pair?.info?.socials  || [];
  const websites = pair?.info?.websites || [];
  const hasTwitter  = Array.isArray(socials)  && socials.some((s: DexScreenerSocial)  => /twitter|x/i.test(String(s?.type || s?.url || "")));
  const hasTelegram = Array.isArray(socials)  && socials.some((s: DexScreenerSocial)  => /telegram/i.test(String(s?.type || s?.url || "")));
  const hasWebsite  = Array.isArray(websites) && websites.length > 0;
  const ageMinutes  = tokenAgeMinutes ?? Infinity;

  if (liq < 1000)       { flags.push(makeFlag("Very low liquidity (<$1k)",   "critical", 0)); trust *= 0.25; }
  else if (liq < 5000)  { flags.push(makeFlag("Low liquidity (<$5k)",         "warning",  0)); trust *= 0.65; }
  else if (liq < 20000) { flags.push(makeFlag("Liquidity < $20k",             "info",     0)); trust *= 0.90; }

  if (liq > 0 && vol / liq > 20) {
    flags.push(makeFlag("Wash trading detected (vol/liq > 20) — bundler dump", "critical", 0));
    trust *= 0.20; forceRug = true; safeBlocked = true;
  } else if (liq > 0 && vol / liq > 5) {
    flags.push(makeFlag("High vol/liquidity ratio", "warning", 0));
    trust *= 0.75;
  }

  const hasStructuralWeakness =
    (liq > 0 && vol / liq > 10) ||
    (txns5m > 30 && sells5m === 0) ||
    liq < 15000;

  if (ageMinutes < 30 && pc1 > 150) {
    if (hasStructuralWeakness) {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on <30min token + structural weakness — exit trap`, "critical", 0));
      trust *= 0.05; forceRug = true; safeBlocked = true;
    } else {
      flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% on newborn token (<30min)`, "warning", 0));
      trust *= 0.30; safeBlocked = true;
    }
  } else if (ageMinutes < 60 && pc1 > 120) {
    if (hasStructuralWeakness) {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on <1h token + structural weakness — exit trap`, "critical", 0));
      trust *= 0.05; forceRug = true; safeBlocked = true;
    } else {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<1h)`, "warning", 0));
      trust *= 0.40; safeBlocked = true;
    }
  } else if (pc1 > 300) {
    flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% in 1h — bundler exit trap`, "critical", 0));
    trust *= 0.05; forceRug = true; safeBlocked = true;
  } else if (pc1 > 200 && ageMinutes < 120) {
    flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<2h) — exit trap`, "critical", 0));
    trust *= 0.10; forceRug = true; safeBlocked = true;
  } else if (pc1 > 200 && pc5 > 50) {
    flags.push(makeFlag("Coordinated pump pattern", "warning", 0));
    trust *= 0.65;
  }

  if (pc6 < -50 && pc1 < -15) {
    flags.push(makeFlag("Slow rug detected: -50% on 6h + -15% on 1h", "critical", 0));
    trust *= 0.15; forceRug = true; safeBlocked = true;
  }

  if (!hasWebsite && !hasTwitter && !hasTelegram) { flags.push(makeFlag("No website / Twitter / Telegram", "warning", 0)); trust *= 0.80; }
  if (txns5m < 5 && mc > 50000) { flags.push(makeFlag("Low 5m transactions vs market cap", "warning", 0)); trust *= 0.88; }
  if (sells5m > 0 && buys5m > sells5m * 5) { flags.push(makeFlag("Buy/sell imbalance (coordinated pump)", "warning", 0)); trust *= 0.85; }
  if (pc24 < -80) { flags.push(makeFlag("Brutal dump 24h (-80%)", "critical", 0)); trust *= 0.35; }

  return { source: "dexscreener", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2 — RugCheck
// ═══════════════════════════════════════════════════════════════════════════════
function layerRugCheck(rugData: RugCheckSummary | null, rugReportData: RugCheckReport | null, resolvedMint: string): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!rugData) return {
    source: "rugcheck", trust: 1.0, available: false,
    flags: [makeFlag("RugCheck unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  const bundleInReport = riskIncludes(rugReportData, /bundle/i);
  const bundledPct = bundleInReport ? extractBundlePct(rugReportData) : 0;

  if (bundleInReport && bundledPct > 0.20) {
    flags.push(makeFlag(`Bundle holds ~${Math.round(bundledPct * 100)}% of supply — coordinated buy/dump`, "critical", 0));
    trust *= 0.05; forceRug = true; safeBlocked = true;
  } else if (bundleInReport && bundledPct > 0.05) {
    flags.push(makeFlag(`Bundle detected (~${Math.round(bundledPct * 100)}% of supply)`, "critical", 0));
    trust *= 0.20; safeBlocked = true;
  } else if (bundleInReport) {
    flags.push(makeFlag("Bundle activity detected (RugCheck)", "critical", 0));
    trust *= 0.20; forceRug = true; safeBlocked = true;
  }

  if (!bundleInReport && riskIncludes(rugData, /bundler|bundle/i)) {
    flags.push(makeFlag("Bundler detected (RugCheck summary)", "critical", 0));
    trust *= 0.15; forceRug = true; safeBlocked = true;
  }

  // ─── BUG A FIX — LP warning: only fire when RugCheck provides reliable LP data
  // and the mint is not a known official token.
  if (rugData.lpBurned === true) {
    flags.push(makeFlag("LP Burned ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.10);
  } else if (rugData.lpLocked === true) {
    const days = getLpLockDurationDays(rugData);
    if (days > 180) { flags.push(makeFlag("LP Locked > 180 days ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
    else if (days > 0 && days < 30) { flags.push(makeFlag("LP lock duration < 30 days", "warning", 0)); trust *= 0.75; }
  } else {
    // Only emit the LP warning if RugCheck explicitly returned LP fields
    // (lpBurned=false OR lpLocked=false) AND the mint is not an official token.
    const lpDataPresent =
      rugData.lpBurned === false ||
      rugData.lpLocked === false ||
      typeof rugData.lpLockDurationDays === "number" ||
      typeof rugData.lpLockDuration === "number" ||
      typeof rugData.lockDurationDays === "number";
    const isOfficialMint = OFFICIAL_MINTS.has(resolvedMint);

    if (lpDataPresent && !isOfficialMint) {
      flags.push(makeFlag("LP not burned or locked", "warning", 0));
      trust *= 0.70;
    }
  }

  if (rugData.metaMutable === true) { flags.push(makeFlag("Metadata mutable", "warning", 0)); trust *= 0.82; }
  else if (rugData.metaMutable !== false) { flags.push(makeFlag("Metadata not immutable", "info", 0)); trust *= 0.96; }

  const top10 = asNumber(rugData?.topHolders?.top10Percentage);
  const top1  = asNumber(rugData?.topHolders?.top1Percentage ?? rugData?.topHolders?.top1HolderPercentage);
  if (top10 > 70)      { flags.push(makeFlag("Top 10 holders > 70%", "critical", 0)); trust *= 0.45; }
  else if (top10 > 50) { flags.push(makeFlag("Top 10 holders > 50%", "warning",  0)); trust *= 0.70; }
  if (top1 > 20)       { flags.push(makeFlag("Top 1 holder > 20%",   "critical", 0)); trust *= 0.45; }

  if (riskIncludes(rugReportData, /sniper/i))                  { flags.push(makeFlag("Sniper activity detected",  "critical", 0)); trust *= 0.15; safeBlocked = true; }
  if (riskIncludes(rugReportData, /rug/i))                     { flags.push(makeFlag("Rug pull history",           "critical", 0)); trust *= 0.15; forceRug = true; }
  if (riskIncludes(rugReportData, /creator.*sell|dev.*sell/i)) { flags.push(makeFlag("Dev wallet sold tokens",    "warning",  0)); trust *= 0.65; }

  if (rugData.mintAuthorityEnabled)   { flags.push(makeFlag("Mint Authority enabled (RugCheck)",   "critical", 0)); trust *= 0.25; }
  if (rugData.freezeAuthorityEnabled) { flags.push(makeFlag("Freeze Authority enabled (RugCheck)", "critical", 0)); trust *= 0.25; }

  return { source: "rugcheck", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3 — GoPlus
// ═══════════════════════════════════════════════════════════════════════════════
function layerGoPlus(goplus: GoPlusTokenResult | null): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!goplus) return {
    source: "goplus", trust: 1.0, available: false,
    flags: [makeFlag("GoPlus unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  const gp = (field: keyof GoPlusTokenResult) => {
    const v = goplus[field];
    return v === "1" || v === 1 || v === true;
  };
  const gpNum = (field: keyof GoPlusTokenResult) => asNumber(goplus[field]);
  const authorityActive = (val: unknown) =>
    Boolean(val) && !["0","false","null",""].includes(String(val).trim().toLowerCase());

  if (gp("is_honeypot")) {
    flags.push(makeFlag("Honeypot detected — cannot sell", "critical", 0));
    trust = 0; forceRug = true;
    return { source: "goplus", trust: 0, available: true, flags, forceRug, safeBlocked };
  }
  if (gp("cannot_sell_all")) {
    flags.push(makeFlag("Cannot sell all tokens", "critical", 0));
    trust = 0; forceRug = true;
    return { source: "goplus", trust: 0, available: true, flags, forceRug, safeBlocked };
  }

  const hasMint   = authorityActive(goplus.mint_authority);
  const hasFreeze = authorityActive(goplus.freeze_authority);
  if (hasMint && hasFreeze) {
    flags.push(makeFlag("Mint + Freeze authority both active", "critical", 0));
    trust *= 0.05; forceRug = true;
  } else {
    if (hasMint)   { flags.push(makeFlag("Mint Authority enabled",   "critical", 0)); trust *= 0.25; }
    if (hasFreeze) { flags.push(makeFlag("Freeze Authority enabled", "critical", 0)); trust *= 0.25; }
  }

  if (gp("is_blacklisted"))      { flags.push(makeFlag("Blacklist capability",         "critical", 0)); trust *= 0.30; }
  if (gp("transfer_pausable"))   { flags.push(makeFlag("Transfer pausable",            "critical", 0)); trust *= 0.30; }
  if (gp("hidden_owner"))        { flags.push(makeFlag("Hidden owner detected",        "critical", 0)); trust *= 0.30; }
  if (gp("is_proxy"))            { flags.push(makeFlag("Upgradeable/proxy contract",   "critical", 0)); trust *= 0.50; }
  if (gpNum("sell_tax") > 0.1)   { flags.push(makeFlag("Sell tax > 10%",               "critical", 0)); trust *= 0.35; }
  if (gpNum("buy_tax")  > 0.1)   { flags.push(makeFlag("Buy tax > 10%",                "critical", 0)); trust *= 0.35; }
  if (gpNum("owner_percent")   > 0.05) { flags.push(makeFlag("Owner holds > 5%",   "critical", 0)); trust *= 0.50; }
  if (gpNum("creator_percent") > 0.05) { flags.push(makeFlag("Creator holds > 5%", "critical", 0)); trust *= 0.50; }
  if (gp("is_mintable"))              { flags.push(makeFlag("Token is mintable",             "warning", 0)); trust *= 0.60; }
  if (gp("slippage_modifiable"))      { flags.push(makeFlag("Slippage/tax modifiable",       "warning", 0)); trust *= 0.75; }
  if (gp("is_anti_whale_modifiable")) { flags.push(makeFlag("Anti-whale rules modifiable",   "warning", 0)); trust *= 0.80; }
  if (gp("trading_cooldown"))         { flags.push(makeFlag("Trading cooldown enabled",      "warning", 0)); trust *= 0.80; }
  if (gp("is_whitelisted"))           { flags.push(makeFlag("Whitelist system detected",     "warning", 0)); trust *= 0.80; }

  return { source: "goplus", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 4 — Helius
// ═══════════════════════════════════════════════════════════════════════════════
function layerHelius(
  rawHolderAccounts: HeliusHolder[],
  totalSupplyUi: number
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!rawHolderAccounts.length || totalSupplyUi === 0) return {
    source: "helius", trust: 1.0, available: false,
    flags: [makeFlag("Helius unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  const accounts = rawHolderAccounts.filter(
    h => !LP_PROGRAM_ADDRESSES.has(h.address) && !FOUNDATION_WALLETS.has(h.address)
  );

  const top1Amount  = asNumber(accounts[0]?.uiAmount);
  const top1Pct     = top1Amount / totalSupplyUi;
  const top10Amount = accounts.slice(0, 10).reduce((s, h) => s + asNumber(h.uiAmount), 0);
  const top10Pct    = top10Amount / totalSupplyUi;

  if (top1Pct > 0.3)      { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); trust *= 0.08; forceRug = true; }
  else if (top1Pct > 0.2) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); trust *= 0.25; safeBlocked = true; }
  // P2 FIX — top1 > 10% bloque désormais le SAFE (safeBlocked=true) et pénalise plus fort (*0.50)
  else if (top1Pct > 0.1) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "warning",  0)); trust *= 0.50; safeBlocked = true; }

  if (top10Pct > 0.8)      { flags.push(makeFlag(`Top 10 wallets hold ${Math.round(top10Pct*100)}% of supply`, "critical", 0)); trust *= 0.35; safeBlocked = true; }
  else if (top10Pct > 0.6) { flags.push(makeFlag(`Top 10 wallets hold ${Math.round(top10Pct*100)}% of supply`, "warning",  0)); trust *= 0.55; safeBlocked = true; }
  else if (top10Pct < 0.3) { flags.push(makeFlag("Well distributed supply ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }

  return { source: "helius", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 5 — Solscan
// ═══════════════════════════════════════════════════════════════════════════════
function layerSolscan(
  holderCount: number | null,
  tokenAgeHours: number | null,
  trades24h: number | null,
  traders24h: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  const hasData = holderCount !== null || tokenAgeHours !== null;
  if (!hasData) return {
    source: "solscan", trust: 1.0, available: false,
    flags: [makeFlag("Solscan unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  if (holderCount !== null) {
    if (holderCount < 15)        { flags.push(makeFlag("Very few holders (<15)",     "critical", 0)); trust *= 0.20; safeBlocked = true; }
    else if (holderCount < 50)   { flags.push(makeFlag("Low holders (<50)",          "warning",  0)); trust *= 0.35; safeBlocked = true; }
    else if (holderCount > 5000) { flags.push(makeFlag("Strong holder base (5K+) ✓", "bonus",    0)); trust = Math.min(1.0, trust * 1.05); }
  }

  if (tokenAgeHours !== null) {
    if (tokenAgeHours < 0.5)      { flags.push(makeFlag("Newborn token on-chain (<30min)",  "critical", 0)); trust *= 0.10; safeBlocked = true; }
    else if (tokenAgeHours < 1)   { flags.push(makeFlag("Newborn token on-chain (<1h)",    "critical", 0)); trust *= 0.20; safeBlocked = true; }
    else if (tokenAgeHours < 6)   { flags.push(makeFlag("Fresh token on-chain (<6h)",      "warning",  0)); trust *= 0.65; }
    else if (tokenAgeHours > 720) { flags.push(makeFlag("Established token (30d+) ✓",      "bonus",    0)); trust = Math.min(1.0, trust * 1.05); }
  }

  if (trades24h !== null && traders24h !== null && traders24h > 0) {
    const tradesPerTrader = trades24h / traders24h;
    if (tradesPerTrader > 50 && traders24h < 20) {
      flags.push(makeFlag("Wash trading suspected (trades/traders ratio)", "critical", 0));
      trust *= 0.50; safeBlocked = true;
    } else if (traders24h > 500 && tradesPerTrader < 0.1) {
      flags.push(makeFlag("Bot-farmed holders: many accounts, near-zero activity", "warning", 0));
      trust *= 0.70; safeBlocked = true;
    }
  }

  return { source: "solscan", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 6 — Chart patterns
// ═══════════════════════════════════════════════════════════════════════════════
function layerChart(
  candles: OHLCVCandle[],
  pair: DexScreenerPair | null,
  tokenAgeMinutes: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!candles || candles.length < 8) return {
    source: "chart", trust: 1.0, available: false,
    flags: [], forceRug: false, safeBlocked: false,
  };

  const recent  = candles.slice(-40);
  const closes  = recent.map(c => c.c);
  const volumes = recent.map(c => c.v);
  const greens  = recent.filter(c => c.c > c.o).length;
  const greenRatio = greens / recent.length;
  const first = closes[0], last = closes[closes.length - 1];
  const peak  = Math.max(...closes), trough = Math.min(...closes);
  const runUpPct         = _pct(first, peak);
  const drawdownFromPeak = _pct(peak, last);
  const pullbackRange    = peak > 0 ? ((peak - trough) / peak) * 100 : 0;
  const returns     = closes.slice(1).map((c, i) => _pct(closes[i], c));
  const returnStd   = _std(returns);
  const risingCount = closes.slice(1).filter((c, i) => c > closes[i]).length;
  const liq    = asNumber(pair?.liquidity?.usd);
  const vol24h = asNumber(pair?.volume?.h24);
  const vol1h  = asNumber(pair?.volume?.h1);
  const pc5m   = asNumber(pair?.priceChange?.m5);
  const pc1h   = asNumber(pair?.priceChange?.h1);
  const pc24h  = asNumber(pair?.priceChange?.h24);
  const v24Liq = liq > 0 ? vol24h / liq : 0;
  const v1hLiq = liq > 0 ? vol1h  / liq : 0;

  if (greenRatio >= 0.82 && runUpPct >= 100 && pullbackRange <= 10) {
    flags.push(makeFlag("Crashcoin pattern: near-perfect parabolic chart", "critical", 0));
    trust *= 0.35; safeBlocked = true;
  }
  if (pc5m > 35 && pc1h > 120) {
    flags.push(makeFlag("Vertical pump detected (+35% 5m / +120% 1h)", "warning", 0));
    trust *= 0.55; safeBlocked = true;
  }
  if (v24Liq > 12 || v1hLiq > 4) {
    flags.push(makeFlag("Liquidity mirage: volume >> liquidity (wash)", "warning", 0));
    trust *= 0.60; safeBlocked = true;
  }
  if (recent.length >= 10 && risingCount >= Math.floor(recent.length * 0.8) && returnStd < 3.5) {
    flags.push(makeFlag("Over-controlled chart: artificial stair-step", "warning", 0));
    trust *= 0.65; safeBlocked = true;
  }
  if (drawdownFromPeak < -55) {
    flags.push(makeFlag("Blow-off top: price collapsed >55% from peak", "critical", 0));
    trust *= 0.20; forceRug = true; safeBlocked = true;
  }
  if (tokenAgeMinutes !== null && tokenAgeMinutes < 90 && volumes.length >= 10) {
    const recentVol = volumes.slice(-5);
    const olderVol  = volumes.slice(-10, -5);
    if (olderVol.length && _mean(recentVol) < _mean(olderVol) * 0.45 && last >= peak * 0.88) {
      flags.push(makeFlag("Early volume exhaustion near highs", "warning", 0));
      trust *= 0.65; safeBlocked = true;
    }
  }
  if (_pct(first, last) > 300 && greenRatio > 0.78) {
    flags.push(makeFlag("Parabolic launch: high risk exit liquidity setup", "warning", 0));
    trust *= 0.60; safeBlocked = true;
  }
  if (pc24h < -60 && pc1h < -20) {
    flags.push(makeFlag("Active dump: -60% 24h + -20% 1h (slow rug)", "critical", 0));
    trust *= 0.25; forceRug = true; safeBlocked = true;
  }

  return { source: "chart", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 7 — Identity
// ═══════════════════════════════════════════════════════════════════════════════
function layerIdentity(symbol?: string | null, name?: string | null, mint?: string | null): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nm  = String(name   || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const hasCopycatSuffix = COPYCAT_SUFFIXES.some(s => sym.endsWith(s) || nm.endsWith(s));
  if (hasCopycatSuffix) {
    flags.push(makeFlag("Copycat branding detected (v2/official/real suffix)", "critical", 0));
    trust *= 0.25; safeBlocked = true;
  }

  if (!mint || !OFFICIAL_MINTS.has(mint)) {
    for (const brand of KNOWN_BRANDS) {
      const symMatch = sym.startsWith(brand) || sym.endsWith(brand) || sym === brand;
      if (symMatch || nm.includes(brand)) {
        flags.push(makeFlag(`Brand imitation: ${brand}-style copycat token`, "critical", 0));
        trust *= 0.20; safeBlocked = true; break;
      }
    }
  }

  return { source: "identity", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 8 — CrossValidation
// ═══════════════════════════════════════════════════════════════════════════════
function layerCrossValidation(
  rugData: RugCheckSummary | null,
  rawHolderAccounts: HeliusHolder[],
  goplus: GoPlusTokenResult | null,
  solscanAgeHours: number | null,
  dexAgeHours: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let forceRug = false, safeBlocked = false;

  if (rugData?.lpBurned === true) {
    const lpStillActive = rawHolderAccounts.some(h => LP_PROGRAM_ADDRESSES.has(h.address));
    if (lpStillActive) flags.push(makeFlag("LP burn conflict: RugCheck vs on-chain data", "warning", 0));
  }
  if (goplus && rugData) {
    const gpMint = goplus.mint_authority;
    const gpOff  = ["0","false","null",""].includes(String(gpMint).trim().toLowerCase());
    if (gpOff && rugData.mintAuthorityEnabled === true)
      flags.push(makeFlag("Mint authority conflict: GoPlus vs RugCheck", "warning", 0));
  }
  if (solscanAgeHours !== null && dexAgeHours !== null) {
    if (Math.abs(solscanAgeHours - dexAgeHours) > 72)
      flags.push(makeFlag("Token age conflict between sources (>72h diff)", "info", 0));
  }

  return { source: "crossvalidation", trust: 1.0, available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING FINAL
// ═══════════════════════════════════════════════════════════════════════════════
function computeFinalScore(layers: LayerResult[]): number {
  const sources = ["dexscreener","rugcheck","goplus","helius","solscan","chart"] as const;
  let product = 1.0;
  let totalWeight = 0;

  for (const src of sources) {
    const layer = layers.find(l => l.source === src);
    const w = LAYER_WEIGHTS[src];
    if (!layer || !layer.available) continue;
    product    *= Math.pow(Math.max(0.001, layer.trust), w);
    totalWeight += w;
  }

  if (totalWeight === 0) return 0;

  // [2.1] Dynamic layer reweighting — normalise by available weight so missing
  // sources don't structurally deflate the score.
  product = Math.pow(product, 1 / totalWeight);

  const identity = layers.find(l => l.source === "identity");
  if (identity?.available) product *= identity.trust;

  // [2.2] Cross-validation trust penalties — apply multipliers based on conflict flags
  const xv = layers.find(l => l.source === "crossvalidation");
  if (xv?.available && xv.flags.length > 0) {
    for (const f of xv.flags) {
      if (/LP burn conflict/i.test(f.label))        product *= 0.85;
      else if (/Mint authority conflict/i.test(f.label)) product *= 0.70;
      else if (/age conflict/i.test(f.label))        product *= 0.90;
    }
  }

  return Math.round(Math.max(0, Math.min(1, product)) * 1000);
}

// ─── [2.3] SAFE-BLOCK REASON CLASSIFIER ──────────────────────────────────────
const HARD_BLOCK_PATTERNS: Array<[RegExp, SafeBlockedReason]> = [
  [/mint authority/i,    "mint"],
  [/freeze authority/i,  "freeze"],
  [/honeypot/i,          "honeypot"],
  [/copycat|brand imitation/i, "copycat"],
  [/wash trading/i,      "wash_trading"],
  [/bundle|bundler/i,    "bundle"],
  [/sniper/i,            "sniper"],
  [/rug|dump|exit trap/i,"rug_pattern"],
  [/pump|parabolic/i,    "pump"],
  [/chart|blow-off|stair-step|volume exhaustion|liquidity mirage/i, "chart"],
];

function classifySafeBlockedReasons(layers: LayerResult[]): SafeBlockedReason[] {
  const reasons: SafeBlockedReason[] = [];
  const seen: Record<string, boolean> = {};
  function add(r: SafeBlockedReason) { if (!seen[r]) { seen[r] = true; reasons.push(r); } }

  for (const layer of layers) {
    if (!layer.safeBlocked) continue;
    let matched = false;
    for (const flag of layer.flags) {
      for (const entry of HARD_BLOCK_PATTERNS) {
        if (entry[0].test(flag.label)) { add(entry[1]); matched = true; }
      }
    }
    // If safeBlocked but no hard-block flag matched, classify by layer source
    if (!matched) {
      if (layer.source === "solscan" || layer.source === "helius") {
        for (const f of layer.flags) {
          if (/holder/i.test(f.label) || /wallet.*holds/i.test(f.label) || /top.*hold/i.test(f.label)) add("holders");
          if (/newborn|fresh|age|<\d+h|<\d+min/i.test(f.label)) add("age");
        }
      }
    }
  }
  return reasons;
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ||
    "unknown";

  if (ratelimit) {
    const { success } = await ratelimit.limit(ip);
    if (!success) return res.status(429).json({ error: "Too many requests. Please slow down." });
  }
  // [2.8] Burst rate limiting — 5 req/10s per IP
  if (burstRatelimit) {
    const { success } = await burstRatelimit.limit(ip);
    if (!success) {
      res.setHeader("Retry-After", "10");
      return res.status(429).json({ error: "Burst limit exceeded. Retry in 10 seconds." });
    }
  }

  const ca = req.query.ca as string | undefined;
  if (!ca || !CA_RE.test(ca)) return res.status(400).json({ error: "Invalid token address." });

  // [1.3] Adaptive Redis cache — serve cached result if within TTL
  const cacheKey = `antares:v2:${ca}`;
  if (scanCacheRedis) {
    try {
      const cached = await scanCacheRedis.get(cacheKey);
      if (cached) return res.json(cached);
    } catch { /* cache miss or Redis error — continue with fresh fetch */ }
  }

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

  try {
    const [dexRes, rugRes, rugReportRes] = await Promise.all([
      settled(fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`, {}, 5000)),
      settled(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`, {}, 5000)),
      settled(fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report`, {}, 8000)),
    ]);

    let dexData = dexRes as DexScreenerResponse | null;
    let rugData = rugRes as RugCheckSummary | null;
    let pair: DexScreenerPair | null = dexData?.pairs?.[0] ?? null;
    let resolvedMint = ca;

    const rugMissing =
      !rugData ||
      rugData?.error === "not found" ||
      rugData?.message?.toLowerCase?.().includes("not found");

    if (!pair || !rugData || rugMissing) {
      const pairData     = await settled(fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`, {}, 5000)) as DexScreenerResponse | null;
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint     = resolvedPair?.baseToken?.address;
      if (resolvedPair) pair = pair ?? resolvedPair;
      if (baseMint && baseMint !== ca) {
        resolvedMint = baseMint;
        const [dexRetry, rugRetry] = await Promise.all([
          settled(fetchJson(`${DEXSCREENER_BASE}/tokens/${resolvedMint}`, {}, 5000)),
          settled(fetchJson(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`, {}, 5000)),
        ]);
        const dexRetryTyped = dexRetry as DexScreenerResponse | null;
        const rugRetryTyped = rugRetry as RugCheckSummary | null;
        if (dexRetryTyped?.pairs?.[0]) { dexData = dexRetryTyped; pair = dexRetryTyped.pairs[0]; }
        if (rugRetryTyped) rugData = rugRetryTyped;
      } else if (!baseMint) {
        // [1.6] Structured log on mint resolution failure
        console.warn(JSON.stringify({ ca, stage: "mint_resolution_failed" }));
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
    const postLayerFlags: ScanFlag[] = [];

    // [2.5] Social honeypot detection
    const buys5m  = asNumber(pair?.txns?.m5?.buys);
    const sells5m = asNumber(pair?.txns?.m5?.sells);
    const liqUsd  = asNumber(pair?.liquidity?.usd);
    const ageMin  = tokenAgeMinutes ?? 0;
    if (sells5m === 0 && buys5m > 10 && liqUsd > 5000 && ageMin > 30) {
      postLayerFlags.push(makeFlag("Sells blocked (social honeypot)", "critical", 0));
      forceRug = true;
    }

    // [2.6] Wash trading detection via transfers (R10: skip cleanly if data unavailable)
    if (Array.isArray(recentTransfers) && recentTransfers.length >= 10) {
      const wallets = new Set<string>();
      for (const tx of recentTransfers) {
        const from = tx.from_address ?? tx.from;
        const to   = tx.to_address   ?? tx.to;
        if (typeof from === "string") wallets.add(from);
        if (typeof to   === "string") wallets.add(to);
      }
      if (wallets.size <= 3) {
        postLayerFlags.push(makeFlag("Wash trading via transfers (≤3 unique wallets in 10+ txs)", "critical", 0));
        forceRug = true;
      }
    }
    // TODO [2.6]: If Solscan Pro API does not return recentTransfers, this block is safely skipped.

    // [2.7] Pump.fun bonding curve guard (R10: safe proxy only, no undocumented API parsing)
    // TODO: When Pump.fun releases official API for curve % → implement graduation check.
    const volLiqRatio = liqUsd > 0 ? asNumber(pair?.volume?.h24) / liqUsd : 0;
    if (ageMin > 0 && ageMin < 60 && volLiqRatio > 15) {
      postLayerFlags.push(makeFlag("Pump.fun-style launch: <1h + vol/liq >15 — DANGER", "critical", 0));
      safeBlocked = true;
    }

    // [2.3] Track safeBlocked reasons for gate hardening
    const safeBlockedReasons = classifySafeBlockedReasons(allLayers);
    const SOFT_REASONS: Record<string, boolean> = { age: true, holders: true };
    const onlySoftReasons = safeBlockedReasons.length > 0 &&
      safeBlockedReasons.every(r => SOFT_REASONS[r] === true);

    const lpBurned = rugData?.lpBurned === true;
    const goPlusClean = l3.available && l3.trust >= 0.95 && !l3.forceRug;

    // [2.3] SAFE gate override: if safeBlocked reason is ONLY age/holders
    // (not mint/freeze/honeypot/copycat), allow SAFE when conditions met
    if (safeBlocked && onlySoftReasons && !forceRug &&
        (holders ?? 0) > 500 && lpBurned && goPlusClean) {
      safeBlocked = false;
      console.log(JSON.stringify({ ca: resolvedMint, stage: "safe_gate_override", reasons: safeBlockedReasons }));
    }

    // [2.4] Established token bonus
    const tokenAgeHours = solscanTokenAgeHours ?? dexTokenAgeHours ?? null;
    if (tokenAgeHours !== null && tokenAgeHours > 720 &&
        (holders ?? 0) > 1000 && lpBurned && goPlusClean) {
      score = Math.min(1000, Math.round(score * 1.15));
      console.log(JSON.stringify({ ca: resolvedMint, stage: "established_bonus_applied", score }));
    }

    const sources_used: string[] = allLayers
      .filter(l => l.available && l.source !== "crossvalidation" && l.source !== "identity")
      .map(l => l.source);

    let risk: Verdict;
    if (forceRug)                         risk = "RUG";
    else if (sources_used.length === 0)   risk = "DANGER";
    else if (safeBlocked && score >= 600) risk = "CAUTION";
    else if (safeBlocked)                 risk = "DANGER";
    // P3 FIX — seuil SAFE relevé à 850 (au lieu de 800)
    else if (score >= 850)                risk = "SAFE";
    else if (score >= 600)                risk = "CAUTION";
    else if (score >= 350)                risk = "DANGER";
    else                                  risk = "RUG";

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
      scoring_version: "6.0.0",
      fetchedAt: Date.now(),
    };

    // [1.3] Adaptive Redis cache — write with TTL based on token age
    if (scanCacheRedis) {
      const ttl = computeCacheTTL(tokenAgeMinutes);
      scanCacheRedis.setex(cacheKey, ttl, JSON.stringify(result)).catch(() => {});
    }

    return res.json(result);
  } catch (e) {
    console.error("[scan v6.0.0]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
