import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// ═══════════════════════════════════════════════════════════════════════════════
// ANTARES scan.ts v6.0.0
// Architecture : une source par domaine de responsabilité
//
//  Domaine              | Source          | Supprimé
//  ---------------------|-----------------|---------------------------
//  Prix / Vol / Liq     | DexScreener     | Solscan markets
//  LP burned/locked     | RugCheck        | —
//  Concentration holders| RugCheck        | Helius getTokenLargestAccounts
//  Holders count        | Helius getTA    | Solscan public
//  Âge du token         | Solscan meta    | pairCreatedAt (âge pool ≠ âge token)
//  Sécurité on-chain    | GoPlus+RugCheck | —
// ═══════════════════════════════════════════════════════════════════════════════

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE    = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE      = "https://api.gopluslabs.io/api/v1";
const HELIUS_BASE      = "https://mainnet.helius-rpc.com";
const SOLSCAN_BASE     = "https://pro-api.solscan.io/v2.0";

const CA_RE = /^[A-Za-z0-9]{32,44}$/;

// ── Bluechips établis ─────────────────────────────────────────────────────────
const BLUECHIP_MINTS = new Set([
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "HZ1JovNiVvGqiQFQdsG6X1HJSGJAVzMBd3HueMeJLGqM", // PYTH
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",  // ORCA
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",  // bSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
]);

const BLUECHIP_SYMBOLS = new Set([
  "PENGU","BONK","WIF","JUP","PYTH","RAY","ORCA","MNGO",
  "SAMO","STEP","COPE","FIDA","SRM","MSOL","JSOL","BSOL",
  "JITOSOL","STSOL","JITO",
]);

// ── Rate limit ────────────────────────────────────────────────────────────────
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
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Severity   = "critical" | "warning" | "info" | "bonus";
type ScanFlag   = { label: string; severity: Severity; impact: number };
type ModuleResult = { flags: ScanFlag[]; penalty: number; forceRug: boolean; safeBlocked: boolean };

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────
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
    const r = await fetch(url, { ...init, signal: t.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { t.clear(); }
}

async function fetchJsonPost(url: string, body: object, timeoutMs = 5000) {
  const t = withTimeout(timeoutMs);
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

// ─── Helpers data ─────────────────────────────────────────────────────────────
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

// ─── Math ─────────────────────────────────────────────────────────────────────
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

// ─── IDENTITY ─────────────────────────────────────────────────────────────────
const KNOWN_BRANDS = [
  "TRUMP","DOGE","PEPE","SHIB","BONK","WIF","BRETT",
  "FLOKI","MAGA","BIDEN","ELON","SOLANA","SOL","BTC",
  "ETH","SUI","APT","ARB","OP","MATIC","AVAX",
];
const SHORT_BRANDS = new Set(["SOL","BTC","ETH","SUI","APT","ARB","OP"]);
const LEGIT_STAKING_RE = /^(JITO|MSOL|JSOL|BSOL|STSOL|LSOL|HSOL|VSOL|CSOL|DSOL|WSOL|XSOL)$/;

function brandMatch(sym: string, brand: string): boolean {
  if (sym === brand) return false;
  if (SHORT_BRANDS.has(brand)) {
    const rest    = sym.startsWith(brand) ? sym.slice(brand.length) : "";
    const endRest = sym.endsWith(brand)   ? sym.slice(0, sym.length - brand.length) : "";
    if (endRest && LEGIT_STAKING_RE.test(sym)) return false;
    return (rest.length > 0 && rest.length <= 3) || (endRest.length > 0 && endRest.length <= 3);
  }
  return sym.startsWith(brand) || sym.endsWith(brand);
}

function nameContainsBrand(nm: string, brand: string): boolean {
  const re = new RegExp(`(?<![A-Z0-9])${brand}(?![A-Z0-9])`);
  return re.test(nm);
}

function analyzeIdentity(symbol?: string | null, name?: string | null, isBluechip = false): ModuleResult {
  const flags: ScanFlag[] = [];
  let penalty = 0, forceRug = false, safeBlocked = false;
  if (isBluechip) return { flags, penalty, forceRug, safeBlocked };

  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nm  = String(name   || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (BLUECHIP_SYMBOLS.has(sym) || LEGIT_STAKING_RE.test(sym))
    return { flags, penalty, forceRug, safeBlocked };

  if (/(?:2|V2|V3|OFFICIAL|REAL|OG|NEW|PLUS)$/.test(sym) || /(?:2|V2|V3|OFFICIAL|REAL|OG|NEW|PLUS)$/.test(nm)) {
    flags.push(makeFlag("Copycat branding detected (v2/official/real suffix)", "critical", 250));
    penalty += 250; safeBlocked = true;
  }
  for (const brand of KNOWN_BRANDS) {
    if ((brandMatch(sym, brand) || nameContainsBrand(nm, brand)) && sym !== brand) {
      flags.push(makeFlag(`Brand imitation: ${brand}-style copycat token`, "critical", 250));
      penalty += 250; safeBlocked = true; break;
    }
  }
  return { flags, penalty, forceRug, safeBlocked };
}

// ─── CHART PATTERNS ───────────────────────────────────────────────────────────
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
  pair: any,
  tokenAgeMinutes: number | null,
  isPumpFun: boolean,
): ModuleResult {
  const flags: ScanFlag[] = [];
  let penalty = 0, forceRug = false, safeBlocked = false;
  if (!candles || candles.length < 8) return { flags, penalty, forceRug, safeBlocked };

  const recent     = candles.slice(-40);
  const closes     = recent.map(c => c.c);
  const volumes    = recent.map(c => c.v);
  const greens     = recent.filter(c => c.c > c.o).length;
  const greenRatio = greens / recent.length;
  const first = closes[0], last = closes[closes.length - 1];
  const peak  = Math.max(...closes), trough = Math.min(...closes);
  const runUpPct         = _pct(first, peak);
  const drawdownFromPeak = _pct(peak, last);
  const pullbackRange    = peak > 0 ? ((peak - trough) / peak) * 100 : 0;
  const returns     = closes.slice(1).map((c, i) => _pct(closes[i], c));
  const returnStd   = _std(returns);
  const risingCount = closes.slice(1).filter((c, i) => c > closes[i]).length;

  // Uniquement DexScreener pour vol/liq
  const liquidity = asNumber(pair?.liquidity?.usd);
  const vol24h    = asNumber(pair?.volume?.h24);
  const vol1h     = asNumber(pair?.volume?.h1);
  const pc5m      = asNumber(pair?.priceChange?.m5);
  const pc1h      = asNumber(pair?.priceChange?.h1);
  const pc24h     = asNumber(pair?.priceChange?.h24);

  // v6: seuil wash trading relevé à 30 (pump.fun bonding curve génère naturellement vol/liq élevé)
  // Pour pump.fun on n'applique PAS le wash trading chart (géré séparément dans scoring principal)
  const washLiqThreshold = isPumpFun ? Infinity : 30;
  const v24Liq = liquidity > 10 ? vol24h / liquidity : 0;
  const v1hLiq = liquidity > 10 ? vol1h  / liquidity : 0;

  const isYoung = tokenAgeMinutes !== null && tokenAgeMinutes < 120;
  const crashGreenThreshold = isYoung ? 0.75 : 0.82;
  const crashRunUpThreshold = isYoung ? 50   : 100;

  if (greenRatio >= crashGreenThreshold && runUpPct >= crashRunUpThreshold && pullbackRange <= 10) {
    flags.push(makeFlag("Crashcoin pattern: near-perfect parabolic chart", "critical", 200));
    penalty += 200; safeBlocked = true;
  }
  if (pc5m > 35 && pc1h > 120) {
    flags.push(makeFlag("Vertical pump detected (+35% 5m / +120% 1h)", "warning", 150));
    penalty += 150; safeBlocked = true;
  }
  if (isYoung && pc1h > 400) {
    flags.push(makeFlag("Hyper-pump: +400% en 1h sur token < 2h", "critical", 200));
    penalty += 200; safeBlocked = true;
  }
  if (v24Liq > washLiqThreshold || v1hLiq > washLiqThreshold / 7.5) {
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

// ─── HELIUS (holders count uniquement) ───────────────────────────────────────
async function heliusGetHoldersCount(mint: string, apiKey: string): Promise<number | null> {
  const res = await fetchJsonPost(`${HELIUS_BASE}/?api-key=${apiKey}`, {
    jsonrpc: "2.0", id: "holders-count",
    method: "getTokenAccounts",
    params: { mint, limit: 1, page: 1 },
  }, 6000);
  const total = res?.result?.total ?? res?.total;
  return typeof total === "number" ? total : null;
}

// ─── SOLSCAN PRO (meta token uniquement) ──────────────────────────────────────
async function fetchSolscanMeta(mint: string) {
  const key = process.env.SOLSCAN_API_KEY || "";
  if (!key) return null;
  return fetchJson(`${SOLSCAN_BASE}/token/meta?address=${mint}`, { headers: { token: key } }, 5000);
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────
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
    // ── Fetch 1 : DexScreener + RugCheck summary + RugCheck report (parallel) ──
    const [dexRes, rugSummaryRes, rugReportRes] = await Promise.all([
      fetchJson(`${DEXSCREENER_BASE}/tokens/${ca}`),
      fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`),
      fetchJson(`${RUGCHECK_BASE}/tokens/${ca}/report`, {}, 10000),
    ]);

    let dexData     = dexRes;
    let rugData     = rugSummaryRes;
    let pair        = dexData?.pairs?.[0] ?? null;
    let resolvedMint = ca;

    const rugMissing =
      !rugData ||
      rugData?.error === "not found" ||
      rugData?.message?.toLowerCase?.().includes("not found");

    // ── Fallback : si le CA est une pairAddress (ex: URL Birdeye/Axiom) ──
    if (!pair || rugMissing) {
      const pairData    = await fetchJson(`${DEXSCREENER_BASE}/pairs/solana/${ca}`);
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

    // Sélectionner la paire avec la plus haute liquidité (DexScreener peut en retourner plusieurs)
    if (dexData?.pairs?.length > 1) {
      pair = dexData.pairs.reduce((best: any, p: any) =>
        asNumber(p?.liquidity?.usd) > asNumber(best?.liquidity?.usd) ? p : best
      , dexData.pairs[0]);
    }

    const isPumpFun =
      pair?.dexId === "pump_fun" ||
      String(pair?.url || "").includes("pump.fun") ||
      (Array.isArray(pair?.labels) && pair.labels.some((l: any) => /pump/i.test(String(l))));

    const pairAddress = pair?.pairAddress ?? ca;

    // ── Fetch 2 : GoPlus + Helius holders count + Solscan meta + Candles (parallel) ──
    const [goplusRaw, heliusHoldersCount, solMeta, candlesRaw] = await Promise.all([
      fetchJson(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${resolvedMint}`),
      HELIUS_API_KEY ? heliusGetHoldersCount(resolvedMint, HELIUS_API_KEY) : Promise.resolve(null),
      fetchSolscanMeta(resolvedMint),
      fetchDexCandles(pairAddress),
    ]);

    const candles = Array.isArray(candlesRaw) ? candlesRaw : [];
    const goplus  = pickGoPlusResult(goplusRaw, resolvedMint);

    // ── Holders count : Helius uniquement ────────────────────────────────────
    const holders: number | null = heliusHoldersCount;

    // ── Âge du token : Solscan meta > pairCreatedAt ──────────────────────────
    // pairCreatedAt = âge de la pool, pas du token (peut être bien plus récent)
    const solscanCreatedTime: number | null = solMeta?.data?.created_time ?? null;
    const tokenAgeHours: number | null =
      solscanCreatedTime !== null
        ? (Date.now() / 1000 - solscanCreatedTime) / 3600
        : pair?.pairCreatedAt
          ? (Date.now() - pair.pairCreatedAt) / 3_600_000
          : null;

    // tokenAgeMinutes pour les chart patterns
    let tokenAgeMinutes: number | null = null;
    if (pair?.pairCreatedAt) tokenAgeMinutes = (Date.now() - pair.pairCreatedAt) / 60000;

    // ── Données financières : DexScreener uniquement ──────────────────────────
    const priceUsd: number | null = (() => {
      const n = parseFloat(pair?.priceUsd);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    const marketCap: number | null = (() => {
      const mc  = asNumber(pair?.marketCap);
      const fdv = asNumber(pair?.fdv);
      if (mc > 0)  return mc;
      if (fdv > 0) return fdv;
      return null;
    })();

    const liquidity      = asNumber(pair?.liquidity?.usd)  || null;
    const volume24h      = asNumber(pair?.volume?.h24)      || null;
    const volume1h       = asNumber(pair?.volume?.h1)       || null;
    const priceChange5m  = pair?.priceChange?.m5  ?? null;
    const priceChange1h  = pair?.priceChange?.h1  ?? null;
    const priceChange24h = pair?.priceChange?.h24 ?? null;

    const tokenLogo = solMeta?.data?.icon || pair?.info?.imageUrl || null;

    const mc       = marketCap ?? 0;
    const ageHours = tokenAgeHours;

    const isEstablished = ageHours !== null && ageHours > 720 && (holders ?? 0) > 10_000;
    const isBluechip    = (mc > 50_000_000 && (holders ?? 0) > 50_000)
      || BLUECHIP_MINTS.has(resolvedMint)
      || BLUECHIP_SYMBOLS.has(String(pair?.baseToken?.symbol || "").toUpperCase());

    // ── Sources utilisées ─────────────────────────────────────────────────────
    const sources_used: string[] = [];
    if (pair)                    sources_used.push("DexScreener");
    if (rugData && !rugMissing)  sources_used.push("RugCheck");
    if (goplus)                  sources_used.push("GoPlus");
    if (heliusHoldersCount !== null) sources_used.push("Helius");
    if (solMeta?.data)           sources_used.push("Solscan");

    // Confidence sur 4 sources réelles (DexScreener, RugCheck, GoPlus, Helius)
    const confidenceWeight =
      (pair ? 1 : 0) +
      (rugData && !rugMissing ? 1 : 0) +
      (goplus && Object.keys(goplus).length > 3 ? 1 : 0) +
      (heliusHoldersCount !== null ? 1 : 0);
    const confidence = Math.round((confidenceWeight / 4) * 100);

    // ═══════════════════════════════════════════════════════════════════════════
    // SCORING
    // ═══════════════════════════════════════════════════════════════════════════
    let score = 1000;
    const flags: ScanFlag[] = [];
    let forceRisk: "RUG" | null = null;
    let safeBlocked = false;
    let washTradingFlagged = false;

    const addPenalty = (label: string, severity: Severity, impact: number) => {
      score -= impact;
      flags.push(makeFlag(label, severity, impact));
    };
    const addBonus = (label: string, points: number) => {
      score += points;
      flags.push(makeFlag(label, "bonus", -points));
    };

    // ── 1. Pump.fun signal ────────────────────────────────────────────────────
    if (isPumpFun) {
      flags.push(makeFlag("Pump.fun token: LP non-lockable by design", "info", 0));
      // safeBlocked levé plus bas si conditions favorables
      safeBlocked = true;
    }

    // ── 2. Mint / Freeze authority ────────────────────────────────────────────
    const mintAuthorityEnabled =
      Boolean(rugData?.mintAuthorityEnabled) ||
      (Boolean(goplus?.mint_authority) &&
        !["0","false","null",""].includes(String(goplus.mint_authority).trim().toLowerCase()));
    const freezeAuthorityEnabled =
      Boolean(rugData?.freezeAuthorityEnabled) ||
      (Boolean(goplus?.freeze_authority) &&
        !["0","false","null",""].includes(String(goplus.freeze_authority).trim().toLowerCase()));

    if (mintAuthorityEnabled)   addPenalty("Mint Authority enabled", "critical", 300);
    if (freezeAuthorityEnabled) addPenalty("Freeze Authority enabled", "critical", 300);
    if (mintAuthorityEnabled && freezeAuthorityEnabled) {
      forceRisk = "RUG";
      flags.push(makeFlag("Override: Mint + Freeze authority both active", "critical", 0));
    }

    // ── 3. GoPlus security (cap 600pts) ───────────────────────────────────────
    if (goplus) {
      let goplusPenalty = 0;
      const gp = (label: string, sev: Severity, pts: number) => {
        if (goplusPenalty + pts > 600) return;
        goplusPenalty += pts;
        addPenalty(label, sev, pts);
      };
      if (goplus.is_honeypot === "1" || goplus.is_honeypot === 1 || goplus.is_honeypot === true) {
        gp("GoPlus honeypot detected", "critical", 300); forceRisk = "RUG";
      }
      if (goplus.cannot_sell_all === "1")    { gp("Cannot sell all", "critical", 300); forceRisk = "RUG"; }
      if (goplus.is_blacklisted === "1")       gp("Blacklist capability detected", "critical", 300);
      if (goplus.transfer_pausable === "1")    gp("Transfer pausable", "critical", 300);
      if (goplus.hidden_owner === "1")         gp("Hidden owner detected", "critical", 300);
      if (goplus.is_proxy === "1" || goplus.is_proxy === 1 || goplus.is_proxy === true)
        gp("Upgradeable/proxy contract", "critical", 300);
      if (asNumber(goplus.sell_tax) > 0.1)         gp("Sell tax > 10%", "critical", 250);
      if (asNumber(goplus.buy_tax) > 0.1)          gp("Buy tax > 10%", "critical", 250);
      if (asNumber(goplus.owner_percent) > 0.05)   gp("Owner holds > 5%", "critical", 250);
      if (asNumber(goplus.creator_percent) > 0.05) gp("Creator holds > 5%", "critical", 250);
      if (goplus.is_mintable === "1")              gp("Token is mintable", "warning", 150);
      if (goplus.slippage_modifiable === "1")      gp("Slippage/tax modifiable", "warning", 150);
      if (goplus.is_anti_whale_modifiable === "1") gp("Anti-whale rules modifiable", "warning", 150);
      if (goplus.trading_cooldown === "1")         gp("Trading cooldown enabled", "warning", 150);
      if (goplus.is_whitelisted === "1")           gp("Whitelist system detected", "warning", 150);
    }

    // ── 4. RugCheck : metadata + LP ───────────────────────────────────────────
    if (rugData) {
      if (rugData.metaMutable === true && !isEstablished) {
        addPenalty("Metadata mutable", "warning", 150);
      } else if (rugData.metaMutable === true && isEstablished) {
        addPenalty("Metadata mutable (token établi)", "info", 20);
      } else if (rugData.metaMutable !== false && !isEstablished && !isBluechip) {
        addPenalty("Metadata not immutable", "info", 50);
      }

      const isSmallAndRecent = mc < 5_000_000 && (ageHours === null || ageHours < 720);

      if (!rugData.lpBurned && !rugData.lpLocked) {
        if (isBluechip) {
          // pas de pénalité
        } else if (isPumpFun) {
          // pump.fun : LP non-lockable par design, pénalité minimale
          addPenalty("LP not burned or locked (pump.fun — by design)", "info", 30);
        } else if (isSmallAndRecent) {
          addPenalty("LP not burned or locked", "warning", 200);
          safeBlocked = true;
        } else {
          addPenalty("LP not burned or locked", "info", 30);
        }
      }

      const lockDurationDays = getLpLockDurationDays(rugData);
      if (rugData.lpLocked && lockDurationDays > 0 && lockDurationDays < 30)
        addPenalty("LP lock duration < 30 days", "warning", 150);

      // ── 5. RugCheck concentration holders (SOURCE UNIQUE — pas de doublon Helius) ──
      // RugCheck topHolders exclut déjà les pools connues de son côté
      const top10 = asNumber(rugData?.topHolders?.top10Percentage);
      const top1  = asNumber(rugData?.topHolders?.top1Percentage ?? rugData?.topHolders?.top1HolderPercentage);

      if (top10 > 70)      addPenalty("Top 10 holders > 70%", "critical", 150);
      else if (top10 > 50) addPenalty("Top 10 holders > 50%", "warning", 80);

      // Pour pump.fun on tolère un top1 plus élevé (bonding curve peut encore être large)
      const top1CritThreshold = isPumpFun ? 30 : 20;
      if (top1 > top1CritThreshold)
        addPenalty(`Top 1 holder > ${top1CritThreshold}%`, "critical", 150);

      // ── 6. RugCheck risks ─────────────────────────────────────────────────
      if (riskIncludes(rugData, /sniper/i))         addPenalty("Sniper activity detected", "critical", 150);
      if (riskIncludes(rugData, /bundler|bundle/i)) addPenalty("Bundler detected", "critical", 200);
      if (riskIncludes(rugData, /rug/i))            addPenalty("Rug pull history", "critical", 200);

      if (riskIncludes(rugData, /creator.*sell|dev.*sell/i)) {
        const devSellRisk = Array.isArray(rugData?.risks)
          ? rugData.risks.find((r: any) => /creator.*sell|dev.*sell/i.test(String(r?.name || "")))
          : null;
        const devSoldPct = asNumber(devSellRisk?.value ?? devSellRisk?.percentage ?? 0);
        if (devSoldPct > 50) {
          addPenalty(`Dev wallet sold ${Math.round(devSoldPct)}% of tokens`, "critical", 250);
        } else {
          addPenalty("Dev wallet sold tokens", "warning", 150);
        }
      }
    }

    // ── 7. DexScreener : liquidité + volume (SOURCE UNIQUE) ──────────────────
    if (pair) {
      const liq  = asNumber(pair?.liquidity?.usd);
      const vol  = asNumber(pair?.volume?.h24);
      const pc24 = asNumber(pair?.priceChange?.h24);
      const pc1  = asNumber(pair?.priceChange?.h1);
      const pc5  = asNumber(pair?.priceChange?.m5);

      if (liq < 1000)       addPenalty("Very low liquidity", "critical", 200);
      else if (liq < 5000)  addPenalty("Low liquidity", "warning", 100);
      else if (liq < 20000) addPenalty("Liquidity < $20k", "info", 30);

      if (mc > 200_000 && liq > 0 && (liq / mc) < 0.003 && !isBluechip) {
        addPenalty("Dangerously low liq/mcap ratio (<0.3%)", "critical", 180);
        safeBlocked = true;
      }

      // Wash trading : seuil 30 pour tous, ignoré pour pump.fun (bonding curve normal)
      if (!isPumpFun && liq > 10 && vol / liq > 30) {
        addPenalty("Wash trading suspected (vol/liq > 30)", "critical", 120);
        washTradingFlagged = true;
      } else if (!isPumpFun && liq > 10 && vol / liq > 8) {
        addPenalty("High vol/liquidity ratio", "warning", 60);
      }

      if (rugData?.lpBurned === true)  addBonus("LP Burned ✓", 100);
      const lockDays = getLpLockDurationDays(rugData);
      if (rugData?.lpLocked === true && lockDays > 180) addBonus("LP Locked > 180 days ✓", 80);

      if (pc1 > 200 && pc5 > 50) addPenalty("Coordinated pump pattern", "warning", 100);
      if (pc24 < -80)             addPenalty("Brutal dump 24h", "critical", 150);

    } else {
      addPenalty("Not indexed on DexScreener", "warning", 100);
    }

    // ── 8. Âge du token ───────────────────────────────────────────────────────
    if (tokenAgeMinutes !== null) {
      if (tokenAgeMinutes < 1)       addPenalty("Freshly launched, extreme risk", "critical", 150);
      else if (tokenAgeMinutes < 5)  addPenalty("Token very new (< 5 min)", "warning", 80);
      else if (tokenAgeMinutes < 60) addPenalty("Token < 1 hour old", "info", 30);
    }

    if (ageHours !== null) {
      if (ageHours < 1) {
        addPenalty("Newborn token on-chain (<1h)", "critical", 100);
        safeBlocked = true;
      } else if (ageHours < 6) {
        addPenalty("Fresh token on-chain (<6h)", "warning", 50);
      } else if (ageHours > 720) {
        addBonus("Established token on-chain (30d+) ✓", 20);
      }
    }

    // ── 9. Holders count (Helius) ────────────────────────────────────────────
    if (holders !== null) {
      if (holders === 0) {
        addPenalty("Zero holders detected (ghost token)", "critical", 200);
        safeBlocked = true;
      } else if (holders < 15) {
        addPenalty("Very few holders (<15)", "critical", 150);
        safeBlocked = true;
      } else if (holders < 50) {
        addPenalty("Low holders (<50)", "warning", 80);
        safeBlocked = true;
      } else if (holders > 5000) {
        addBonus("Strong holder base (5K+) ✓", 30);
      }
    }

    // ── 10. Socials ───────────────────────────────────────────────────────────
    if (pair) {
      const buys5m  = asNumber(pair?.txns?.m5?.buys);
      const sells5m = asNumber(pair?.txns?.m5?.sells);
      const txns5m  = buys5m + sells5m;
      const socials  = pair?.info?.socials  || [];
      const websites = pair?.info?.websites || [];
      const hasTwitter  = Array.isArray(socials) && socials.some((s: any) => /twitter|x/i.test(String(s?.type || s?.url || "")));
      const hasTelegram = Array.isArray(socials) && socials.some((s: any) => /telegram/i.test(String(s?.type || s?.url || "")));
      const hasWebsite  = Array.isArray(websites) && websites.length > 0;
      const isYoungEnoughForSocials = ageHours === null || ageHours < 8760;
      if (!hasWebsite && !hasTwitter && !hasTelegram && isYoungEnoughForSocials)
        addPenalty("No website / Twitter / Telegram", "warning", 80);
      if (txns5m < 5 && mc <= 50_000_000)
        addPenalty("Low 5m transactions vs market cap", "warning", 80);
      if (sells5m > 0 && buys5m > sells5m * 5)
        addPenalty("Buy/sell imbalance (coordinated pump)", "warning", 60);
    }

    // ── 11. Identity ──────────────────────────────────────────────────────────
    const identity = analyzeIdentity(pair?.baseToken?.symbol, pair?.baseToken?.name, isBluechip);
    score -= identity.penalty;
    flags.push(...identity.flags);
    if (identity.forceRug)    forceRisk   = "RUG";
    if (identity.safeBlocked) safeBlocked = true;

    // ── 12. Chart patterns ────────────────────────────────────────────────────
    const chart = analyzeChartPatterns(candles, pair, tokenAgeMinutes, isPumpFun);
    score -= chart.penalty;
    flags.push(...chart.flags);
    if (chart.forceRug)    forceRisk   = "RUG";
    if (chart.safeBlocked) safeBlocked = true;

    // ── 13. Bluechip bonus ────────────────────────────────────────────────────
    if (isBluechip)  addBonus("Large-cap established token ✓", 80);
    if (isEstablished && (holders ?? 0) > 100_000) addBonus("100K+ holders ✓", 50);

    // ── Pump.fun : lever safeBlocked si conditions raisonnables ──────────────
    // LP brûlée OU (holders > 200 ET mcap > 50k ET pas de flag critique autre que pump.fun)
    if (isPumpFun && safeBlocked) {
      const criticalNonPumpFlags = flags.filter(
        f => f.severity === "critical" && f.impact > 0 &&
             !f.label.includes("pump.fun") && !f.label.includes("Pump.fun")
      );
      const lpBurned = rugData?.lpBurned === true;
      const healthyEnough = (holders ?? 0) > 200 && mc > 50_000;
      if (lpBurned && criticalNonPumpFlags.length === 0) safeBlocked = false;
      else if (healthyEnough && criticalNonPumpFlags.length === 0) safeBlocked = false;
    }

    // ── Score final ───────────────────────────────────────────────────────────
    score = Math.max(0, Math.min(1000, score));

    // Cap selon âge (pool) — sécurité pour les très nouveaux tokens
    if (ageHours !== null && ageHours < 0.5) score = Math.min(score, 499);
    else if (ageHours !== null && ageHours < 2)  score = Math.min(score, 599);
    else if (ageHours !== null && ageHours < 6)  score = Math.min(score, 749);

    let risk: "SAFE" | "CAUTION" | "DANGER" | "RUG";
    if (forceRisk === "RUG")              risk = "RUG";
    else if (safeBlocked && score >= 800) risk = "CAUTION";
    else if (score >= 800)                risk = "SAFE";
    else if (score >= 600)                risk = "CAUTION";
    else if (score >= 350)                risk = "DANGER";
    else                                  risk = "RUG";

    flags.sort((a, b) => {
      const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, bonus: 3 };
      return order[a.severity] - order[b.severity];
    });

    return res.json({
      score, risk, flags, pair, resolvedMint, confidence, sources_used,
      holders, marketCap, priceUsd, liquidity,
      volume24h, volume1h, priceChange5m, priceChange1h, priceChange24h,
      tokenSymbol:   pair?.baseToken?.symbol ?? null,
      tokenName:     pair?.baseToken?.name   ?? null,
      pairCreatedAt: pair?.pairCreatedAt     ?? null,
      safeBlocked, tokenLogo,
      tokenAgeHours,
      isPumpFun,
      scoring_version: "6.0.0",
      fetchedAt: Date.now(),
    });

  } catch (e) {
    console.error("[scan v6.0.0]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
