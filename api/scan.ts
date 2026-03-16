import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

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

// ─── RATE LIMIT ───────────────────────────────────────────────────────────────
let ratelimit: Ratelimit | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
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
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Severity   = "critical" | "warning" | "info" | "bonus";
type ScanFlag   = { label: string; severity: Severity; impact: number };
type LayerResult = {
  source:      string;
  trust:       number;
  available:   boolean;
  flags:       ScanFlag[];
  forceRug:    boolean;
  safeBlocked: boolean;
};

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
function makeFlag(label: string, severity: Severity, impact: number): ScanFlag {
  return { label, severity, impact };
}
function getLpLockDurationDays(rugData: any): number {
  const raw = rugData?.lpLockDurationDays ?? rugData?.lpLockDuration ?? rugData?.lockDurationDays ?? 0;
  return asNumber(raw);
}
function riskIncludes(rugData: any, matcher: RegExp): boolean {
  if (!Array.isArray(rugData?.risks)) return false;
  return rugData.risks.some((r: any) => matcher.test(String(r?.name || "")));
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

// ─── HELIUS HELPERS ───────────────────────────────────────────────────────────
async function heliusGetLargestAccounts(mint: string, key: string) {
  return fetchJsonPost(`${HELIUS_BASE}/?api-key=${key}`, {
    jsonrpc: "2.0", id: "holders", method: "getTokenLargestAccounts", params: [mint],
  });
}
async function heliusGetTokenSupply(mint: string, key: string) {
  return fetchJsonPost(`${HELIUS_BASE}/?api-key=${key}`, {
    jsonrpc: "2.0", id: "supply", method: "getTokenSupply", params: [mint],
  });
}
async function heliusGetHoldersCount(mint: string, key: string): Promise<number | null> {
  const res = await fetchJsonPost(`${HELIUS_BASE}/?api-key=${key}`, {
    jsonrpc: "2.0", id: "holders-count",
    method: "getTokenAccounts",
    params: { mint, limit: 1, page: 1 },
  }, 6000);
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
async function fetchDexCandles(
  pairAddress: string, chainId = "solana"
): Promise<Array<{ o:number; h:number; l:number; c:number; v:number; ts:number }>> {
  const url = `https://io.dexscreener.com/dex/chart/amm/v3/${chainId}/${pairAddress}?res=1&cb=1`;
  const raw = await fetchJson(url, {}, 5000);
  if (!raw || !Array.isArray(raw.bars)) return [];
  return raw.bars.map((b: any) => ({
    ts: asNumber(b.t), o: asNumber(b.o), h: asNumber(b.h),
    l: asNumber(b.l), c: asNumber(b.c), v: asNumber(b.v),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1 — DexScreener
// ═══════════════════════════════════════════════════════════════════════════════
function layerDexScreener(
  pair: any,
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
  const hasTwitter  = Array.isArray(socials)  && socials.some((s: any)  => /twitter|x/i.test(String(s?.type || s?.url || "")));
  const hasTelegram = Array.isArray(socials)  && socials.some((s: any)  => /telegram/i.test(String(s?.type || s?.url || "")));
  const hasWebsite  = Array.isArray(websites) && websites.length > 0;
  const ageMinutes  = tokenAgeMinutes ?? Infinity;

  // Liquidité
  if (liq < 1000)       { flags.push(makeFlag("Very low liquidity (<$1k)",   "critical", 0)); trust *= 0.25; }
  else if (liq < 5000)  { flags.push(makeFlag("Low liquidity (<$5k)",         "warning",  0)); trust *= 0.65; }
  else if (liq < 20000) { flags.push(makeFlag("Liquidity < $20k",             "info",     0)); trust *= 0.90; }

  // Wash trading
  if (liq > 0 && vol / liq > 20) {
    flags.push(makeFlag("Wash trading suspected (vol/liq > 20)", "critical", 0));
    trust *= 0.20; safeBlocked = true;
  } else if (liq > 0 && vol / liq > 5) {
    flags.push(makeFlag("High vol/liquidity ratio", "warning", 0));
    trust *= 0.75;
  }

  // v4.9.1 — Pump fallback (quand candles insuffisantes pour token récent)
  // Pump extrême >300% en 1h → rug trap évident
  if (pc1 > 300) {
    flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% in 1h — bundler exit trap`, "critical", 0));
    trust *= 0.05; forceRug = true; safeBlocked = true;
  } else if (pc1 > 200 && ageMinutes < 120) {
    // Pump >200% sur token < 2h → quasi-certain rug
    flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<2h) — exit trap`, "critical", 0));
    trust *= 0.10; forceRug = true; safeBlocked = true;
  } else if (pc1 > 200 && pc5 > 50) {
    flags.push(makeFlag("Coordinated pump pattern", "warning", 0));
    trust *= 0.65;
  }

  // v4.9.1 — Slow rug: -50% sur 6h ET -15% sur 1h → liquidation progressive
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
function layerRugCheck(rugData: any, rugReportData: any): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!rugData) return {
    source: "rugcheck", trust: 1.0, available: false,
    flags: [makeFlag("RugCheck unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  // v4.9.1 — Bundle supply depuis /report (champ bundledSupply ou insiderSupply)
  const bundledSupply = asNumber(
    rugReportData?.bundledSupply ??
    rugReportData?.bundleHolders ??
    rugReportData?.insiderSupplyPct ??
    rugReportData?.insider_supply_pct
  );
  //RugCheck retourne parfois une valeur 0-1, parfois 0-100
  const bundledPct = bundledSupply > 1 ? bundledSupply / 100 : bundledSupply;
  if (bundledPct > 0.40) {
    flags.push(makeFlag(`Bundle holds ${Math.round(bundledPct*100)}% of supply — coordinated buy`, "critical", 0));
    trust *= 0.05; forceRug = true;
  } else if (bundledPct > 0.20) {
    flags.push(makeFlag(`Bundle holds ${Math.round(bundledPct*100)}% of supply`, "critical", 0));
    trust *= 0.25; safeBlocked = true;
  }

  if (rugData.lpBurned === true) {
    flags.push(makeFlag("LP Burned ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.10);
  } else if (rugData.lpLocked === true) {
    const days = getLpLockDurationDays(rugData);
    if (days > 180) { flags.push(makeFlag("LP Locked > 180 days ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
    else if (days > 0 && days < 30) { flags.push(makeFlag("LP lock duration < 30 days", "warning", 0)); trust *= 0.75; }
  } else {
    flags.push(makeFlag("LP not burned or locked", "warning", 0)); trust *= 0.70;
  }

  if (rugData.metaMutable === true) { flags.push(makeFlag("Metadata mutable", "warning", 0)); trust *= 0.82; }
  else if (rugData.metaMutable !== false) { flags.push(makeFlag("Metadata not immutable", "info", 0)); trust *= 0.96; }

  const top10 = asNumber(rugData?.topHolders?.top10Percentage);
  const top1  = asNumber(rugData?.topHolders?.top1Percentage ?? rugData?.topHolders?.top1HolderPercentage);
  if (top10 > 70)      { flags.push(makeFlag("Top 10 holders > 70%", "critical", 0)); trust *= 0.45; }
  else if (top10 > 50) { flags.push(makeFlag("Top 10 holders > 50%", "warning",  0)); trust *= 0.70; }
  if (top1 > 20)       { flags.push(makeFlag("Top 1 holder > 20%",   "critical", 0)); trust *= 0.45; }

  if (riskIncludes(rugData, /sniper/i))                 { flags.push(makeFlag("Sniper activity detected",  "critical", 0)); trust *= 0.15; safeBlocked = true; }
  if (riskIncludes(rugData, /bundler|bundle/i))          { flags.push(makeFlag("Bundler detected",           "critical", 0)); trust *= 0.15; safeBlocked = true; }
  if (riskIncludes(rugData, /rug/i))                     { flags.push(makeFlag("Rug pull history",           "critical", 0)); trust *= 0.15; forceRug = true; }
  if (riskIncludes(rugData, /creator.*sell|dev.*sell/i)) { flags.push(makeFlag("Dev wallet sold tokens",    "warning",  0)); trust *= 0.65; }

  if (rugData.mintAuthorityEnabled)   { flags.push(makeFlag("Mint Authority enabled (RugCheck)",   "critical", 0)); trust *= 0.25; }
  if (rugData.freezeAuthorityEnabled) { flags.push(makeFlag("Freeze Authority enabled (RugCheck)", "critical", 0)); trust *= 0.25; }

  return { source: "rugcheck", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3 — GoPlus
// ═══════════════════════════════════════════════════════════════════════════════
function layerGoPlus(goplus: any): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  let forceRug = false, safeBlocked = false;

  if (!goplus) return {
    source: "goplus", trust: 1.0, available: false,
    flags: [makeFlag("GoPlus unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  const gp = (field: string) => {
    const v = goplus[field];
    return v === "1" || v === 1 || v === true;
  };
  const gpNum = (field: string) => asNumber(goplus[field]);
  const authorityActive = (val: any) =>
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
  rawHolderAccounts: Array<{ address: string; uiAmount: number }>,
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
  else if (top1Pct > 0.1) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "warning",  0)); trust *= 0.65; }

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
    // v4.9.1 — token < 30min : risque extrême
    if (tokenAgeHours < 0.5)      { flags.push(makeFlag("Newborn token on-chain (<30min)",  "critical", 0)); trust *= 0.10; safeBlocked = true; }
    else if (tokenAgeHours < 1)   { flags.push(makeFlag("Newborn token on-chain (<1h)",    "critical", 0)); trust *= 0.20; safeBlocked = true; }
    else if (tokenAgeHours < 6)   { flags.push(makeFlag("Fresh token on-chain (<6h)",      "warning",  0)); trust *= 0.65; }
    else if (tokenAgeHours > 720) { flags.push(makeFlag("Established token (30d+) ✓",      "bonus",    0)); trust = Math.min(1.0, trust * 1.05); }
  }

  // v4.9.1 — bot-farm detection: volume/trader ratio très bas avec beaucoup de traders
  if (trades24h !== null && traders24h !== null && traders24h > 0) {
    const tradesPerTrader = trades24h / traders24h;
    if (tradesPerTrader > 50 && traders24h < 20) {
      flags.push(makeFlag("Wash trading suspected (trades/traders ratio)", "critical", 0));
      trust *= 0.50; safeBlocked = true;
    } else if (traders24h > 500 && tradesPerTrader < 0.1) {
      // Beaucoup de "holders" mais quasi aucun trade → wallets bot-farmés
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
  candles: Array<{ o:number; h:number; l:number; c:number; v:number; ts:number }>,
  pair: any,
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
  rugData: any,
  rawHolderAccounts: Array<{ address: string; uiAmount: number }>,
  goplus: any,
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
  if (totalWeight < 1.0) product = Math.pow(product, 1 / totalWeight);

  const identity = layers.find(l => l.source === "identity");
  if (identity?.available) product *= identity.trust;

  return Math.round(Math.max(0, Math.min(1, product)) * 1000);
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
    const [dexRes, rugRes, rugReportRes] = await Promise.all([
      fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`),
      fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`),
      fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report`, {}, 10000),
    ]);

    let dexData = dexRes;
    let rugData = rugRes;
    let pair    = dexData?.pairs?.[0] ?? null;
    let resolvedMint = ca;

    const rugMissing =
      !rugData ||
      rugData?.error === "not found" ||
      rugData?.message?.toLowerCase?.().includes("not found");

    if (!pair || !rugData || rugMissing) {
      const pairData     = await fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`);
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint     = resolvedPair?.baseToken?.address;
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

    if (pair?.baseToken?.address) resolvedMint = pair.baseToken.address;
    if (dexData?.pairs?.length > 1) {
      pair = dexData.pairs.reduce((best: any, p: any) =>
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
      fetchDexCandles(pairAddress),
      fetchJson(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${resolvedMint}`),
      HELIUS_API_KEY ? heliusGetLargestAccounts(resolvedMint, HELIUS_API_KEY) : Promise.resolve(null),
      HELIUS_API_KEY ? heliusGetTokenSupply(resolvedMint, HELIUS_API_KEY)    : Promise.resolve(null),
      solscanGetHoldersCount(resolvedMint),
      fetchSolscan(`/token/meta?address=${resolvedMint}`),
      fetchSolscan(`/token/transfer?address=${resolvedMint}&page=1&page_size=10`),
      fetchSolscan(`/token/markets?address=${resolvedMint}&page=1&page_size=1`),
    ]);

    const candles  = Array.isArray(candlesRaw) ? candlesRaw : [];
    const goplus   = pickGoPlusResult(goplusRaw, resolvedMint);
    const rawHolderAccounts: Array<{ address: string; uiAmount: number }> =
      heliusHoldersRaw?.result?.value ?? [];
    const totalSupplyUi: number = asNumber(heliusSupplyRaw?.result?.value?.uiAmount);

    const solMarketPool = Array.isArray(solMarkets?.data) && solMarkets.data.length > 0
      ? solMarkets.data.sort((a: any, b: any) => asNumber(b.liquidity) - asNumber(a.liquidity))[0]
      : null;
    const solscanCreatedTime: number | null = solMeta?.data?.created_time ?? null;
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
    const tokenLogo     = solMeta?.data?.icon || pair?.info?.imageUrl || null;
    const tokenCreator  = solMeta?.data?.creator || null;
    const tokenDecimals = solMeta?.data?.decimals ?? null;
    const tokenSupply   = solMeta?.data?.supply   ?? null;
    const recentTransfers = solTransfers?.data || [];
    const rugTotalHolders: number | null =
      typeof rugReportRes?.totalHolders === "number" && rugReportRes.totalHolders > 0
      ? rugReportRes.totalHolders : null;
    const holders: number | null = solscanHoldersCount ?? rugTotalHolders ?? null;

    const priceUsd: number | null = (() => {
      const n = parseFloat(pair?.priceUsd);
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
    const l2 = layerRugCheck(rugData, rugReportRes);
    const l3 = layerGoPlus(goplus);
    const l4 = layerHelius(rawHolderAccounts, totalSupplyUi);
    const l5 = layerSolscan(solscanHoldersCount, solscanTokenAgeHours, solscanTrades24h, solscanTraders24h);
    const l6 = layerChart(candles, pair, tokenAgeMinutes);
    const l7 = layerIdentity(pair?.baseToken?.symbol, pair?.baseToken?.name, resolvedMint);
    const l8 = layerCrossValidation(rugData, rawHolderAccounts, goplus, solscanTokenAgeHours, dexTokenAgeHours);

    const allLayers = [l1, l2, l3, l4, l5, l6, l7, l8];
    const score       = computeFinalScore(allLayers);
    const forceRug    = allLayers.some(l => l.forceRug);
    const safeBlocked = allLayers.some(l => l.safeBlocked);

    const sources_used: string[] = allLayers
      .filter(l => l.available && l.source !== "crossvalidation" && l.source !== "identity")
      .map(l => l.source);

    let risk: "SAFE" | "CAUTION" | "DANGER" | "RUG";
    if (forceRug)                         risk = "RUG";
    else if (sources_used.length === 0)   risk = "DANGER";
    else if (safeBlocked && score >= 800) risk = "CAUTION";
    else if (score >= 800)                risk = "SAFE";
    else if (score >= 600)                risk = "CAUTION";
    else if (score >= 350)                risk = "DANGER";
    else                                  risk = "RUG";

    const flags: ScanFlag[] = allLayers.flatMap(l => l.flags);
    const severityOrder: Record<Severity, number> = { critical:0, warning:1, info:2, bonus:3 };
    flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const confidence = Math.round((sources_used.length / 5) * 100);
    const layersSnapshot = Object.fromEntries(
      allLayers.map(l => [l.source, { trust: +l.trust.toFixed(3), available: l.available }])
    );

    return res.json({
      score, risk, flags, pair, resolvedMint, confidence, sources_used,
      holders, marketCap, priceUsd, liquidity,
      volume24h, volume1h, priceChange5m, priceChange1h, priceChange24h,
      tokenSymbol:   pair?.baseToken?.symbol ?? null,
      tokenName:     pair?.baseToken?.name   ?? null,
      pairCreatedAt: pair?.pairCreatedAt     ?? null,
      safeBlocked, tokenLogo, tokenCreator, tokenDecimals, tokenSupply, recentTransfers,
      solscanTokenAgeHours,
      solscanVolume24h,
      solscanTrades24h,
      solscanTraders24h,
      layers: layersSnapshot,
      scoring_version: "4.9.1",
      fetchedAt: Date.now(),
    });
  } catch (e) {
    console.error("[scan v4.9.1]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
