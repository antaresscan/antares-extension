import type { VercelRequest, VercelResponse } from "@vercel/node";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const HONEYPOT_BASE = "https://api.honeypot.is/v2";
const BIRDEYE_BASE = "https://public-api.birdeye.so";

const SOLANA_CHAIN_ID = "1399811149";
const CA_RE = /^[A-Za-z0-9]{32,44}$/;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type Severity = "critical" | "warning" | "info" | "bonus";

type ScanFlag = {
  label: string;
  severity: Severity;
  impact: number;
};

function setHeaders(res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
}

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 4000) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: t.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    t.clear();
  }
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

function hasAnySocials(pair: any): boolean {
  const socials = pair?.info?.socials;
  const websites = pair?.info?.websites;
  return Boolean((Array.isArray(socials) && socials.length) || (Array.isArray(websites) && websites.length));
}

function getTop10Percentage(rugData: any): number {
  return asNumber(rugData?.topHolders?.top10Percentage);
}

function getTop1Percentage(rugData: any): number {
  return asNumber(
    rugData?.topHolders?.top1Percentage ??
    rugData?.topHolders?.top1HolderPercentage
  );
}

function getLpLockDurationDays(rugData: any): number {
  const raw =
    rugData?.lpLockDurationDays ??
    rugData?.lpLockDuration ??
    rugData?.lockDurationDays ??
    0;
  return asNumber(raw);
}

function riskIncludes(rugData: any, matcher: RegExp): boolean {
  if (!Array.isArray(rugData?.risks)) return false;
  return rugData.risks.some((r: any) => matcher.test(String(r?.name || "")));
}

function makeFlag(label: string, severity: Severity, impact: number): ScanFlag {
  return { label, severity, impact };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const ca = req.query.ca as string | undefined;
  if (!ca || !CA_RE.test(ca)) {
    return res.status(400).json({ error: "Invalid token address." });
  }

  try {
    // 1) Keep existing CA -> pair -> resolved mint logic intact
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

        if (dexRetry?.pairs?.[0]) {
          dexData = dexRetry;
          pair = dexRetry.pairs[0];
        }

        if (rugRetry) rugData = rugRetry;
      }
    }

    // 2) Additional sources in parallel, but non-blocking
    const results = await Promise.allSettled([
      fetchJson(`${GOPLUS_BASE}/token_security/${SOLANA_CHAIN_ID}?contract_addresses=${resolvedMint}`),
      fetchJson(`${HONEYPOT_BASE}/IsHoneypot?address=${resolvedMint}&chainID=${SOLANA_CHAIN_ID}`),
      fetchJson(`${BIRDEYE_BASE}/defi/token_holder?address=${resolvedMint}&offset=0&limit=20`, {
        headers: {
          "x-api-key": "public",
          "x-chain": "solana",
        },
      }),
    ]);

    const goplusRaw = results[0].status === "fulfilled" ? results[0].value : null;
    const honeypotData = results[1].status === "fulfilled" ? results[1].value : null;
    const birdeyeData = results[2].status === "fulfilled" ? results[2].value : null;

    const goplus = pickGoPlusResult(goplusRaw, resolvedMint);

    let score = 1000;
    const flags: ScanFlag[] = [];
    const sources_used: string[] = [];

    if (pair) sources_used.push("DexScreener");
    if (rugData) sources_used.push("RugCheck");
    if (goplus) sources_used.push("GoPlus");
    if (honeypotData) sources_used.push("Honeypot.is");
    if (birdeyeData) sources_used.push("Birdeye");

    if (!goplus) flags.push(makeFlag("GoPlus unavailable", "info", 0));
    if (!honeypotData) flags.push(makeFlag("Honeypot.is unavailable", "info", 0));
    if (!birdeyeData) flags.push(makeFlag("Birdeye unavailable", "info", 0));
    if (!rugData) flags.push(makeFlag("RugCheck unavailable", "info", 0));
    if (!pair) flags.push(makeFlag("DexScreener unavailable or token not indexed", "info", 0));

    const addPenalty = (label: string, severity: Severity, impact: number) => {
      score -= impact;
      flags.push(makeFlag(label, severity, impact));
    };

    const addBonus = (label: string, points: number) => {
      score += points;
      flags.push(makeFlag(label, "bonus", -points));
    };

    let forceRisk: "RUG" | null = null;
    let honeypotConfirmed = false;

    // COUCHE 1 — Smart contract risk
    const mintAuthorityEnabled =
      Boolean(rugData?.mintAuthorityEnabled) ||
      Boolean(goplus?.mint_authority && String(goplus.mint_authority).trim() !== "");

    const freezeAuthorityEnabled =
      Boolean(rugData?.freezeAuthorityEnabled) ||
      Boolean(goplus?.freeze_authority && String(goplus.freeze_authority).trim() !== "");

    if (mintAuthorityEnabled) {
      addPenalty("Mint Authority enabled", "critical", 300);
    }

    if (freezeAuthorityEnabled) {
      addPenalty("Freeze Authority enabled", "critical", 300);
    }

    if (mintAuthorityEnabled && freezeAuthorityEnabled) {
      forceRisk = "RUG";
      flags.push(makeFlag("Override: Mint + Freeze authority both active", "critical", 0));
    }

    if (goplus) {
      if (goplus.is_honeypot === "1" || goplus.is_honeypot === 1 || goplus.is_honeypot === true) {
        addPenalty("GoPlus honeypot detected", "critical", 300);
        honeypotConfirmed = true;
        forceRisk = "RUG";
      }

      if (goplus.cannot_sell_all === "1") {
        addPenalty("Cannot sell all", "critical", 300);
        forceRisk = "RUG";
      }

      if (goplus.is_blacklisted === "1") {
        addPenalty("Blacklist capability detected", "critical", 300);
      }

      if (goplus.transfer_pausable === "1") {
        addPenalty("Transfer pausable", "critical", 300);
      }

      if (goplus.hidden_owner === "1") {
        addPenalty("Hidden owner detected", "critical", 300);
      }

      if (goplus.is_proxy === "1" || goplus.is_proxy === 1 || goplus.is_proxy === true) {
        addPenalty("Upgradeable/proxy contract detected", "critical", 300);
      }

      if (asNumber(goplus.sell_tax) > 0.1) {
        addPenalty("Sell tax > 10%", "critical", 250);
      }

      if (asNumber(goplus.buy_tax) > 0.1) {
        addPenalty("Buy tax > 10%", "critical", 250);
      }

      if (asNumber(goplus.owner_percent) > 0.05) {
        addPenalty("Owner holds > 5%", "critical", 250);
      }

      if (asNumber(goplus.creator_percent) > 0.05) {
        addPenalty("Creator holds > 5%", "critical", 250);
      }

      if (goplus.is_mintable === "1") {
        addPenalty("Token is mintable", "warning", 150);
      }

      if (goplus.slippage_modifiable === "1") {
        addPenalty("Slippage/tax modifiable", "warning", 150);
      }

      if (goplus.is_anti_whale_modifiable === "1") {
        addPenalty("Anti-whale rules modifiable", "warning", 150);
      }

      if (goplus.trading_cooldown === "1") {
        addPenalty("Trading cooldown enabled", "warning", 150);
      }

      if (goplus.is_whitelisted === "1") {
        addPenalty("Whitelist system detected", "warning", 150);
      }
    }

    if (rugData) {
      if (rugData.metaMutable === true) {
        addPenalty("Metadata mutable", "warning", 150);
      }

      if (!rugData.lpBurned && !rugData.lpLocked) {
        addPenalty("LP not burned or locked", "warning", 150);
      }

      const lockDurationDays = getLpLockDurationDays(rugData);
      if (rugData.lpLocked && lockDurationDays > 0 && lockDurationDays < 30) {
        addPenalty("LP lock duration < 30 days", "warning", 150);
      }

      if (!hasAnySocials(pair)) {
        flags.push(makeFlag("No socials", "info", 50));
        score -= 50;
        flags.push(makeFlag("No website", "info", 50));
        score -= 50;
      }

      if (rugData.metaMutable !== false) {
        addPenalty("Metadata not immutable", "info", 50);
      }
    }

    // COUCHE 2 — Honeypot simulation
    if (honeypotData) {
      if (honeypotData?.honeypotResult?.isHoneypot === true) {
        addPenalty("HONEYPOT CONFIRMED", "critical", 400);
        honeypotConfirmed = true;
        forceRisk = "RUG";
      }

      if (asNumber(honeypotData?.simulationResult?.sellTax) > 15) {
        addPenalty("Simulation sell tax > 15%", "critical", 200);
      }

      if (asNumber(honeypotData?.simulationResult?.buyTax) > 15) {
        addPenalty("Simulation buy tax > 15%", "warning", 100);
      }

      if (honeypotData?.simulationResult?.canBuy === false) {
        addPenalty("Cannot buy in simulation", "critical", 300);
      }

      if (honeypotData?.simulationResult?.canSell === false) {
        addPenalty("Cannot sell in simulation", "critical", 400);
        forceRisk = "RUG";
      }

      const successful = asNumber(honeypotData?.holderAnalysis?.successful);
      const failed = asNumber(honeypotData?.holderAnalysis?.failed);
      const total = successful + failed;
      if (total >= 5 && failed / total > 0.5) {
        addPenalty("High failed-sell ratio in holder analysis", "warning", 120);
      }
    }

    // COUCHE 3 — Liquidity & pool
    if (pair) {
      const liquidity = asNumber(pair?.liquidity?.usd);
      const volume24h = asNumber(pair?.volume?.h24);
      const priceChange24h = asNumber(pair?.priceChange?.h24);
      const priceChange1h = asNumber(pair?.priceChange?.h1);
      const priceChange5m = asNumber(pair?.priceChange?.m5);

      const ageMs = pair?.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      const ageMinutes = ageMs / 60000;

      if (liquidity < 1000) addPenalty("Very low liquidity", "critical", 200);
      else if (liquidity < 5000) addPenalty("Low liquidity", "warning", 100);
      else if (liquidity < 20000) addPenalty("Liquidity < $20k", "info", 30);

      if (liquidity > 0 && volume24h / liquidity > 20) {
        addPenalty("Wash trading suspected (24h vol/liquidity > 20)", "critical", 120);
      } else if (liquidity > 0 && volume24h / liquidity > 5) {
        addPenalty("High vol/liquidity ratio", "warning", 60);
      }

      if (rugData?.lpBurned === true) {
        addBonus("LP Burned ✓", 100);
      }

      const lockDurationDays = getLpLockDurationDays(rugData);
      if (rugData?.lpLocked === true && lockDurationDays > 180) {
        addBonus("LP Locked > 180 days ✓", 80);
      }

      if (priceChange1h > 200 && priceChange5m > 50) {
        addPenalty("Coordinated pump pattern", "warning", 100);
      }

      if (priceChange24h < -80) {
        addPenalty("Brutal dump 24h", "critical", 150);
      }
    }

    // COUCHE 4 — Holder distribution & forensics
    if (rugData) {
      const top10 = getTop10Percentage(rugData);
      const top1 = getTop1Percentage(rugData);

      if (top10 > 70) addPenalty("Top 10 holders > 70%", "critical", 150);
      else if (top10 > 50) addPenalty("Top 10 holders > 50%", "warning", 80);

      if (top1 > 20) addPenalty("Top 1 holder > 20%", "critical", 150);

      if (riskIncludes(rugData, /sniper/i)) {
        addPenalty("Sniper activity detected", "critical", 150);
      }

      if (riskIncludes(rugData, /bundler|bundle/i)) {
        addPenalty("Bundler detected", "critical", 200);
      }

      if (riskIncludes(rugData, /rug/i)) {
        addPenalty("Rug pull history", "critical", 200);
      }

      if (riskIncludes(rugData, /creator.*sell|dev.*sell/i)) {
        addPenalty("Dev wallet sold tokens", "warning", 100);
      }
    }

    if (birdeyeData?.data?.items && Array.isArray(birdeyeData.data.items)) {
      const holders = birdeyeData.data.items.slice(0, 5);
      const top5Percent = holders.reduce((sum: number, h: any) => sum + asNumber(h?.percentage), 0);
      if (top5Percent > 0.5) {
        addPenalty("Top 5 holders concentration > 50%", "critical", 120);
      }
    }

    // COUCHE 5 — Market & social signals
    if (pair) {
      const ageMs = pair?.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      const ageMinutes = ageMs / 60000;
      const txns5m = asNumber(pair?.txns?.m5?.buys) + asNumber(pair?.txns?.m5?.sells);
      const buys5m = asNumber(pair?.txns?.m5?.buys);
      const sells5m = asNumber(pair?.txns?.m5?.sells);
      const marketCap = asNumber(pair?.marketCap || pair?.fdv);

      if (ageMinutes > 0 && ageMinutes < 1) {
        addPenalty("Freshly launched, extreme risk", "critical", 150);
      } else if (ageMinutes > 0 && ageMinutes < 5) {
        addPenalty("Token very new", "warning", 80);
      }

      const socials = pair?.info?.socials || [];
      const websites = pair?.info?.websites || [];
      const hasTwitter = Array.isArray(socials) && socials.some((s: any) => /twitter|x/i.test(String(s?.type || s?.url || "")));
      const hasTelegram = Array.isArray(socials) && socials.some((s: any) => /telegram/i.test(String(s?.type || s?.url || "")));
      const hasWebsite = Array.isArray(websites) && websites.length > 0;

      if (!hasWebsite && !hasTwitter && !hasTelegram) {
        addPenalty("No website, no Twitter/X, no Telegram", "warning", 80);
      }

      if (txns5m < 5 && marketCap > 50000) {
        addPenalty("Low 5m transactions vs market cap", "warning", 80);
      }

      if (sells5m > 0 && buys5m > sells5m * 5) {
        addPenalty("Buys/sells imbalance suggests coordinated pump", "warning", 60);
      }
    } else {
      addPenalty("Not indexed on DexScreener", "warning", 100);
    }

    score = Math.max(0, Math.min(1000, score));

    let risk: "SAFE" | "CAUTION" | "DANGER" | "RUG";
    if (forceRisk === "RUG") {
      risk = "RUG";
    } else if (score >= 800) {
      risk = "SAFE";
    } else if (score >= 600) {
      risk = "CAUTION";
    } else if (score >= 350) {
      risk = "DANGER";
    } else {
      risk = "RUG";
    }

    const confidence = Math.round((sources_used.length / 5) * 100);

    flags.sort((a, b) => {
      const order: Record<Severity, number> = {
        critical: 0,
        warning: 1,
        info: 2,
        bonus: 3,
      };
      return order[a.severity] - order[b.severity];
    });

    return res.json({
      score,
      risk,
      flags,
      pair,
      resolvedMint,
      honeypotConfirmed,
      confidence,
      sources_used,
      tokenSymbol: pair?.baseToken?.symbol ?? null,
      scoring_version: "2.0",
    });
  } catch (e) {
    console.error("[scan v2]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
