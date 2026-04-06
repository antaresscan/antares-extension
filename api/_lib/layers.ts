// api/layers.ts — All analysis layer functions (1–8)
// Layer 7 (Identity/Copycat) REMOVED — caused massive false positives

import type {
    LayerResult, ScanFlag,
  DexScreenerPair, DexScreenerSocial,
  RugCheckSummary, RugCheckReport,
  GoPlusTokenResult,
  HeliusHolder,
  OHLCVCandle,
} from "./types";
import {
  LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS, OFFICIAL_MINTS,
} from "./constants";
import { asNumber, _mean, _std, _pct } from "./math";
import { makeFlag, getLpLockDurationDays, riskIncludes } from "./helpers";
import { extractBundlePct } from "./fetchers";

function applyDiminishingPenalties(trust: number, penalties: number[]): number {
  if (penalties.length > 0) {
    penalties.sort((a, b) => a - b); // worst first
    for (let i = 0; i < penalties.length; i++) {
      const dampening = 1 / (1 + i * 0.3);
      trust *= 1 - (1 - penalties[i]) * dampening;
    }
  }
  return trust;
}

// ═══ LAYER 1 — DexScreener ═════════════════════════════════════════════════════
export function layerDexScreener(
  pair: DexScreenerPair | null,
  marketCap: number | null,
  tokenAgeMinutes: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false, safeBlocked = false;
  if (!pair) return {
    source: "dexscreener", trust: 1.0, available: false,
    flags: [makeFlag("Not indexed on DexScreener", "warning", 0)],
    forceRug: false, safeBlocked: false,
  };
  const liq = asNumber(pair.liquidity?.usd);
  const vol = asNumber(pair.volume?.h24);
  const pc24 = asNumber(pair.priceChange?.h24);
  const pc1 = asNumber(pair.priceChange?.h1);
  const pc6 = asNumber(pair.priceChange?.h6);
  const pc5 = asNumber(pair.priceChange?.m5);
  const buys5m = asNumber(pair.txns?.m5?.buys);
  const sells5m = asNumber(pair.txns?.m5?.sells);
  const txns5m = buys5m + sells5m;
  const mc = marketCap ?? 0;
  const socials = pair.info?.socials || [];
  const websites = pair.info?.websites || [];
  const hasTwitter = Array.isArray(socials) && socials.some((s: DexScreenerSocial) => /twitter|x/i.test(String(s?.type || s?.url || "")));
  const hasTelegram = Array.isArray(socials) && socials.some((s: DexScreenerSocial) => /telegram/i.test(String(s?.type || s?.url || "")));
  const hasWebsite = Array.isArray(websites) && websites.length > 0;
  const ageMinutes = tokenAgeMinutes ?? Infinity;

  if (liq < 1000) { flags.push(makeFlag("Very low liquidity (<$1k)", "critical", 0)); penalties.push(0.25); }
  else if (liq < 5000) { flags.push(makeFlag("Low liquidity (<$5k)", "warning", 0)); penalties.push(0.65); }
  else if (liq < 20000) { flags.push(makeFlag("Liquidity < $20k", "info", 0)); penalties.push(0.90); }

  if (liq === 0 && vol > 10000) {
    flags.push(makeFlag("Volume with zero liquidity — abandoned pool", "critical", 0));
    penalties.push(0.10); forceRug = true; safeBlocked = true;
  } else if (liq > 0 && vol / liq > 20) {
    flags.push(makeFlag("Wash trading detected (vol/liq > 20) — bundler dump", "critical", 0));
    penalties.push(0.20); forceRug = true; safeBlocked = true;
  } else if (liq > 0 && vol / liq > 5) {
    flags.push(makeFlag("High vol/liquidity ratio", "warning", 0));
    penalties.push(0.75);
  }

  const hasStructuralWeakness =
    (liq > 0 && vol / liq > 10) ||
    (txns5m > 30 && sells5m === 0) ||
    liq < 15000;
  if (ageMinutes < 30 && pc1 > 150) {
    if (hasStructuralWeakness) {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on <30min token + structural weakness — exit trap`, "critical", 0));
      penalties.push(0.05); forceRug = true; safeBlocked = true;
    } else {
      flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% on newborn token (<30min)`, "warning", 0));
      penalties.push(0.30); safeBlocked = true;
    }
  } else if (ageMinutes < 60 && pc1 > 120) {
    if (hasStructuralWeakness) {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on <1h token + structural weakness — exit trap`, "critical", 0));
      penalties.push(0.05); forceRug = true; safeBlocked = true;
    } else {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<1h)`, "warning", 0));
      penalties.push(0.40); safeBlocked = true;
    }
  } else if (pc1 > 300) {
    flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% in 1h — bundler exit trap`, "critical", 0));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else if (pc1 > 200 && ageMinutes < 120) {
    flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<2h) — exit trap`, "critical", 0));
    penalties.push(0.10); forceRug = true; safeBlocked = true;
  } else if (pc1 > 200 && pc5 > 50) {
    flags.push(makeFlag("Coordinated pump pattern", "warning", 0));
    penalties.push(0.65);
  }
  if (pc6 < -50 && pc1 < -15) {
    flags.push(makeFlag("Slow rug detected: -50% on 6h + -15% on 1h", "critical", 0));
    penalties.push(0.15); forceRug = true; safeBlocked = true;
  }
  if (!hasWebsite && !hasTwitter && !hasTelegram) { flags.push(makeFlag("No website / Twitter / Telegram — high rug risk", "critical", 0)); penalties.push(0.60); safeBlocked = true; }
  if (txns5m < 5 && mc > 50000 && ageMinutes < 1440) { flags.push(makeFlag("Low 5m transactions vs market cap", "warning", 0)); penalties.push(0.88); }
  if ((sells5m === 0 && buys5m > 0 && txns5m > 5) || (sells5m > 0 && buys5m > sells5m * 5)) { flags.push(makeFlag("Buy/sell imbalance (coordinated pump)", "warning", 0)); penalties.push(0.85); }
  if (pc24 < -80) { flags.push(makeFlag("Brutal dump 24h (-80%)", "critical", 0)); penalties.push(0.35); }
  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "dexscreener", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 2 — RugCheck ═══════════════════════════════════════════════════════

// Fix(DECEPTIVE_NAME): Tokens impersonating real financial institutions
const DECEPTIVE_NAME_PATTERNS: RegExp[] = [
  /\bvanguard\b/i, /\bblackrock\b/i, /\bgoldman\b/i, /\bfederal reserve\b/i,
  /\bjpmorgan\b/i, /\bmorgan stanley\b/i, /\bfidelity\b/i, /\bcitadel\b/i,
  /\bsequoia\b/i, /\ba16z\b/i, /\bberkshire\b/i, /\bdeutsche bank\b/i,
  /\bcredit suisse\b/i, /\bubs group\b/i, /\braymond james\b/i,
];

export function layerRugCheck(
  rugData: RugCheckSummary | null,
  rugReportData: RugCheckReport | null,
  resolvedMint: string,
  tokenName?: string | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false, safeBlocked = false;
  if (!rugData) return {
    source: "rugcheck", trust: 1.0, available: false,
    flags: [makeFlag("RugCheck unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };

  // Fix(DECEPTIVE_NAME): Flag tokens impersonating real-world financial institutions
  if (tokenName) {
    const isDeceptive = DECEPTIVE_NAME_PATTERNS.some(p => p.test(tokenName));
    if (isDeceptive) {
      flags.push(makeFlag(`Deceptive name — impersonates real institution: "${tokenName}"`, "critical", 0));
      penalties.push(0.20); safeBlocked = true;
    }
  }

  const bundleInReport = riskIncludes(rugReportData, /bundle/i);
  const bundledPct = bundleInReport ? extractBundlePct(rugReportData) : 0;
  if (bundleInReport && bundledPct > 0.20) {
    flags.push(makeFlag(`Bundle holds ~${Math.round(bundledPct * 100)}% of supply — coordinated buy/dump`, "critical", 0));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else if (bundleInReport && bundledPct > 0.05) {
    flags.push(makeFlag(`Bundle detected (~${Math.round(bundledPct * 100)}% of supply)`, "critical", 0));
    penalties.push(0.20); safeBlocked = true;
  } else if (bundleInReport) {
    flags.push(makeFlag("Bundle activity detected (RugCheck)", "critical", 0));
    penalties.push(0.20); forceRug = true; safeBlocked = true;
  }
  if (!bundleInReport && riskIncludes(rugData, /bundler|bundle/i)) {
    flags.push(makeFlag("Bundler detected (RugCheck summary)", "critical", 0));
    penalties.push(0.15); forceRug = true; safeBlocked = true;
  }
  if (rugData.lpBurned === true) {
    flags.push(makeFlag("LP Burned ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.10);
  } else if (rugData.lpLocked === true) {
    const days = getLpLockDurationDays(rugData);
    if (days > 180) { flags.push(makeFlag("LP Locked > 180 days ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
    else if (days > 0 && days < 30) { flags.push(makeFlag("LP lock duration < 30 days", "warning", 0)); penalties.push(0.75); }
  } else {
    const lpDataPresent =
      rugData.lpBurned === false ||
      rugData.lpLocked === false ||
      typeof rugData.lpLockDurationDays === "number" ||
      typeof rugData.lpLockDuration === "number" ||
      typeof rugData.lockDurationDays === "number";
    const isOfficialMint = OFFICIAL_MINTS.has(resolvedMint);
    if (lpDataPresent && !isOfficialMint) {
      // Fix(LP_SAFE_BLOCK): LP not burned or locked MUST block SAFE verdict.
      // Dev can pull liquidity at any time — this is a rug vector, not just a penalty.
      flags.push(makeFlag("LP not burned or locked — dev can rug liquidity", "warning", 0));
      penalties.push(0.70);
      safeBlocked = true;
    }
  }
  if (rugData.metaMutable === true) {
    flags.push(makeFlag("Metadata mutable", "warning", 0));
    penalties.push(0.82);
  }
  const top10 = asNumber(rugData?.topHolders?.top10Percentage);
  const top1 = asNumber(rugData?.topHolders?.top1Percentage ?? rugData?.topHolders?.top1HolderPercentage);
  if (top10 > 70) { flags.push(makeFlag("Top 10 holders > 70%", "critical", 0)); penalties.push(0.45); }
  else if (top10 > 50) { flags.push(makeFlag("Top 10 holders > 50%", "warning", 0)); penalties.push(0.70); }
  if (top1 > 20) { flags.push(makeFlag("Top 1 holder > 20%", "critical", 0)); penalties.push(0.45); }
  if (riskIncludes(rugReportData, /sniper/i)) { flags.push(makeFlag("Sniper activity detected", "critical", 0)); penalties.push(0.15); safeBlocked = true; }
  if (riskIncludes(rugReportData, /rug/i)) { flags.push(makeFlag("Rug pull history", "critical", 0)); penalties.push(0.15); forceRug = true; }
  if (riskIncludes(rugReportData, /creator.*sell|dev.*sell/i)) { flags.push(makeFlag("Dev wallet sold tokens", "warning", 0)); penalties.push(0.65); }
  if (rugData.mintAuthorityEnabled) { flags.push(makeFlag("Mint Authority enabled (RugCheck)", "critical", 0)); penalties.push(0.25); }
  if (rugData.freezeAuthorityEnabled) { flags.push(makeFlag("Freeze Authority enabled (RugCheck)", "critical", 0)); penalties.push(0.25); }
  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "rugcheck", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 3 — GoPlus ═════════════════════════════════════════════════════════
export function layerGoPlus(goplus: GoPlusTokenResult | null): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false;
  let safeBlocked = false;
  if (!goplus) return {
    source: "goplus", trust: 1.0, available: false,
    flags: [makeFlag("GoPlus unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };
  const gp = (field: keyof GoPlusTokenResult) => {
    const v = goplus[field];
    if (v === "1" || v === 1 || v === true) return true;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "yes") return true;
    }
    return false;
  };
  const gpNum = (field: keyof GoPlusTokenResult) => asNumber(goplus[field]);
  const authorityActive = (val: unknown) =>
    Boolean(val) && !["0","false","null",""].includes(String(val).trim().toLowerCase());
  if (gp("is_honeypot")) {
    flags.push(makeFlag("Honeypot detected — cannot sell", "critical", 0));
    trust = 0; forceRug = true; safeBlocked = true;
    return { source: "goplus", trust: 0, available: true, flags, forceRug, safeBlocked };
  }
  if (gp("cannot_sell_all")) {
    flags.push(makeFlag("Cannot sell all tokens", "critical", 0));
    trust = 0; forceRug = true; safeBlocked = true;
    return { source: "goplus", trust: 0, available: true, flags, forceRug, safeBlocked };
  }
  const hasMint = authorityActive(goplus.mint_authority);
  const hasFreeze = authorityActive(goplus.freeze_authority);
  if (hasMint && hasFreeze) {
    flags.push(makeFlag("Mint + Freeze authority both active", "critical", 0));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else {
    if (hasMint) { flags.push(makeFlag("Mint Authority enabled", "critical", 0)); penalties.push(0.25); }
    if (hasFreeze) { flags.push(makeFlag("Freeze Authority enabled", "critical", 0)); penalties.push(0.25); }
  }
  if (gp("is_blacklisted")) { flags.push(makeFlag("Blacklist capability", "critical", 0)); penalties.push(0.30); safeBlocked = true; }
  if (gp("transfer_pausable")) { flags.push(makeFlag("Transfer pausable", "critical", 0)); penalties.push(0.30); safeBlocked = true; }
  if (gp("hidden_owner")) { flags.push(makeFlag("Hidden owner detected", "critical", 0)); penalties.push(0.30); safeBlocked = true; }
  if (gp("is_proxy")) { flags.push(makeFlag("Upgradeable/proxy contract", "critical", 0)); penalties.push(0.50); safeBlocked = true; }
  const sellTaxRaw = gpNum("sell_tax");
  const buyTaxRaw  = gpNum("buy_tax");
  const sellTax = sellTaxRaw > 1 ? sellTaxRaw / 100 : sellTaxRaw;
  const buyTax  = buyTaxRaw  > 1 ? buyTaxRaw  / 100 : buyTaxRaw;
  if (sellTax > 0.10) { flags.push(makeFlag("Sell tax > 10%", "critical", 0)); penalties.push(0.35); }
  if (buyTax  > 0.10) { flags.push(makeFlag("Buy tax > 10%",  "critical", 0)); penalties.push(0.35); }
  // Fix(TAX_WARNING): Tax between 2% and 10% is a common rug mechanic — flag it.
  // VDOR had 4.5% sell tax which previously passed through completely undetected.
  if (sellTax > 0.02 && sellTax < 0.10) { flags.push(makeFlag(`Sell tax ${Math.round(sellTax * 100)}% — suspicious`, "warning", 0)); penalties.push(0.80); }
  if (buyTax  > 0.02 && buyTax  <= 0.10) { flags.push(makeFlag(`Buy tax ${Math.round(buyTax  * 100)}% — suspicious`,  "warning", 0)); penalties.push(0.80); }
  if (gpNum("owner_percent") > 0.05) { flags.push(makeFlag("Owner holds > 5%", "critical", 0)); penalties.push(0.50); }
  if (gpNum("creator_percent") > 0.05) { flags.push(makeFlag("Creator holds > 5%", "critical", 0)); penalties.push(0.50); }
  if (gp("is_mintable")) { flags.push(makeFlag("Token is mintable", "warning", 0)); penalties.push(0.60); }
  if (gp("slippage_modifiable")) { flags.push(makeFlag("Slippage/tax modifiable", "warning", 0)); penalties.push(0.75); }
  if (gp("is_anti_whale_modifiable")) { flags.push(makeFlag("Anti-whale rules modifiable", "warning", 0)); penalties.push(0.80); }
  if (gp("trading_cooldown")) { flags.push(makeFlag("Trading cooldown enabled", "warning", 0)); penalties.push(0.80); }
  if (gp("is_whitelisted")) { flags.push(makeFlag("Whitelist system detected", "warning", 0)); penalties.push(0.80); }
  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "goplus", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 4 — Helius ═════════════════════════════════════════════════════════
export function layerHelius(
  rawHolderAccounts: HeliusHolder[],
  totalSupplyUi: number
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false, safeBlocked = false;
  if (!rawHolderAccounts.length || !totalSupplyUi || totalSupplyUi <= 0) return {
    source: "helius", trust: 1.0, available: false,
    flags: [makeFlag("Helius unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };
  const accounts = rawHolderAccounts.filter(
    h => !LP_PROGRAM_ADDRESSES.has(h.owner) && !FOUNDATION_WALLETS.has(h.owner)
  );
  const top1Amount = asNumber(accounts[0]?.uiAmount);
  const top1Pct = top1Amount / totalSupplyUi;
  const top10Amount = accounts.slice(0, 10).reduce((s, h) => s + asNumber(h.uiAmount), 0);
  const top10Pct = top10Amount / totalSupplyUi;
  if (top1Pct > 0.3) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); penalties.push(0.08); forceRug = true; }
  else if (top1Pct > 0.2) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); penalties.push(0.25); safeBlocked = true; }
  else if (top1Pct > 0.1) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "warning", 0)); penalties.push(0.50); safeBlocked = true; }
  if (top10Pct > 0.8) { flags.push(makeFlag(`Top 10 wallets hold ${Math.round(top10Pct*100)}% of supply`, "critical", 0)); penalties.push(0.35); safeBlocked = true; }
  else if (top10Pct > 0.6) { flags.push(makeFlag(`Top 10 wallets hold ${Math.round(top10Pct*100)}% of supply`, "warning", 0)); penalties.push(0.55); safeBlocked = true; }
  else if (top10Pct < 0.3) { flags.push(makeFlag("Well distributed supply ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "helius", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 5 — Solscan ════════════════════════════════════════════════════════
export function layerSolscan(
  holderCount: number | null,
  tokenAgeHours: number | null,
  trades24h: number | null,
  traders24h: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false;
  let safeBlocked = false;
  const hasData = holderCount !== null || tokenAgeHours !== null;
  if (!hasData) return {
    source: "solscan", trust: 1.0, available: false,
    flags: [makeFlag("Solscan unavailable", "info", 0)],
    forceRug: false, safeBlocked: false,
  };
  if (holderCount !== null) {
    if (holderCount < 15) { flags.push(makeFlag("Very few holders (<15)", "critical", 0)); penalties.push(0.20); safeBlocked = true; }
    else if (holderCount < 50) { flags.push(makeFlag("Low holders (<50)", "warning", 0)); penalties.push(0.35); safeBlocked = true; }
    else if (holderCount > 5000) { flags.push(makeFlag("Strong holder base (5K+) ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
  }
  if (tokenAgeHours !== null) {
    if (tokenAgeHours < 0.5) { flags.push(makeFlag("Newborn token on-chain (<30min)", "critical", 0)); penalties.push(0.10); safeBlocked = true; }
    else if (tokenAgeHours < 1) { flags.push(makeFlag("Newborn token on-chain (<1h)", "critical", 0)); penalties.push(0.20); safeBlocked = true; }
    else if (tokenAgeHours < 6) { flags.push(makeFlag("Fresh token on-chain (<6h)", "warning", 0)); penalties.push(0.65); }
    else if (tokenAgeHours > 720) { flags.push(makeFlag("Established token (30d+) ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
  }
  let washTradingDetected = false;
  if (trades24h !== null && traders24h !== null && traders24h === 0 && trades24h > 0) {
    flags.push(makeFlag("Wash trading: trades with zero identified traders", "critical", 0));
    penalties.push(0.40); safeBlocked = true;
    washTradingDetected = true;
  }
  if (trades24h !== null && traders24h !== null && traders24h > 0) {
    const tradesPerTrader = trades24h / traders24h;
    if (tradesPerTrader > 50 && traders24h < 20) {
      flags.push(makeFlag("Wash trading suspected (trades/traders ratio)", "critical", 0));
      penalties.push(0.50); safeBlocked = true;
      washTradingDetected = true;
    } else if (traders24h > 500 && tradesPerTrader < 0.1) {
      flags.push(makeFlag("Bot-farmed holders: many accounts, near-zero activity", "warning", 0));
      penalties.push(0.70); safeBlocked = true;
    }
  }
  if (washTradingDetected && holderCount !== null && holderCount < 15 && tokenAgeHours !== null && tokenAgeHours < 0.5) {
    forceRug = true;
  }
  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "solscan", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 6 — Chart patterns ══════════════════════════════════════════════════
export function layerChart(
  candles: OHLCVCandle[],
  pair: DexScreenerPair | null,
  tokenAgeMinutes: number | null
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false, safeBlocked = false;
  if (!candles || candles.length < 3) return {
    source: "chart", trust: 1.0, available: false,
    flags: [], forceRug: false, safeBlocked: false,
  };
  const recent = candles.slice(-40);
  const closes = recent.map(c => c.c);
  const highs = recent.map(c => c.h);
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
  const liq = asNumber(pair?.liquidity?.usd);
  const vol24h = asNumber(pair?.volume?.h24);
  const vol1h = asNumber(pair?.volume?.h1);
  const pc5m = asNumber(pair?.priceChange?.m5);
  const pc1h = asNumber(pair?.priceChange?.h1);
  const pc24h = asNumber(pair?.priceChange?.h24);
  const v24Liq = liq > 0 ? vol24h / liq : 0;
  const v1hLiq = liq > 0 ? vol1h / liq : 0;

  // ── Existing patterns ──────────────────────────────────────────────────────
  if (greenRatio >= 0.82 && runUpPct >= 100 && pullbackRange <= 10) {
    flags.push(makeFlag("Crashcoin pattern: near-perfect parabolic chart", "critical", 0));
    penalties.push(0.35); safeBlocked = true;
  }
  if (pc5m > 35 && pc1h > 120) {
    flags.push(makeFlag("Vertical pump detected (+35% 5m / +120% 1h)", "warning", 0));
    penalties.push(0.55); safeBlocked = true;
  }
  if (v24Liq > 12 || v1hLiq > 4) {
    flags.push(makeFlag("Liquidity mirage: volume >> liquidity (wash)", "warning", 0));
    penalties.push(0.60); safeBlocked = true;
  }
  if (recent.length >= 10 && risingCount >= Math.floor(recent.length * 0.8) && returnStd < 3.5) {
    flags.push(makeFlag("Over-controlled chart: artificial stair-step", "warning", 0));
    penalties.push(0.65); safeBlocked = true;
  }
  if (drawdownFromPeak < -55) {
    flags.push(makeFlag("Blow-off top: price collapsed >55% from peak", "critical", 0));
    penalties.push(0.20); forceRug = true; safeBlocked = true;
  }
  if (tokenAgeMinutes !== null && tokenAgeMinutes < 90 && volumes.length >= 10) {
    const recentVol = volumes.slice(-5);
    const olderVol = volumes.slice(-10, -5);
    if (olderVol.length && _mean(recentVol) < _mean(olderVol) * 0.45 && last >= peak * 0.88) {
      flags.push(makeFlag("Early volume exhaustion near highs", "warning", 0));
      penalties.push(0.65); safeBlocked = true;
    }
    if (olderVol.length && _mean(olderVol) === 0 && _mean(recentVol) > 0) {
      flags.push(makeFlag("Sudden volume spike from zero — artificial pump", "warning", 0));
      penalties.push(0.60); safeBlocked = true;
    }
  }
  if (_pct(first, last) > 300 && greenRatio > 0.78) {
    flags.push(makeFlag("Parabolic launch: high risk exit liquidity setup", "warning", 0));
    penalties.push(0.60); safeBlocked = true;
  }
  if (pc24h < -60 && pc1h < -20) {
    flags.push(makeFlag("Active dump: -60% 24h + -20% 1h (slow rug)", "critical", 0));
    penalties.push(0.25); forceRug = true; safeBlocked = true;
  }

  // ── NEW v8 patterns — OHLCV rug fingerprints ───────────────────────────────

  // Pattern: Post-ATH dump >50% in last 3 candles = rug exit in progress
  if (closes.length >= 5) {
    const athIdx = closes.indexOf(Math.max(...closes));
    const isRecentATH = athIdx >= closes.length - 4;
    if (isRecentATH && peak > 0) {
      const dumpFromATH = (last - peak) / peak;
      if (dumpFromATH < -0.50) {
        flags.push(makeFlag(`Post-ATH dump ${Math.round(dumpFromATH * 100)}% — rug exit in progress`, "critical", 0));
        penalties.push(0.10); forceRug = true; safeBlocked = true;
      } else if (dumpFromATH < -0.35) {
        flags.push(makeFlag(`Post-ATH dump ${Math.round(dumpFromATH * 100)}% — exit liquidity pattern`, "warning", 0));
        penalties.push(0.40); safeBlocked = true;
      }
    }
  }

  // Pattern: Micro-window pump — +200% in last 10 candles with high green ratio
  if (closes.length >= 10) {
    const shortWindow = closes.slice(-10);
    const shortFirst = shortWindow[0], shortLast = shortWindow[shortWindow.length - 1];
    const shortGreenCount = shortWindow.filter((c, i) => i > 0 && c > shortWindow[i - 1]).length;
    const shortGreenRatio = shortGreenCount / (shortWindow.length - 1);
    if (_pct(shortFirst, shortLast) > 200 && shortGreenRatio > 0.80) {
      flags.push(makeFlag(`Micro-window pump: +${Math.round(_pct(shortFirst, shortLast))}% in 10 candles — coordinated launch`, "critical", 0));
      penalties.push(0.15); safeBlocked = true;
    }
  }

  // Pattern: Dead cat bounce — massive drop then partial recovery = distribution trap
  if (closes.length >= 8) {
    const midWindow = closes.slice(-8);
    const midMin = Math.min(...midWindow.slice(0, 4));
    const midStart = midWindow[0];
    const midEnd = midWindow[midWindow.length - 1];
    const dropPct = midStart > 0 ? (midMin - midStart) / midStart : 0;
    const recoveryPct = midMin > 0 ? (midEnd - midMin) / midMin : 0;
    if (dropPct < -0.50 && recoveryPct > 0.60 && midEnd < midStart * 0.85) {
      flags.push(makeFlag("Dead cat bounce: -50% drop then partial recovery — distribution trap", "warning", 0));
      penalties.push(0.45); safeBlocked = true;
    }
  }

  // Pattern: Rug staircase — volume decaying 3 consecutive windows while price holds
  // Classic controlled dump: team drips sells while bots keep price flat
  if (volumes.length >= 15) {
    const v1 = _mean(volumes.slice(-15, -10));
    const v2 = _mean(volumes.slice(-10, -5));
    const v3 = _mean(volumes.slice(-5));
    const priceFlat = Math.abs(_pct(closes[closes.length - 15] ?? closes[0], last)) < 15;
    if (v1 > 0 && v2 < v1 * 0.60 && v3 < v2 * 0.60 && priceFlat) {
      flags.push(makeFlag("Rug staircase: volume collapsing while price held flat — controlled dump", "warning", 0));
      penalties.push(0.55); safeBlocked = true;
    }
  }

  // Pattern: Candle wick trap — high wicks with closing near lows = repeated sells at highs
  if (recent.length >= 5) {
    const lastCandles = recent.slice(-5);
    const wickTrapCount = lastCandles.filter(c => {
      const range = c.h - c.l;
      const upperWick = c.h - Math.max(c.o, c.c);
      return range > 0 && (upperWick / range) > 0.70;
    }).length;
    if (wickTrapCount >= 3) {
      flags.push(makeFlag("Wick trap: 3+ candles with dominant upper wick — repeated selling at highs", "warning", 0));
      penalties.push(0.65); safeBlocked = true;
    }
  }

  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "chart", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 7 (CrossValidation, formerly Layer 8) ════════════════════════════
export function layerCrossValidation(
  rugData: RugCheckSummary | null,
  rawHolderAccounts: HeliusHolder[],
  goplus: GoPlusTokenResult | null,
  solscanAgeHours: number | null,
  dexAgeHours: number | null,
  totalSupplyUi: number = 0
): LayerResult {
  const flags: ScanFlag[] = [];
  const forceRug = false;
  let safeBlocked = false;
  if (rugData?.lpBurned === true) {
    const lpStillActive = rawHolderAccounts.some(h => LP_PROGRAM_ADDRESSES.has(h.owner));
    if (lpStillActive) {
      flags.push(makeFlag("LP burn conflict: RugCheck vs on-chain data", "warning", 0));
      safeBlocked = true;
    }
  }
  if (goplus && rugData) {
    const gpMint = goplus.mint_authority;
    const gpOff = ["0","false","null",""].includes(String(gpMint).trim().toLowerCase());
    if (gpOff && rugData.mintAuthorityEnabled === true) {
      flags.push(makeFlag("Mint authority conflict: GoPlus vs RugCheck", "warning", 0));
      safeBlocked = true;
    }
  }
  if (solscanAgeHours !== null && dexAgeHours !== null) {
    if (Math.abs(solscanAgeHours - dexAgeHours) > 72)
      flags.push(makeFlag("Token age conflict between sources (>72h diff)", "info", 0));
  }
  if (rugData?.topHolders?.top10Percentage && rawHolderAccounts.length > 0) {
    const rugTop10 = asNumber(rugData.topHolders.top10Percentage);
    const heliusAccounts = rawHolderAccounts.filter(
      h => !LP_PROGRAM_ADDRESSES.has(h.owner) && !FOUNDATION_WALLETS.has(h.owner)
    );
    const heliusTop10Pct = totalSupplyUi > 0
      ? (heliusAccounts.slice(0, 10).reduce((s, h) => s + asNumber(h.uiAmount), 0) / totalSupplyUi) * 100
      : 0;
    if (Math.abs(rugTop10 - heliusTop10Pct) > 25) {
      flags.push(makeFlag("Holder concentration conflict between RugCheck and Helius", "warning", 0));
      safeBlocked = true;
    }
  }
  return { source: "crossvalidation", trust: 1.0, available: true, flags, forceRug, safeBlocked };
}
