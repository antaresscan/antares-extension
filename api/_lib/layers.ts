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
import { getLpRiskBucket } from "./lp-risk-matrix";
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
  } else if (pc6 < -30) {
    flags.push(makeFlag(`Sharp 6h sell-off (${Math.round(pc6)}%)`, "warning", 0));
    penalties.push(0.55); safeBlocked = true;
  }
  if (!hasWebsite && !hasTwitter && !hasTelegram) { flags.push(makeFlag("No website / Twitter / Telegram — high rug risk", "critical", 0)); penalties.push(0.60); safeBlocked = true; }
  if (txns5m < 5 && mc > 50000 && ageMinutes < 1440) { flags.push(makeFlag("Low 5m transactions vs market cap", "warning", 0)); penalties.push(0.88); }
  if ((sells5m === 0 && buys5m > 0 && txns5m > 5) || (sells5m > 0 && buys5m > sells5m * 5)) { flags.push(makeFlag("Buy/sell imbalance (coordinated pump)", "warning", 0)); penalties.push(0.85); }
  if (pc24 < -80) {
    flags.push(makeFlag("Brutal dump 24h (-80%)", "critical", 0));
    penalties.push(0.35); safeBlocked = true;
  } else if (pc24 < -40) {
    flags.push(makeFlag(`Significant 24h dump (${Math.round(pc24)}%)`, "warning", 0));
    penalties.push(0.50); safeBlocked = true;
  }

  // Fix(EXTREME_PUMP_24H): Tokens with +1000% to +5000% 24h are exit traps — TRAP, KERMIT, HOUSETOUR pattern
  // DeFade flags these as HIGH/CRITICAL risk; Antares was letting them pass as SAFE
  if (pc24 > 5000) {
    flags.push(makeFlag(`Extreme 24h pump +${Math.round(pc24)}% — exit liquidity trap`, "critical", 0));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else if (pc24 > 1000) {
    flags.push(makeFlag(`Extreme 24h pump +${Math.round(pc24)}% — high risk exit trap`, "critical", 0));
    penalties.push(0.15); safeBlocked = true;
  } else if (pc24 > 500 && ageMinutes < 1440) {
    flags.push(makeFlag(`Large 24h pump +${Math.round(pc24)}% on token <24h`, "warning", 0));
    penalties.push(0.55); safeBlocked = true;
  }
  // ── SLOW RUG / PROGRESSIVE DECLINE PATTERNS ───────────────────────────────
  // These cover the space between the fast-rug thresholds above (pc6 < -50%,
  // pc24 < -80%) and normal market noise. Order: pump reversal first (most
  // specific signal), then progressive two-timeframe decline (combo), then
  // coordinated exit (micro-level sell pressure).

  // Pump-and-dump reversal: token was significantly up over 24h but is now
  // losing hard in 6h — classic PnD timeline where the dump phase has started.
  if (pc24 > 80 && pc6 < -20) {
    flags.push(makeFlag(`Pump reversal: +${Math.round(pc24)}% (24h) → ${Math.round(pc6)}% (6h)`, "critical", 0));
    penalties.push(0.30); safeBlocked = true;
  }

  // Progressive multi-timeframe decline: both 6h and 24h are meaningfully
  // negative but below the standalone thresholds (< -30% and < -40%).
  // Two timeframes confirming each other = ongoing distribution, not a blip.
  if (pc6 < -20 && pc6 > -30 && pc24 < -25 && pc24 > -40) {
    flags.push(makeFlag(`Progressive dump: ${Math.round(pc6)}% (6h) + ${Math.round(pc24)}% (24h)`, "warning", 0));
    penalties.push(0.55); safeBlocked = true;
  }

  // Coordinated exit: price is declining in the last hour AND sells are
  // dominating buys 3-to-1 in the current 5-minute window — typical of
  // organised wallet groups rotating out.
  if (pc1 < -8 && sells5m > buys5m * 3 && txns5m > 10) {
    flags.push(makeFlag(`Coordinated exit: price ${Math.round(pc1)}% + sells 3× buys`, "warning", 0));
    penalties.push(0.65); safeBlocked = true;
  }

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
  tokenName?: string | null,
  maturityContext?: { holders: number | null; liquidity: number; tokenAgeHours: number | null; mintAuthority: boolean; freezeAuthority: boolean; honeypot: boolean; lpPctOfSupply?: number | null }
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
            // Mature classification with OR'd maturity signals. Previous
            // gate AND'd holders + liq + age, which collapsed mid-cap
            // tokens like NEET (10k holders + $1.34M liq + age unknown)
            // straight to DANGER because tokenAgeHours was undefined.
            // The OR-gate keeps the strict-on-fresh-launches behaviour
            // (a token with <5k holders AND <$500k liq AND <14d age
            // still hits the hard branch) while letting any single
            // strong maturity signal route to soft lp_unverified
            // (CAUTION ceiling).
            //
            // The contract-clean check (no mint/freeze/honeypot) still
            // ANDs because those are real exit attacks — never let them
            // soft-unlock regardless of age/size.
            const ctx = maturityContext;
            const contractClean = !ctx || (!ctx.mintAuthority && !ctx.freezeAuthority && !ctx.honeypot);
            // 2-axis LP risk matrix: (LP % of supply) × (token age).
            // See api/_lib/lp-risk-matrix.ts for the full rationale. The
            // single binary "is LP locked?" flag was producing too many false
            // positives on mature tokens (BONK, WIF) AND false negatives on
            // fresh tokens with formally-locked-but-100%-of-supply pools.
            //
            // If the contract is NOT clean (mint/freeze/honeypot enabled),
            // we treat the matrix output as if it were the highest-risk
            // bucket — those are real exit attacks that override any
            // time-based trust signal.
            const bucket = getLpRiskBucket(ctx?.lpPctOfSupply ?? null, ctx?.tokenAgeHours ?? null);
            if (!contractClean) {
                // Contract has mint/freeze/honeypot → ignore the matrix's
                // age relaxations and treat LP as hard rug vector. The
                // contract-attack vector dominates regardless of LP %.
                flags.push(makeFlag("LP not burned or locked — dev can rug liquidity (contract not clean)", "critical", 0));
                penalties.push(0.65);
                safeBlocked = true;
            } else {
                flags.push(makeFlag(bucket.flagLabel, bucket.severity, 0));
                penalties.push(bucket.penalty);
                if (bucket.safeBlock) safeBlocked = true;
                if (bucket.forceRug) forceRug = true;
            }
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
export function layerGoPlus(
  goplus: GoPlusTokenResult | null,
  // Mirror layerRugCheck: when LP is unburned, mature tokens deserve the
  // soft 'unverified LP' flag (CAUTION) instead of the hard 'dev can rug'
  // flag (DANGER). Without this context, every legit established token
  // with team-managed LP collapsed to DANGER on the goplus path even
  // though rugcheck classified it as soft.
  maturityContext?: { holders: number | null; liquidity: number; tokenAgeHours: number | null; mintAuthority: boolean; freezeAuthority: boolean; honeypot: boolean; lpPctOfSupply?: number | null }
): LayerResult {
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
  // VDOR had 4.5% tax which previously passed through completely undetected.
  if (sellTax > 0.02 && sellTax <= 0.10) { flags.push(makeFlag(`Sell tax ${Math.round(sellTax * 100)}% — suspicious`, "warning", 0)); penalties.push(0.80); }
  if (buyTax  > 0.02 && buyTax  <= 0.10) { flags.push(makeFlag(`Buy tax ${Math.round(buyTax  * 100)}% — suspicious`,  "warning", 0)); penalties.push(0.80); }
  if (gpNum("owner_percent") > 0.05) { flags.push(makeFlag("Owner holds > 5%", "critical", 0)); penalties.push(0.50); }
  if (gpNum("creator_percent") > 0.05) { flags.push(makeFlag("Creator holds > 5%", "critical", 0)); penalties.push(0.50); }
  if (gp("is_mintable")) { flags.push(makeFlag("Token is mintable", "warning", 0)); penalties.push(0.60); }
  if (gp("slippage_modifiable")) { flags.push(makeFlag("Slippage/tax modifiable", "warning", 0)); penalties.push(0.75); }
  if (gp("is_anti_whale_modifiable")) { flags.push(makeFlag("Anti-whale rules modifiable", "warning", 0)); penalties.push(0.80); }
  if (gp("trading_cooldown")) { flags.push(makeFlag("Trading cooldown enabled", "warning", 0)); penalties.push(0.80); }
  if (gp("is_whitelisted")) { flags.push(makeFlag("Whitelist system detected", "warning", 0)); penalties.push(0.80); }

          // Fix(LP_GOPLUS): LP burn/lock detection using GoPlus dex[].burn_percent
    // RugCheck does NOT return lpBurned/lpLocked booleans — only lpLockedPct which is unreliable
    // GoPlus dex[] array provides accurate burn_percent per pool
    if (goplus.dex && Array.isArray(goplus.dex) && goplus.dex.length > 0) {
        const maxBurnPct = Math.max(...goplus.dex.map(d => typeof d.burn_percent === "number" ? d.burn_percent : 0));
        if (maxBurnPct >= 50) {
            flags.push(makeFlag(`LP Burned ${Math.round(maxBurnPct)}% (GoPlus) ✓`, "bonus", 0));
            trust = Math.min(1.0, trust * 1.10);
        } else if (maxBurnPct >= 1) {
            flags.push(makeFlag(`LP partially burned ${Math.round(maxBurnPct)}% — not fully secured`, "warning", 0));
            penalties.push(0.80);
        } else {
            // Same maturity classification as layerRugCheck. A mature,
            // liquid, well-distributed token whose LP isn't burned still
            // carries rug-able liquidity, but the operational risk is
            // qualitatively different from a fresh launch — flag it as
            // 'unverified LP' (soft, CAUTION) rather than 'dev can rug'
            // (hard, DANGER). Keep both arms safeBlocked so the safe
            // gate still trips; the soft reason just reroutes the gate
            // to the CAUTION branch in scoring.classifySafeBlockedReasons.
            // Mirrors layerRugCheck: OR'd maturity gate. Single strong
            // signal (5k+ holders OR $500k+ liq OR 14d+ age) is enough
            // to route LP-unverified to the soft path, provided the
            // contract itself is clean. See the comment in layerRugCheck
            // for the full rationale.
            const ctx = maturityContext;
            const contractClean = !ctx || (!ctx.mintAuthority && !ctx.freezeAuthority && !ctx.honeypot);
            // Same 2-axis LP risk matrix as layerRugCheck — see
            // api/_lib/lp-risk-matrix.ts. Mirrored here for the GoPlus
            // burn-percent path so the verdict is consistent regardless
            // of which upstream resolved the LP-burned signal first.
            const bucket = getLpRiskBucket(ctx?.lpPctOfSupply ?? null, ctx?.tokenAgeHours ?? null);
            if (!contractClean) {
                flags.push(makeFlag("LP not burned or locked — dev can rug liquidity (contract not clean)", "critical", 0));
                penalties.push(0.65);
                safeBlocked = true;
            } else {
                flags.push(makeFlag(bucket.flagLabel, bucket.severity, 0));
                penalties.push(bucket.penalty);
                if (bucket.safeBlock) safeBlocked = true;
                if (bucket.forceRug) forceRug = true;
            }
        }
    }
  trust = applyDiminishingPenalties(trust, penalties);
  return { source: "goplus", trust: Math.max(0, trust), available: true, flags, forceRug, safeBlocked };
}

// ═══ LAYER 4 — Helius ═════════════════════════════════════════════════════════
export function layerHelius(
  rawHolderAccounts: HeliusHolder[],
  totalSupplyUi: number,
  // Maturity context lets layerHelius soften the concentration trust
  // penalty for established memecoins. A 35% top-1 wallet on a token
  // with 164k holders + LP burned + 2 years on chain is virtually
  // never a rug pattern — it's an exchange / treasury / legit whale.
  // Without context, the geometric-mean dragged MEW (and other blue
  // chips) into DANGER even when every other layer was clean.
  maturityContext?: { holders: number | null; liquidity: number; tokenAgeHours: number | null; mintAuthority: boolean; freezeAuthority: boolean; honeypot: boolean; lpBurned?: boolean | null; lpPctOfSupply?: number | null }
): LayerResult {
  const flags: ScanFlag[] = [];
  let trust = 1.0;
  const penalties: number[] = [];
  let forceRug = false;
  let safeBlocked = false;
  if (!rawHolderAccounts.length || !totalSupplyUi || totalSupplyUi <= 0) {
    // ── Helius unavailable: refuse to claim SAFE ───────────────────────────
    // Earlier behaviour: trust=1.0 + safeBlocked=false. That made
    // every Helius-down scan land at 1000/1000 SAFE — even on tokens
    // where the LAST KNOWN scan flagged 11% wallet concentration. The
    // user reported PENGU rendering SAFE while the timeline tab still
    // showed CAUTION 786/1000 from 3 days earlier (same data
    // availability, same bug — happened with FARTCOIN before).
    //
    // The honest answer when this layer's data is missing: we don't
    // know. Set safeBlocked=true so the verdict caps at CAUTION
    // regardless of how clean the other layers look. Drop trust to
    // 0.82 so the geometric-mean score reflects the uncertainty
    // (clean other layers → ~820/1000, banded as CAUTION). Bump the
    // flag severity from "info" to "warning" so it surfaces in the
    // Critical Flags panel and the user sees WHY the verdict isn't
    // SAFE.
    //
    // Trade-off: tokens that are genuinely safe will show CAUTION
    // when Helius is having a bad day. That's the right error mode —
    // false-CAUTION is a worse-case-of-extra-research, false-SAFE
    // can lose the user money on a hidden 11%-whale token.
    return {
      source: "helius", trust: 0.82, available: false,
      flags: [
        makeFlag(
          "Helius unavailable — holder concentration unverified",
          "warning", 0,
        ),
      ],
      forceRug: false, safeBlocked: true,
    };
  }
  const accounts = rawHolderAccounts.filter(
    h => !LP_PROGRAM_ADDRESSES.has(h.owner) && !FOUNDATION_WALLETS.has(h.owner)
  );
  const top1Amount = asNumber(accounts[0]?.uiAmount);
  const top1Pct = top1Amount / totalSupplyUi;
  const top10Amount = accounts.slice(0, 10).reduce((s, h) => s + asNumber(h.uiAmount), 0);
  const top10Pct = top10Amount / totalSupplyUi;
  // Single-wallet concentration ladder. Bands map to scoring outcomes
  // via the safe-gate path:
  //   >30% → critical, hard concentration block, very heavy penalty.
  //          Concentration alone is no longer forceRug — the
  //          forceRug slam was over-flagging legitimate blue-chip
  //          memecoins like MEW (164k holders + LP burned + a 35%
  //          whale) as RUG. Keep the safeBlocked + hard reason so
  //          the safe gate trips, but let Path 3 decide whether
  //          blue-chip signals warrant CAUTION rather than RUG.
  //          forceRug stays reserved for honeypot / deceptive-name
  //          patterns (absolute kills regardless of context).
  //   >20% → critical, hard concentration block (DANGER/RUG)
  //   >15% → critical, hard concentration block (DANGER/RUG)
  //   >10% → warning, soft block + heavy trust penalty (CAUTION). The
  //          0.30 trust multiplier here is intentionally aggressive so
  //          score drops below 900 even with bonuses on other layers.
  // Track the top-1 band so the maturity dampening below knows whether
  // it's allowed to lift the score back up to SAFE. Above 10% we keep
  // the geometric-mean penalty regardless of holder count: a single
  // wallet at 11% can still crash the price even on a 164k-holder token.
  // Using string for openness — we only care about the >=10% threshold
  // for the lift gate.
  let top1ConcentrationBand: string = "none";
  if (top1Pct > 0.3) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); penalties.push(0.08); safeBlocked = true; top1ConcentrationBand = "extreme"; }
  else if (top1Pct > 0.2) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); penalties.push(0.20); safeBlocked = true; top1ConcentrationBand = "heavy"; }
  else if (top1Pct > 0.15) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "critical", 0)); penalties.push(0.35); safeBlocked = true; top1ConcentrationBand = "heavy"; }
  else if (top1Pct > 0.1) { flags.push(makeFlag(`Single wallet holds ${Math.round(top1Pct*100)}% of supply`, "warning", 0)); penalties.push(0.30); safeBlocked = true; top1ConcentrationBand = "elevated"; }
  if (top10Pct > 0.8) { flags.push(makeFlag(`Top 10 wallets hold ${Math.round(top10Pct*100)}% of supply`, "critical", 0)); penalties.push(0.30); safeBlocked = true; }
  else if (top10Pct > 0.6) { flags.push(makeFlag(`Top 10 wallets hold ${Math.round(top10Pct*100)}% of supply`, "warning", 0)); penalties.push(0.45); safeBlocked = true; }
  else if (top10Pct < 0.3) { flags.push(makeFlag("Well distributed supply ✓", "bonus", 0)); trust = Math.min(1.0, trust * 1.05); }
  trust = applyDiminishingPenalties(trust, penalties);

  // ── Concentration kill-switch — top1 > 30% on non-blue-chip tokens ─
  // ALSO triggers on extreme top10 concentration (>80%) — a token
  // where 10 wallets control 80%+ of supply is structurally a rug.
  //
  // Reference cases:
  //   HAWK (top-1 31%, top-10 87%, 7k holders) → forceRug ✓
  //   HORNY (similar profile) → forceRug ✓
  //   PIPPIN (27% top-1, ~10k holders) → stays DANGER (under threshold)
  //   MEW (35% top-1, 164k holders) → blue-chip shield, no forceRug ✓
  //
  // The 50k-holder cutoff protects real established memecoins (MEW
  // has a 35% top-1 wallet that's an exchange / treasury, not a rug
  // operator). For everything below that, top-1 > 30% OR top-10 > 80%
  // IS the rug pattern.
  //
  // GOAT/PNUT (broken-data 20-holder reports from Solscan) are caught
  // by the data-quality fallback below which clears forceRug too.
  {
    const mcRug = maturityContext;
    const isBlueChipDistribution = (mcRug?.holders ?? 0) >= 50_000;
    const extremeTop1 = top1Pct > 0.3;
    const extremeTop10 = top10Pct > 0.8;
    if ((extremeTop1 || extremeTop10) && !isBlueChipDistribution) {
      forceRug = true;
    }
  }

  // ── Maturity dampening ────────────────────────────────────────────
  // For established memecoins (50k+ holders, 30d+, LP burned) with
  // WELL-DISTRIBUTED supply (top-1 < 10%), the concentration penalty
  // above is over-stated and we let the score recover. But if top-1
  // is ≥ 10% we KEEP the penalty: a single wallet at 11%+ can crash
  // the price regardless of how mature the rest of the token looks
  // — the user-facing verdict has to stay CAUTION. Floors:
  //   holders ≥ 100k + LP burned + 30d + top1 < 10%  → trust ≥ 0.65
  //   holders ≥ 50k  + LP burned + 30d + top1 < 10%  → trust ≥ 0.50
  //   holders ≥ 10k  + LP burned + 30d + top1 < 10%  → trust ≥ 0.35
  //   top1 ≥ 10% on any token                        → no dampening
  // The flags + safeBlocked stay so Path 3 / DAO allowlist still gates
  // the safe verdict on additional signals; we're only protecting the
  // geometric-mean score from collapsing on a single concentration cue.
  const mc = maturityContext;
  if (mc) {
    const looksMatureBase = (mc.tokenAgeHours ?? 0) >= 30 * 24 && mc.lpBurned === true;
    const concentrationAllowsLift = top1ConcentrationBand === "none" || top1ConcentrationBand === "soft";
    if (looksMatureBase && concentrationAllowsLift) {
      if ((mc.holders ?? 0) >= 100_000) trust = Math.max(trust, 0.65);
      else if ((mc.holders ?? 0) >= 50_000) trust = Math.max(trust, 0.50);
      else if ((mc.holders ?? 0) >= 10_000) trust = Math.max(trust, 0.35);
    }

    // ── Data-quality fallback ──────────────────────────────────────
    // Some upstream sources report a tiny holder count (<200) on
    // tokens that DexScreener shows as $10M+ market cap with deep
    // liquidity — that's structurally impossible for a real low-
    // holder shitcoin (you can't have $50M mcap with 20 holders),
    // so the holder/concentration view is BROKEN, not damning.
    //
    // When the data is broken we MUST suppress the concentration
    // flag too — emitting "Single wallet holds 99% of supply" is
    // factually wrong on a token with 100k+ real holders, and the
    // text gets classified as `concentration` (hard) by scoring.ts,
    // capping the score to 500. We replace it with an info flag and
    // clear safeBlocked so Path 1/2 can evaluate the macro signals.
    //
    // Triggers on tokens like GOAT/PNUT where Solscan/Helius only see
    // pump.fun bonding-curve survivors (~20 wallets) instead of all
    // 100k+ holders post-AMM-migration.
    const macroLooksBig =
      (mc.liquidity ?? 0) >= 250_000 &&
      (mc.tokenAgeHours ?? 0) >= 30 * 24;
    const reportedHoldersTooLow = (mc.holders ?? Infinity) < 200;
    if (macroLooksBig && reportedHoldersTooLow) {
      // Drop the misleading concentration flags; emit one info flag.
      const concentrationLabel = /supply/i;
      for (let i = flags.length - 1; i >= 0; i--) {
        if (concentrationLabel.test(flags[i].label)) flags.splice(i, 1);
      }
      flags.push(makeFlag("Holder data unreliable (broken upstream view) — mature pair, deep liquidity", "info", 0));
      trust = Math.max(trust, 0.40);
      safeBlocked = false; // We can't trust the broken concentration signal.
      forceRug = false;    // Same — broken concentration data must not slam the verdict to RUG.
    }
  }

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
  tokenAgeMinutes: number | null,
  // Maturity context lets layerChart suppress safeBlock on chart
  // patterns that are common in established memecoins during
  // consolidation phases (rug staircase, slow bleed). Without this,
  // legit blue-chips like FWOG/NEET get capped at score 500 because
  // chart pattern detectors mistake quiet sideways trading for
  // controlled dumps.
  maturityContext?: { holders: number | null; liquidity: number; tokenAgeHours: number | null; mintAuthority: boolean; freezeAuthority: boolean; honeypot: boolean; lpBurned?: boolean | null; lpPctOfSupply?: number | null }
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

  // ── Sustained 24h pump — high retrace risk on entry ──────────────────────────
  // The "Vertical pump" above catches launch-scam micro-pumps (5m+1h
  // window). This pattern complements it by catching slower, multi-hour
  // pumps typical of mature blue-chip memecoins riding momentum
  // (TROLL +200% in a day, FWOG +150%, etc.) — the contract is still
  // safe but the trader is buying at a local top, and retrace risk is
  // disproportionate.
  //
  // Calibration (per user feedback 2026-05-19): a pumping blue-chip is
  // not a "broken" token, so the penalty must stay light enough that
  // the verdict never falls below CAUTION on this signal alone. We
  // pair `safeBlock` (force the verdict to CAUTION minimum so the
  // trader sees the warning surfaced in the badge) with a SMALL score
  // penalty (≈ -100 to -150 pts on a 1000 base), so the verdict caps
  // at CAUTION without skidding into DANGER unless OTHER layers also
  // flag the token. For non-mature tokens the same magnitude is far
  // more dangerous (thin LP = retrace becomes a dump): stronger
  // penalties + safeBlock fire as before.
  //
  // 5m/1h vertical pumps already fire above with stronger penalties +
  // safeBlock, so a launch scam doesn't double-count — it's caught
  // upstream. This pattern is for the "rode the wave for hours" case.
  if (pc24h >= 100) {
    const mcP = maturityContext;
    const matureForPump =
      (mcP?.holders ?? 0) >= 5_000 ||
      ((mcP?.tokenAgeHours ?? 0) >= 90 * 24 && (mcP?.liquidity ?? 0) >= 500_000);
    const pumpPct = Math.round(pc24h);

    if (matureForPump) {
      // Mature pair (blue-chip memecoin / established token). Retrace
      // is a real risk but the structural fundamentals haven't changed.
      // safeBlock on ≥ 200% forces the verdict to CAUTION minimum;
      // small penalty keeps it from falling further into DANGER on
      // this signal alone. < 200% stays info-only (no safeBlock,
      // tiny penalty) so a 100-200% climb on a blue-chip surfaces
      // visibly but doesn't force the verdict down.
      if (pc24h >= 200) {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — elevated retrace risk on entry (blue-chip)`, "warning", 0));
        penalties.push(0.85); safeBlocked = true;
      } else {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — moderate retrace risk on entry (blue-chip)`, "info", 0));
        penalties.push(0.92);
      }
    } else {
      // Non-mature token. Sustained pump + thin LP = exit-liquidity
      // trap shape. SafeBlock so the verdict can't return SAFE while
      // pointing at this risk; heavier penalties as the LP gets
      // thinner relative to the pump magnitude.
      if (pc24h >= 300) {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — exit liquidity risk on thin LP`, "warning", 0));
        penalties.push(0.45); safeBlocked = true;
      } else if (pc24h >= 200) {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — entering at local top (thin LP)`, "warning", 0));
        penalties.push(0.55); safeBlocked = true;
      } else {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — elevated retrace risk on entry`, "warning", 0));
        penalties.push(0.70);
      }
    }
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
    // Mature pairs (5k+ holders OR 90d+ age with $500k+ liquidity) routinely
    // sit -60–80% below a local 40-candle peak — that's normal volatility,
    // not a rug. AURA (DtR4...k9B2) was the canary: 2 years old, $1.95M LP,
    // all four binary safety checks clean, +133% 24h, but it still got
    // forceRug'd because the local peak in the recent window happened to
    // be >55% above the current close. Same shape applies to any blue-chip
    // memecoin in a normal correction.
    //
    // Fix: drop forceRug from this single signal. A 55% drawdown alone is
    // not a rug pull — that's an exit-scam term reserved for LP drained,
    // mint authority used, freeze active, or honeypot. Keep severity
    // critical + safeBlock + penalty for non-mature tokens (where the
    // signal still feeds into the cumulative score and will land DANGER /
    // RUG when paired with the other rug fingerprints in this layer and
    // in cross-validation). For mature pairs, demote to info-only — no
    // penalty cap, no hard verdict override, no chart-only false rug.
    const mc = maturityContext;
    const looksMature =
      (mc?.holders ?? 0) >= 5_000 ||
      ((mc?.tokenAgeHours ?? 0) >= 90 * 24 && (mc?.liquidity ?? 0) >= 500_000);
    if (looksMature) {
      flags.push(makeFlag("Drawdown >55% from local peak (mature pair, normal volatility)", "info", 0));
    } else {
      flags.push(makeFlag("Blow-off top: price collapsed >55% from peak", "critical", 0));
      penalties.push(0.20); safeBlocked = true;
    }
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

  // Pattern 1: Post-ATH dump >50% in last 4 candles = rug exit in progress
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

  // Pattern 2: Micro-window pump — +200% in last 10 candles with high green ratio
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

  // Pattern 3: Dead cat bounce — massive drop then partial recovery = distribution trap
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

  // Pattern 4: Rug staircase — volume decaying 3 consecutive windows while price holds.
  // For established memecoins (5k+ holders OR (90d+ AND $500k+ liq)),
  // a slow volume decay during consolidation is normal market behaviour,
  // not a controlled dump. Demote to soft flag (no safeBlock) so the
  // score isn't clipped to 500 on FWOG/NEET-style mature consolidations.
  if (volumes.length >= 15) {
    const v1 = _mean(volumes.slice(-15, -10));
    const v2 = _mean(volumes.slice(-10, -5));
    const v3 = _mean(volumes.slice(-5));
    const priceFlat = Math.abs(_pct(closes[closes.length - 15] ?? closes[0], last)) < 15;
    if (v1 > 0 && v2 < v1 * 0.60 && v3 < v2 * 0.60 && priceFlat) {
      const mc = maturityContext;
      const looksMature =
        (mc?.holders ?? 0) >= 5_000 ||
        ((mc?.tokenAgeHours ?? 0) >= 90 * 24 && (mc?.liquidity ?? 0) >= 500_000);
      if (looksMature) {
        flags.push(makeFlag("Volume tapering during consolidation (mature pair)", "info", 0));
        penalties.push(0.85);
      } else {
        flags.push(makeFlag("Rug staircase: volume collapsing while price held flat — controlled dump", "warning", 0));
        penalties.push(0.55); safeBlocked = true;
      }
    }
  }

  // Pattern 5: Candle wick trap — high wicks with closing near lows = repeated sells at highs
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
