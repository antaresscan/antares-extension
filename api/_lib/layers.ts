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
  PUMP_7D_WARN_PCT, PUMP_7D_HIGH_PCT, PUMP_30D_WARN_PCT, PUMP_30D_HIGH_PCT,
  LP_UNVERIFIED_MIN_LIQUIDITY,
} from "./constants";
import { getLpRiskBucket } from "./lp-risk-matrix";
import { asNumber, _mean, _std, _pct } from "./math";
import { makeFlag, getLpLockDurationDays, riskIncludes, ageTieredPoints, penaltyToPoints } from "./helpers";
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

  // Liquidity band (scoring ledger #12): thin liquidity is real risk but
  // token-age-independent noise — no force rug, no age scale.
  if (liq < 1000) { flags.push(makeFlag("Very low liquidity (<$1k)", "critical", 500)); penalties.push(0.25); }
  else if (liq < 5000) { flags.push(makeFlag("Low liquidity (<$5k)", "warning", 250)); penalties.push(0.65); }
  else if (liq < 20000) { flags.push(makeFlag("Liquidity < $20k", "info", 125)); penalties.push(0.90); }

  if (liq === 0 && vol > 10000) {
    // Ledger #2: pool abandoned — no counterparty to sell into. FORCE RUG.
    flags.push(makeFlag("Volume with zero liquidity — abandoned pool", "critical", 700));
    penalties.push(0.10); forceRug = true; safeBlocked = true;
  } else if (liq > 0 && vol / liq > 15) {
    // Ledger #13 (>15×): downgraded from forceRug — the ratio depends on
    // DexScreener's liquidity figure, which fluctuates ±20% between API
    // calls, so forcing the harshest verdict off a noisy metric risked
    // false-RUGs on volatile-but-legitimate tokens. Still a strong signal
    // (behavioral, needs corroboration to reach DANGER on its own via the
    // 2+ behavioral-critical floor) and always blocks SAFE.
    flags.push(makeFlag("High vol/liquidity ratio (>15×) — wash volume", "critical", 550, "behavioral"));
    penalties.push(0.20); safeBlocked = true;
  } else if (liq > 0 && vol / liq > 10) {
    // Ledger #13 (10-15×): warning, no safeBlock — a lone 10-15× ratio must
    // never read SAFE (guaranteed by the ≥1-warning gate) but shouldn't
    // single-handedly force DANGER.
    flags.push(makeFlag("High vol/liquidity ratio (>10×) — wash volume", "warning", 250, "behavioral"));
    penalties.push(0.35);
  }

  const hasStructuralWeakness =
    (liq > 0 && vol / liq > 10) ||
    (txns5m > 30 && sells5m === 0) ||
    liq < 15000;
  if (ageMinutes < 30 && pc1 > 150) {
    if (hasStructuralWeakness) {
      // Ledger #15: 3 converging signals (pump + newborn age + structural
      // weakness). FORCE RUG kept.
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on <30min token + structural weakness — exit trap`, "critical", 700));
      penalties.push(0.05); forceRug = true; safeBlocked = true;
    } else {
      // Pure pump signal (no structural weakness) — pump rule: warning
      // shown, never scored, never blocks SAFE on its own.
      flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% on newborn token (<30min)`, "warning", 0));
      penalties.push(0.30);
    }
  } else if (ageMinutes < 60 && pc1 > 120) {
    if (hasStructuralWeakness) {
      // Ledger #16: same logic as #15 with a 1h/120% window.
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on <1h token + structural weakness — exit trap`, "critical", 700));
      penalties.push(0.05); forceRug = true; safeBlocked = true;
    } else {
      flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<1h)`, "warning", 0));
      penalties.push(0.40);
    }
  } else if (pc1 > 300) {
    // Ledger #17: pure pump, no corroborating signal. Pump rule applies.
    flags.push(makeFlag(`Extreme pump +${Math.round(pc1)}% in 1h`, "warning", 0));
    penalties.push(0.05);
  } else if (pc1 > 200 && ageMinutes < 120) {
    // Ledger #18: same treatment as #17.
    flags.push(makeFlag(`Pump +${Math.round(pc1)}% on newborn token (<2h)`, "warning", 0));
    penalties.push(0.10);
  } else if (pc1 > 200 && pc5 > 50) {
    // Pure pump (price only) — pump rule applies.
    flags.push(makeFlag("Coordinated pump pattern", "warning", 0));
    penalties.push(0.65);
  }
  if (pc6 < -50 && pc1 < -15) {
    // Ledger #20: dump family, age-graduated — a sustained decline is real
    // risk on a fresh token, far less meaningful the older the token is.
    // No force rug — two measurements of the same phenomenon (price
    // falling), not independent corroborating signals.
    const points = ageTieredPoints(ageMinutes, { under2h: 550, h2to24: 350, d1to7: 150, over7d: 0 });
    flags.push(makeFlag("Slow rug detected: -50% on 6h + -15% on 1h", "critical", points));
    penalties.push(0.15);
    if (points > 0) safeBlocked = true;
  } else if (pc6 < -30) {
    // Milder single-timeframe dump signal, not individually calibrated in
    // the scoring pass — flat value proportionate to the graduated dump
    // family above (roughly the "1-7d" tier of a slow-rug-class signal).
    flags.push(makeFlag(`Sharp 6h sell-off (${Math.round(pc6)}%)`, "warning", 200));
    penalties.push(0.55); safeBlocked = true;
  }
  // Ledger: "No website/Twitter/Telegram" already reclassified behavioral
  // (softened off safeBlocked) earlier this session; point value set here.
  if (!hasWebsite && !hasTwitter && !hasTelegram) { flags.push(makeFlag("No website / Twitter / Telegram — high rug risk", "critical", 250, "behavioral")); penalties.push(0.60); }
  // Ledger #32 (LOT B — behaviour)
  if (txns5m < 5 && mc > 50000 && ageMinutes < 1440) { flags.push(makeFlag("Low 5m transactions vs market cap", "info", 50)); penalties.push(0.92); }
  if ((sells5m === 0 && buys5m > 0 && txns5m > 5) || (sells5m > 0 && buys5m > sells5m * 5)) { flags.push(makeFlag("Buy/sell imbalance (coordinated pump)", "warning", 200)); penalties.push(0.85); }
  if (pc24 < -80) {
    // Dump family, same age-graduated treatment as the -50%/6h slow rug
    // above (comparably severe standalone 24h dump signal).
    const points = ageTieredPoints(ageMinutes, { under2h: 550, h2to24: 350, d1to7: 150, over7d: 0 });
    flags.push(makeFlag("Brutal dump 24h (-80%)", "critical", points));
    penalties.push(0.35);
    if (points > 0) safeBlocked = true;
  } else if (pc24 < -40) {
    flags.push(makeFlag(`Significant 24h dump (${Math.round(pc24)}%)`, "warning", 200));
    penalties.push(0.50); safeBlocked = true;
  }

  // Ledger #19/#23: pure 24h pump signals. Pump rule — warning shown, never
  // scored, never force rug/safeBlocked regardless of magnitude.
  if (pc24 > 5000) {
    flags.push(makeFlag(`Extreme 24h pump +${Math.round(pc24)}% — exit liquidity trap`, "warning", 0));
    penalties.push(0.05);
  } else if (pc24 > 1000) {
    flags.push(makeFlag(`Extreme 24h pump +${Math.round(pc24)}% — high risk exit trap`, "warning", 0));
    penalties.push(0.15);
  } else if (pc24 > 500 && ageMinutes < 1440) {
    flags.push(makeFlag(`Large 24h pump +${Math.round(pc24)}% on token <24h`, "warning", 0));
    penalties.push(0.55);
  }
  // ── SLOW RUG / PROGRESSIVE DECLINE PATTERNS ───────────────────────────────
  // These cover the space between the fast-rug thresholds above (pc6 < -50%,
  // pc24 < -80%) and normal market noise. Order: pump reversal first (most
  // specific signal), then progressive two-timeframe decline (combo), then
  // coordinated exit (micro-level sell pressure).

  // Pump-and-dump reversal: token was significantly up over 24h but is now
  // losing hard in 6h — classic PnD timeline where the dump phase has
  // started. Dump-dominant (the danger is the reversal, not the prior
  // pump) — age-graduated like the other standalone dump signals.
  if (pc24 > 80 && pc6 < -20) {
    const points = ageTieredPoints(ageMinutes, { under2h: 550, h2to24: 350, d1to7: 150, over7d: 0 });
    flags.push(makeFlag(`Pump reversal: +${Math.round(pc24)}% (24h) → ${Math.round(pc6)}% (6h)`, "critical", points));
    penalties.push(0.30);
    if (points > 0) safeBlocked = true;
  }

  // Progressive multi-timeframe decline: both 6h and 24h are meaningfully
  // negative but below the standalone thresholds (< -30% and < -40%).
  // Two timeframes confirming each other = ongoing distribution, not a blip.
  if (pc6 < -20 && pc6 > -30 && pc24 < -25 && pc24 > -40) {
    flags.push(makeFlag(`Progressive dump: ${Math.round(pc6)}% (6h) + ${Math.round(pc24)}% (24h)`, "warning", 200));
    penalties.push(0.55); safeBlocked = true;
  }

  // Coordinated exit: price is declining in the last hour AND sells are
  // dominating buys 3-to-1 in the current 5-minute window — typical of
  // organised wallet groups rotating out.
  if (pc1 < -8 && sells5m > buys5m * 3 && txns5m > 10) {
    flags.push(makeFlag(`Coordinated exit: price ${Math.round(pc1)}% + sells 3× buys`, "warning", 250));
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

  // Ledger #7: deceptive name — danger, not force rug (intent signal, not a
  // technical guarantee the token can't be sold).
  if (tokenName) {
    const isDeceptive = DECEPTIVE_NAME_PATTERNS.some(p => p.test(tokenName));
    if (isDeceptive) {
      flags.push(makeFlag(`Deceptive name — impersonates real institution: "${tokenName}"`, "critical", 600));
      penalties.push(0.20); safeBlocked = true;
    }
  }

  // Ledger #6: bundle detected, ALL variants → FORCE RUG. A bundle means
  // wallets provably funded from one source bought in the same block via a
  // bundler tool — deliberate coordinated-dump setup, not a coincidence.
  const bundleInReport = riskIncludes(rugReportData, /bundle/i);
  const bundledPct = bundleInReport ? extractBundlePct(rugReportData) : 0;
  if (bundleInReport && bundledPct > 0.20) {
    flags.push(makeFlag(`Bundle holds ~${Math.round(bundledPct * 100)}% of supply — coordinated buy/dump`, "critical", 700));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else if (bundleInReport && bundledPct > 0.05) {
    flags.push(makeFlag(`Bundle detected (~${Math.round(bundledPct * 100)}% of supply)`, "critical", 700));
    penalties.push(0.20); forceRug = true; safeBlocked = true;
  } else if (bundleInReport) {
    flags.push(makeFlag("Bundle activity detected (RugCheck)", "critical", 700));
    penalties.push(0.20); forceRug = true; safeBlocked = true;
  }
  if (!bundleInReport && riskIncludes(rugData, /bundler|bundle/i)) {
    flags.push(makeFlag("Bundler detected (RugCheck summary)", "critical", 700));
    penalties.push(0.15); forceRug = true; safeBlocked = true;
  }
            if (rugData.lpBurned === true) {
        flags.push(makeFlag("LP Burned ✓", "bonus", -75)); trust = Math.min(1.0, trust * 1.10);
    } else if (rugData.lpLocked === true) {
        const days = getLpLockDurationDays(rugData);
        if (days > 180) { flags.push(makeFlag("LP Locked > 180 days ✓", "bonus", -50)); trust = Math.min(1.0, trust * 1.05); }
        else if (days > 0 && days < 30) { flags.push(makeFlag("LP lock duration < 30 days", "warning", 200)); penalties.push(0.75); }
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
                // Structural (LP + another real contract fact converging) —
                // severe but stops short of force rug on its own.
                flags.push(makeFlag("LP not burned or locked — dev can rug liquidity (contract not clean)", "critical", 650));
                penalties.push(0.65);
                safeBlocked = true;
            } else {
                // Ledger #8: LP matrix conserved — points derived from the
                // matrix's existing (carefully calibrated) multiplicative
                // penalty via penaltyToPoints, preserving its relative
                // severity across all 24 pct×age cells.
                flags.push(makeFlag(bucket.flagLabel, bucket.severity, penaltyToPoints(bucket.penalty)));
                penalties.push(bucket.penalty);
                if (bucket.safeBlock) safeBlocked = true;
                if (bucket.forceRug) forceRug = true;
            }
        }
    }
    if (rugData.metaMutable === true) {
        // Ledger #42
        flags.push(makeFlag("Metadata mutable", "info", 100));
        penalties.push(0.90);
    }
  // Ledger #34: RugCheck top-10 duplicate removed — the Helius-backed
  // fresh/established 2-tier system in layerHelius (ledger #25) already
  // covers this signal with a maturity gate this cross-check never had.
  // Ledger: sniper already reclassified behavioral (softened off
  // safeBlocked/forceRug) earlier this session.
  if (riskIncludes(rugReportData, /sniper/i)) { flags.push(makeFlag("Sniper activity detected", "critical", 250, "behavioral")); penalties.push(0.15); }
  // Ledger #5: FORCE RUG kept — a confirmed prior rug pull, no benefit of the doubt.
  if (riskIncludes(rugReportData, /rug/i)) { flags.push(makeFlag("Rug pull history", "critical", 700)); penalties.push(0.15); forceRug = true; }
  // Ledger #32 (LOT B)
  if (riskIncludes(rugReportData, /creator.*sell|dev.*sell/i)) { flags.push(makeFlag("Dev wallet sold tokens", "warning", 250)); penalties.push(0.65); }
  // Ledger #31 (LOT A) — same underlying fact as the GoPlus mint/freeze
  // flags below, just reported by a second oracle.
  if (rugData.mintAuthorityEnabled) { flags.push(makeFlag("Mint Authority enabled (RugCheck)", "critical", 450)); penalties.push(0.25); }
  if (rugData.freezeAuthorityEnabled) { flags.push(makeFlag("Freeze Authority enabled (RugCheck)", "critical", 450)); penalties.push(0.25); }
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
  // Ledger #1: honeypot / cannot-sell-all — FORCE RUG, always.
  if (gp("is_honeypot")) {
    flags.push(makeFlag("Honeypot detected — cannot sell", "critical", 700));
    trust = 0; forceRug = true; safeBlocked = true;
    return { source: "goplus", trust: 0, available: true, flags, forceRug, safeBlocked };
  }
  if (gp("cannot_sell_all")) {
    flags.push(makeFlag("Cannot sell all tokens", "critical", 700));
    trust = 0; forceRug = true; safeBlocked = true;
    return { source: "goplus", trust: 0, available: true, flags, forceRug, safeBlocked };
  }
  const hasMint = authorityActive(goplus.mint_authority);
  const hasFreeze = authorityActive(goplus.freeze_authority);
  if (hasMint && hasFreeze) {
    // Ledger #4: both authorities active — total dev control. FORCE RUG.
    flags.push(makeFlag("Mint + Freeze authority both active", "critical", 700));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else {
    // Ledger #31 (LOT A)
    if (hasMint) { flags.push(makeFlag("Mint Authority enabled", "critical", 450)); penalties.push(0.25); }
    if (hasFreeze) { flags.push(makeFlag("Freeze Authority enabled", "critical", 450)); penalties.push(0.25); }
  }
  // Ledger #9: −650 each, danger not force rug.
  if (gp("is_blacklisted")) { flags.push(makeFlag("Blacklist capability", "critical", 650)); penalties.push(0.30); safeBlocked = true; }
  if (gp("transfer_pausable")) { flags.push(makeFlag("Transfer pausable", "critical", 650)); penalties.push(0.30); safeBlocked = true; }
  if (gp("hidden_owner")) { flags.push(makeFlag("Hidden owner detected", "critical", 650)); penalties.push(0.30); safeBlocked = true; }
  if (gp("is_proxy")) { flags.push(makeFlag("Upgradeable/proxy contract", "critical", 650)); penalties.push(0.50); safeBlocked = true; }
  const sellTaxRaw = gpNum("sell_tax");
  const buyTaxRaw  = gpNum("buy_tax");
  const sellTax = sellTaxRaw > 1 ? sellTaxRaw / 100 : sellTaxRaw;
  const buyTax  = buyTaxRaw  > 1 ? buyTaxRaw  / 100 : buyTaxRaw;
  // Ledger #10: 3-tier scale, separate for buy/sell. >50% is a disguised
  // honeypot (you lose most of your position exiting) — FORCE RUG.
  if (sellTax > 0.50) {
    flags.push(makeFlag(`Sell tax ${Math.round(sellTax * 100)}%`, "critical", 700));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else if (sellTax > 0.25) {
    flags.push(makeFlag(`Sell tax ${Math.round(sellTax * 100)}%`, "critical", 600));
    penalties.push(0.20); safeBlocked = true;
  } else if (sellTax > 0.10) {
    flags.push(makeFlag(`Sell tax ${Math.round(sellTax * 100)}%`, "critical", 350));
    penalties.push(0.35);
  } else if (sellTax > 0.02) {
    // Fix(TAX_WARNING): tax between 2-10% is a common rug mechanic — flag
    // it. VDOR had 4.5% tax that previously passed through undetected.
    flags.push(makeFlag(`Sell tax ${Math.round(sellTax * 100)}% — suspicious`, "warning", 150));
    penalties.push(0.80);
  }
  if (buyTax > 0.50) {
    flags.push(makeFlag(`Buy tax ${Math.round(buyTax * 100)}%`, "critical", 700));
    penalties.push(0.05); forceRug = true; safeBlocked = true;
  } else if (buyTax > 0.25) {
    flags.push(makeFlag(`Buy tax ${Math.round(buyTax * 100)}%`, "critical", 600));
    penalties.push(0.20); safeBlocked = true;
  } else if (buyTax > 0.10) {
    flags.push(makeFlag(`Buy tax ${Math.round(buyTax * 100)}%`, "critical", 350));
    penalties.push(0.35);
  } else if (buyTax > 0.02) {
    flags.push(makeFlag(`Buy tax ${Math.round(buyTax * 100)}% — suspicious`, "warning", 150));
    penalties.push(0.80);
  }
  // Ledger #11: 3-tier scale. No force rug — a large holding is a risk
  // signal, not proof of intent (unlike a bundle, which is coordinated by
  // construction).
  const ownerPct = gpNum("owner_percent");
  if (ownerPct > 0.20) { flags.push(makeFlag(`Owner holds ${Math.round(ownerPct * 100)}%`, "critical", 650)); penalties.push(0.50); }
  else if (ownerPct > 0.10) { flags.push(makeFlag(`Owner holds ${Math.round(ownerPct * 100)}%`, "critical", 450)); penalties.push(0.65); }
  else if (ownerPct > 0.05) { flags.push(makeFlag(`Owner holds ${Math.round(ownerPct * 100)}%`, "warning", 250)); penalties.push(0.80); }
  const creatorPct = gpNum("creator_percent");
  if (creatorPct > 0.20) { flags.push(makeFlag(`Creator holds ${Math.round(creatorPct * 100)}%`, "critical", 650)); penalties.push(0.50); }
  else if (creatorPct > 0.10) { flags.push(makeFlag(`Creator holds ${Math.round(creatorPct * 100)}%`, "critical", 450)); penalties.push(0.65); }
  else if (creatorPct > 0.05) { flags.push(makeFlag(`Creator holds ${Math.round(creatorPct * 100)}%`, "warning", 250)); penalties.push(0.80); }
  // Ledger #31 (LOT A)
  if (gp("is_mintable")) { flags.push(makeFlag("Token is mintable", "warning", 450)); penalties.push(0.60); }
  if (gp("slippage_modifiable")) { flags.push(makeFlag("Slippage/tax modifiable", "warning", 500)); penalties.push(0.75); }
  if (gp("is_anti_whale_modifiable")) { flags.push(makeFlag("Anti-whale rules modifiable", "warning", 350)); penalties.push(0.80); }
  if (gp("trading_cooldown")) { flags.push(makeFlag("Trading cooldown enabled", "info", 50)); penalties.push(0.90); }
  if (gp("is_whitelisted")) { flags.push(makeFlag("Whitelist system detected", "warning", 600)); penalties.push(0.80); }

          // Fix(LP_GOPLUS): LP burn/lock detection using GoPlus dex[].burn_percent
    // RugCheck does NOT return lpBurned/lpLocked booleans — only lpLockedPct which is unreliable
    // GoPlus dex[] array provides accurate burn_percent per pool
    if (goplus.dex && Array.isArray(goplus.dex) && goplus.dex.length > 0) {
        const maxBurnPct = Math.max(...goplus.dex.map(d => typeof d.burn_percent === "number" ? d.burn_percent : 0));
        if (maxBurnPct >= 50) {
            flags.push(makeFlag(`LP Burned ${Math.round(maxBurnPct)}% (GoPlus) ✓`, "bonus", -75));
            trust = Math.min(1.0, trust * 1.10);
        } else if (maxBurnPct >= 1) {
            flags.push(makeFlag(`LP partially burned ${Math.round(maxBurnPct)}% — not fully secured`, "warning", 200));
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
                flags.push(makeFlag("LP not burned or locked — dev can rug liquidity (contract not clean)", "critical", 650));
                penalties.push(0.65);
                safeBlocked = true;
            } else {
                flags.push(makeFlag(bucket.flagLabel, bucket.severity, penaltyToPoints(bucket.penalty)));
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
  maturityContext?: { holders: number | null; liquidity: number; tokenAgeHours: number | null; mintAuthority: boolean; freezeAuthority: boolean; honeypot: boolean; lpBurned?: boolean | null; lpPctOfSupply?: number | null },
  // DEXScreener pair addresses for this token. For AMMs that use per-pool
  // PDAs as vault authority (PumpSwap, Meteora DBC, etc.), the pair address
  // IS the authority of the LP vault token account. Passing them here lets
  // us exclude LP vaults that our static LP_PROGRAM_ADDRESSES list misses —
  // without any extra RPC calls (the data comes from the DEXScreener response
  // we already fetched). This is the most reliable LP detection available.
  dexPairAddresses?: Set<string>,
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
    h => !LP_PROGRAM_ADDRESSES.has(h.owner)
      && !FOUNDATION_WALLETS.has(h.owner)
      && !(dexPairAddresses?.has(h.owner))   // LP vault whose authority = DEXScreener pair PDA
  );
  const top1Amount = asNumber(accounts[0]?.uiAmount);
  const top1Pct = top1Amount / totalSupplyUi;
  const top10Amount = accounts.slice(0, 10).reduce((s, h) => s + asNumber(h.uiAmount), 0);
  const top10Pct = top10Amount / totalSupplyUi;
  // ── Top-10 distribution ladder — 2 tiers (7.7.6) ────────────────────────
  // Tier is determined by token maturity. An established token gets looser
  // thresholds because its top-10 likely includes exchange cold wallets and
  // long-term holders — not a coordinated dump group.
  //
  // FRESH tokens (no context OR < 30d OR neither condition below):
  //   < 20%:   bonus — exceptional clean launch
  //   20–34%:  info, no block — early adopters spread
  //   35–54%:  warning, soft (concentration_light), max CAUTION — cluster risk
  //   55–74%:  critical, hard (concentration), DANGER — control risk
  //   ≥ 75%:   critical, hard (concentration), DANGER/RUG — extreme
  //
  // ESTABLISHED tokens (≥ 30d AND (≥ 5k holders OR ≥ 60d)):
  //   < 25%:   bonus — institutional-quality distribution
  //   25–44%:  info, no block — NORMAL, context note explains exchanges
  //   45–64%:  warning, soft (concentration_light), max CAUTION — still notable
  //   65–79%:  critical, hard (concentration), DANGER — even for established tokens
  //   ≥ 80%:   critical, hard (concentration), DANGER/RUG — extreme
  //
  // Bug-fix note (7.7.6): the previous check required BOTH holders >= 5k AND
  // tokenAgeHours >= 720. When GoPlus + Solscan fail simultaneously, `holders`
  // collapses to top20NonZero = 20 (just the Helius largest-accounts list).
  // A 2-year-old token would therefore fall into the fresh tier and emit
  // "cluster risk" instead of the exchange-context label — FARTCOIN landed
  // CAUTION instead of SAFE in prod whenever GoPlus was down.
  // Fix: require age ≥ 30d always, then accept EITHER verified holders ≥ 5k
  // OR age ≥ 180d (6 months). The 180d threshold is deliberately conservative:
  // it protects 6-month+ blue-chips (FARTCOIN ~730d, WIF ~600d) from data-gap
  // misclassification while keeping shorter-lived tokens (RIV 67d, typical
  // rugs 30-90d) in the strict fresh tier even when holder sources are down.
  const isEstablishedToken = !!(maturityContext &&
    (maturityContext.tokenAgeHours ?? 0) >= 30 * 24 &&
    (
      (maturityContext.holders ?? 0) >= 5_000 ||
      (maturityContext.tokenAgeHours ?? 0) >= 180 * 24
    )
  );
  let top10ConcentrationBand: "none" | "moderate" | "soft" | "hard" = "none";
  const t10pct = Math.round(top10Pct * 100);

  // Ledger #25: 2 point scales, fresh vs established (kept from the
  // existing maturity-gated ladder above).
  if (isEstablishedToken) {
    // Established tier — looser thresholds, contextual labels
    if (top10Pct >= 0.80) {
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — extreme concentration`, "critical", 550));
      penalties.push(0.10); safeBlocked = true; top10ConcentrationBand = "hard";
    } else if (top10Pct >= 0.65) {
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — high concentration`, "critical", 350));
      penalties.push(0.25); safeBlocked = true; top10ConcentrationBand = "hard";
    } else if (top10Pct >= 0.45) {
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — elevated · exchanges may be included`, "warning", 150));
      penalties.push(0.50); safeBlocked = true; top10ConcentrationBand = "soft";
    } else if (top10Pct >= 0.25) {
      // Kept as INFO + no safeBlocked for established tokens: on a 2-year-old
      // blue-chip, 25-44% top-10 is normal (exchange cold wallets). Making it
      // WARNING would block SAFE for FARTCOIN/WIF/MEW unfairly.
      // The overlay whitelists concentration info flags so they stay visible
      // even on DANGER/RUG verdicts (critical-flags.ts filter).
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — moderate · exchanges likely included`, "info", 50));
      top10ConcentrationBand = "moderate";
    } else {
      flags.push(makeFlag("Well distributed supply ✓", "bonus", -50));
      trust = Math.min(1.0, trust * 1.05);
    }
  } else {
    // Fresh / unknown tier — strict thresholds
    if (top10Pct >= 0.75) {
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — extreme concentration`, "critical", 650));
      penalties.push(0.10); safeBlocked = true; top10ConcentrationBand = "hard";
    } else if (top10Pct >= 0.55) {
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — high concentration · control risk`, "critical", 500));
      penalties.push(0.25); safeBlocked = true; top10ConcentrationBand = "hard";
    } else if (top10Pct >= 0.35) {
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — elevated concentration · cluster risk`, "warning", 300));
      penalties.push(0.50); safeBlocked = true; top10ConcentrationBand = "soft";
    } else if (top10Pct >= 0.20) {
      // Promoted info→warning so it stays visible even on DANGER/RUG verdicts.
      flags.push(makeFlag(`Top 10 hold ${t10pct}% — moderate concentration`, "warning", 150));
      safeBlocked = true; top10ConcentrationBand = "moderate";
    } else {
      flags.push(makeFlag("Well distributed supply ✓", "bonus", -50));
      trust = Math.min(1.0, trust * 1.05);
    }
  }

  // ── SINGLE-WALLET SAFETY NET (7.7.11) ────────────────────────────────────
  // Layered UNDER the top-10 ladder. The top-10 system is the primary verdict
  // driver, but it misses ONE pattern: a single giant wallet on a token whose
  // top-10 is otherwise moderate. HAWK is the canonical case — top-1 ~44%,
  // top-10 ~54% → the top-10 ladder only sees "elevated" (soft → CAUTION),
  // but a single wallet at 44% is a dump risk on its own. This net catches
  // exactly that gap and routes it to DANGER/RUG.
  //
  // The 40% threshold is deliberately ABOVE the legitimate exchange /
  // custodial range (the largest single custodial wallet on blue-chips like
  // MEW is ~35%), so it does NOT re-introduce the exchange-cold-wallet false
  // positives that the top-1 removal in 7.7.4 eliminated. Measured blast
  // radius on the 325-token holder-data corpus: a single flip (one 87%-
  // single-wallet token), zero hand-vetted blue-chips touched.
  //
  // Guarded by `top10ConcentrationBand !== "hard"` so it doesn't double-flag
  // a token the top-10 ladder already hard-blocked (those are already
  // DANGER/RUG). Only fires on the soft/moderate/none bands the net exists
  // to backstop.
  //
  //   >55%: extreme — hard block + forceRug (unless blue-chip ≥50k holders).
  //   >40%: high     — hard block → DANGER. Stays DANGER (not RUG) so a legit
  //         locked-vesting / issuer-concentrated holder gets a strong warning
  //         rather than an absolute kill.
  if (top10ConcentrationBand !== "hard") {
    const isBlueChipHolders = (maturityContext?.holders ?? 0) >= 50_000;
    const t1pct = Math.round(top1Pct * 100);
    if (top1Pct > 0.55) {
      // Ledger #26: unchanged behaviour, points added. Blue-chip (≥50k
      // holders) never force-rugs on this signal alone — already proven
      // legitimate by holder count.
      flags.push(makeFlag(`Single wallet holds ${t1pct}% — extreme concentration`, "critical", isBlueChipHolders ? 450 : 700));
      penalties.push(0.10); safeBlocked = true;
      if (!isBlueChipHolders) forceRug = true;
    } else if (top1Pct > 0.40) {
      flags.push(makeFlag(`Single wallet holds ${t1pct}% — high concentration`, "critical", 500));
      penalties.push(0.25); safeBlocked = true;
    }
  }

  // ── YOUNG-TOKEN SINGLE-WALLET TIERS (7.7.12) ─────────────────────────────
  // Stricter single-wallet thresholds for tokens < 30 days old.
  // A large wallet on a new token has no exchange / vesting / long-term-holder
  // context yet — the same % means far more risk than on an established token.
  //
  //   > 15%: hard "concentration" → DANGER
  //   10–15%: critical, soft "concentration_light" → CAUTION max
  //   < 10%: no flag — top-10 ladder already captures cluster risk at this level
  //
  // Guards:
  //  - top10ConcentrationBand !== "hard": top-10 ladder already hard-blocked → skip
  //  - top1Pct < 0.40: existing safety net (7.7.11) already caught it → skip
  //  - maturityContext must provide tokenAgeHours (no data = no penalty)
  if (
    maturityContext &&
    typeof maturityContext.tokenAgeHours === "number" &&
    maturityContext.tokenAgeHours < 720 &&   // < 30 days
    top10ConcentrationBand !== "hard" &&
    top1Pct < 0.40
  ) {
    const yt1pct = Math.round(top1Pct * 100);
    if (top1Pct > 0.15) {
      // Hard → DANGER via "concentration" reason (HARD_BLOCK_PATTERNS regex match)
      flags.push(makeFlag(`Single wallet holds ${yt1pct}% — high concentration · young token`, "critical", 350));
      penalties.push(0.20); safeBlocked = true;
    } else if (top1Pct > 0.10) {
      // Soft → CAUTION max via "concentration_light" reason
      flags.push(makeFlag(`Single wallet holds ${yt1pct}% — elevated concentration · young token`, "critical", 150));
      penalties.push(0.45); safeBlocked = true;
    }
  }

  trust = applyDiminishingPenalties(trust, penalties);

  // ── Extreme concentration kill-switch ───────────────────────────────────
  // forceRug fires when top-10 > 80% on non-blue-chip tokens.
  // A token where 10 wallets control 80%+ of supply is structurally a rug.
  //
  // Reference cases:
  //   HAWK (top-10 87%, 7k holders)  → forceRug ✓
  //   HORNY (similar profile)         → forceRug ✓
  //   MEW (top-10 ~70%, 164k holders) → blue-chip shield, no forceRug ✓
  //
  // The 50k-holder cutoff protects established blue-chips. For everything
  // below that, top-10 > 80% IS the rug pattern.
  // GOAT/PNUT (broken-data artefacts) are caught by the data-quality
  // fallback below which clears forceRug.
  {
    const mcRug = maturityContext;
    const isBlueChipDistribution = (mcRug?.holders ?? 0) >= 50_000;
    // Fresh threshold: > 75% (aligns with the 75% extreme band for fresh tokens)
    // Established threshold: > 80% (aligns with the 80% extreme band for established tokens)
    const forceRugThreshold = isEstablishedToken ? 0.80 : 0.75;
    if (top10Pct > forceRugThreshold && !isBlueChipDistribution) {
      forceRug = true;
    }
  }

  // ── Maturity dampening ────────────────────────────────────────────────────
  // For established memecoins (LP burned, 30d+) with well-distributed supply
  // (top-10 < 60%), the score floors at a minimum trust so infrastructure
  // drag (Helius down) doesn't collapse a clean token to DANGER. Floors:
  //   holders ≥ 100k + LP burned + 30d + top10 < 60%  → trust ≥ 0.65
  //   holders ≥ 50k  + LP burned + 30d + top10 < 60%  → trust ≥ 0.50
  //   holders ≥ 10k  + LP burned + 30d + top10 < 60%  → trust ≥ 0.35
  //   top10 ≥ 60% on any token                        → no dampening
  // The flags + safeBlocked stay so Path 3 / DAO allowlist still gates
  // the safe verdict on additional signals.
  const mc = maturityContext;
  if (mc) {
    const looksMatureBase = (mc.tokenAgeHours ?? 0) >= 30 * 24 && mc.lpBurned === true;
    // Lift only when top-10 is in "none" (well distributed) or "moderate" band.
    // Elevated/hard concentration (60%+) keeps its penalty even on mature tokens.
    const concentrationAllowsLift = top10ConcentrationBand === "none" || top10ConcentrationBand === "moderate";
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
    //
    // CRITICAL GATE (2026-05-29, RIV case): the fallback was misfiring
    // on tokens where the concentration is REAL but the holder count
    // couldn't be confirmed. RIV had a 40% top-1 wallet on a $651k-liq
    // 67d-old token. Solscan returned no holder count, so `mc.holders`
    // fell back to the Helius top-20 list size (20) → reportedHoldersTooLow
    // = true → the genuine 40% concentration flag got silently dropped
    // → safeBlocked cleared → SAFE 795/1000. Catastrophic false positive.
    //
    // Fix: only treat the data as "broken" when the concentration values
    // themselves are STRUCTURALLY IMPOSSIBLE (top1 > 80% OR top10 > 95%).
    // The GOAT/PNUT pump.fun-survivor case shows ~99% on one wallet —
    // physically impossible on a $50M-mcap blue-chip, so we mask it.
    // A 40% top-1 is a PLAUSIBLE real-whale concentration risk, so we
    // keep the flag and let the hard-concentration path through.
    const macroLooksBig =
      (mc.liquidity ?? 0) >= 250_000 &&
      (mc.tokenAgeHours ?? 0) >= 30 * 24;
    const reportedHoldersTooLow = (mc.holders ?? Infinity) < 200;
    const concentrationImplausiblyExtreme = top1Pct > 0.8 || top10Pct > 0.95;
    if (macroLooksBig && reportedHoldersTooLow && concentrationImplausiblyExtreme) {
      // Drop the misleading concentration flags; emit one info flag.
      const concentrationLabel = /concentration|well distributed/i;
      for (let i = flags.length - 1; i >= 0; i--) {
        if (concentrationLabel.test(flags[i].label)) flags.splice(i, 1);
      }
      flags.push(makeFlag("Holder data unreliable (broken upstream view) — mature pair, deep liquidity", "info", 0)); // data-quality disclaimer, not a risk signal
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
    if (holderCount < 15) { flags.push(makeFlag("Very few holders (<15)", "critical", 400)); penalties.push(0.20); safeBlocked = true; }
    else if (holderCount < 50) { flags.push(makeFlag("Low holders (<50)", "warning", 200)); penalties.push(0.35); safeBlocked = true; }
    else if (holderCount > 5000) { flags.push(makeFlag("Strong holder base (5K+) ✓", "bonus", -50)); trust = Math.min(1.0, trust * 1.05); }
  }
  // Ledger #14: age is a cumulative trust factor, not a danger signal — very
  // light points, never safeBlocked, never a lone-critical DANGER floor
  // (flagClass "behavioral" so it needs corroboration like any other noisy
  // signal, even though severity stays "critical" for panel visibility).
  if (tokenAgeHours !== null) {
    if (tokenAgeHours < 0.5) { flags.push(makeFlag("Newborn token on-chain (<30min)", "critical", 150, "behavioral")); penalties.push(0.10); }
    else if (tokenAgeHours < 1) { flags.push(makeFlag("Newborn token on-chain (<1h)", "critical", 100, "behavioral")); penalties.push(0.20); }
    else if (tokenAgeHours < 6) { flags.push(makeFlag("Fresh token on-chain (<6h)", "warning", 50)); penalties.push(0.65); }
    else if (tokenAgeHours > 720) { flags.push(makeFlag("Established token (30d+) ✓", "bonus", -50)); trust = Math.min(1.0, trust * 1.05); }
  }
  let washTradingDetected = false;
  if (trades24h !== null && traders24h !== null && traders24h === 0 && trades24h > 0) {
    // Labelled behavioral (statistical wash signal) but keeps safeBlocked for
    // now: strong signal, softening deferred until backtest-validated.
    flags.push(makeFlag("Wash trading: trades with zero identified traders", "critical", 450, "behavioral"));
    penalties.push(0.40); safeBlocked = true;
    washTradingDetected = true;
  }
  if (trades24h !== null && traders24h !== null && traders24h > 0) {
    const tradesPerTrader = trades24h / traders24h;
    if (tradesPerTrader > 50 && traders24h < 20) {
      // Same wash-signal family as the zero-traders case above.
      flags.push(makeFlag("Wash trading suspected (trades/traders ratio)", "critical", 400, "behavioral"));
      penalties.push(0.50); safeBlocked = true;
      washTradingDetected = true;
    } else if (traders24h > 500 && tradesPerTrader < 0.1) {
      flags.push(makeFlag("Bot-farmed holders: many accounts, near-zero activity", "warning", 250));
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
  maturityContext?: { holders: number | null; liquidity: number; tokenAgeHours: number | null; mintAuthority: boolean; freezeAuthority: boolean; honeypot: boolean; lpBurned?: boolean | null; lpPctOfSupply?: number | null },
  // Daily candles (up to 31 days) for weekly / monthly pump detection.
  // Sorted ascending (oldest first). Fetched separately from GeckoTerminal
  // /ohlcv/day so short-term candles stay cheap (40 × 5-min).
  dailyCandles?: OHLCVCandle[],
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
  const pc5m = asNumber(pair?.priceChange?.m5);
  const pc1h = asNumber(pair?.priceChange?.h1);
  const pc24h = asNumber(pair?.priceChange?.h24);

  // ── Existing patterns ──────────────────────────────────────────────────────
  if (greenRatio >= 0.82 && runUpPct >= 100 && pullbackRange <= 10) {
    flags.push(makeFlag("Crashcoin pattern: near-perfect parabolic chart", "critical", 400, "behavioral"));
    penalties.push(0.35); safeBlocked = true;
  }
  // Ledger #35: pure pump signal (5m/1h price only). Pump rule applies.
  if (pc5m > 35 && pc1h > 120) {
    flags.push(makeFlag("Vertical pump detected (+35% 5m / +120% 1h)", "warning", 0));
    penalties.push(0.55);
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
      ((mcP?.tokenAgeHours ?? 0) >= 90 * 24 && (mcP?.liquidity ?? 0) >= LP_UNVERIFIED_MIN_LIQUIDITY);
    const pumpPct = Math.round(pc24h);

    // Ledger #36: pure pump signal (24h price only, both mature and
    // non-mature branches) — pump rule applies regardless of maturity tier.
    // Labels kept distinct per branch for user-facing context; none score
    // or block SAFE.
    if (matureForPump) {
      if (pc24h >= 200) {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — elevated retrace risk on entry`, "warning", 0));
        penalties.push(0.85);
      } else {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — moderate retrace risk on entry`, "warning", 0));
        penalties.push(0.88);
      }
    } else {
      if (pc24h >= 300) {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — exit liquidity risk on thin LP`, "warning", 0));
        penalties.push(0.45);
      } else if (pc24h >= 200) {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — entering at local top (thin LP)`, "warning", 0));
        penalties.push(0.55);
      } else {
        flags.push(makeFlag(`Pumped +${pumpPct}% in 24h — elevated retrace risk on entry`, "warning", 0));
        penalties.push(0.70);
      }
    }
  }
  // Ledger #37: "Liquidity mirage" duplicate removed — same wash-trading
  // signal as the DexScreener-layer vol/liq ratio flag, computed
  // differently. Superseded by that flag to avoid double-counting the
  // same underlying phenomenon.
  // Ledger #38: composite signal (80%+ rising candles + abnormally low
  // return variance = mechanically smooth, not organic). Same family as
  // the micro-window pump / rug staircase patterns.
  if (recent.length >= 10 && risingCount >= Math.floor(recent.length * 0.8) && returnStd < 3.5) {
    flags.push(makeFlag("Over-controlled chart: artificial stair-step", "warning", 500));
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
      ((mc?.tokenAgeHours ?? 0) >= 90 * 24 && (mc?.liquidity ?? 0) >= LP_UNVERIFIED_MIN_LIQUIDITY);
    if (looksMature) {
      flags.push(makeFlag("Drawdown >55% from local peak (mature pair, normal volatility)", "info", 0));
    } else {
      // Same tier as the crashcoin pattern above — labelled behavioral,
      // safeBlocked kept pending backtest validation.
      flags.push(makeFlag("Blow-off top: price collapsed >55% from peak", "critical", 400, "behavioral"));
      penalties.push(0.20); safeBlocked = true;
    }
  }
  if (tokenAgeMinutes !== null && tokenAgeMinutes < 90 && volumes.length >= 10) {
    const recentVol = volumes.slice(-5);
    const olderVol = volumes.slice(-10, -5);
    // Ledger #39
    if (olderVol.length && _mean(recentVol) < _mean(olderVol) * 0.45 && last >= peak * 0.88) {
      flags.push(makeFlag("Early volume exhaustion near highs", "warning", 350));
      penalties.push(0.65); safeBlocked = true;
    }
    // Ledger #40
    if (olderVol.length && _mean(olderVol) === 0 && _mean(recentVol) > 0) {
      flags.push(makeFlag("Sudden volume spike from zero — artificial pump", "warning", 300));
      penalties.push(0.60); safeBlocked = true;
    }
  }
  // Ledger #41
  if (_pct(first, last) > 300 && greenRatio > 0.78) {
    flags.push(makeFlag("Parabolic launch: high risk exit liquidity setup", "warning", 500));
    penalties.push(0.60); safeBlocked = true;
  }
  if (pc24h < -60 && pc1h < -20) {
    // Ledger #21: dump family, age-graduated, no force rug.
    const points = ageTieredPoints(tokenAgeMinutes ?? Infinity, { under2h: 550, h2to24: 350, d1to7: 150, over7d: 0 });
    flags.push(makeFlag("Active dump: -60% 24h + -20% 1h (slow rug)", "critical", points));
    penalties.push(0.25);
    if (points > 0) safeBlocked = true;
  }

  // ── NEW v8 patterns — OHLCV rug fingerprints ───────────────────────────────

  // Pattern 1: Post-ATH dump >50% in last 4 candles = rug exit in progress
  if (closes.length >= 5) {
    const athIdx = closes.indexOf(Math.max(...closes));
    const isRecentATH = athIdx >= closes.length - 4;
    if (isRecentATH && peak > 0) {
      const dumpFromATH = (last - peak) / peak;
      if (dumpFromATH < -0.50) {
        // Ledger #22: 2 converging signals (fresh ATH + immediate collapse)
        // — force rug gated by age, unlike the single-signal dumps.
        const ageMin = tokenAgeMinutes ?? Infinity;
        if (ageMin < 120) {
          flags.push(makeFlag(`Post-ATH dump ${Math.round(dumpFromATH * 100)}% — rug exit in progress`, "critical", 700));
          penalties.push(0.10); forceRug = true; safeBlocked = true;
        } else {
          const points = ageTieredPoints(ageMin, { under2h: 700, h2to24: 650, d1to7: 350, over7d: 150 });
          flags.push(makeFlag(`Post-ATH dump ${Math.round(dumpFromATH * 100)}% — rug exit in progress`, "critical", points));
          penalties.push(0.10); safeBlocked = true;
        }
      } else if (dumpFromATH < -0.35) {
        flags.push(makeFlag(`Post-ATH dump ${Math.round(dumpFromATH * 100)}% — exit liquidity pattern`, "warning", 250));
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
      // Ledger #24: composite signal (price + mechanically smooth shape),
      // not a pure pump. Danger, no force rug.
      flags.push(makeFlag(`Micro-window pump: +${Math.round(_pct(shortFirst, shortLast))}% in 10 candles — coordinated launch`, "critical", 550));
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
      // Ledger #27: dump family, age-graduated, no force rug.
      const points = ageTieredPoints(tokenAgeMinutes ?? Infinity, { under2h: 350, h2to24: 200, d1to7: 100, over7d: 50 });
      flags.push(makeFlag("Dead cat bounce: -50% drop then partial recovery — distribution trap", "warning", points));
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
        ((mc?.tokenAgeHours ?? 0) >= 90 * 24 && (mc?.liquidity ?? 0) >= LP_UNVERIFIED_MIN_LIQUIDITY);
      // Ledger #28: maturity gate kept as-is.
      if (looksMature) {
        flags.push(makeFlag("Volume tapering during consolidation (mature pair)", "info", 30));
        penalties.push(0.85);
      } else {
        flags.push(makeFlag("Rug staircase: volume collapsing while price held flat — controlled dump", "warning", 500));
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
      // Ledger #29: fixed value, no age scale — ambiguous signal (could be
      // a legitimate sell wall).
      flags.push(makeFlag("Wick trap: 3+ candles with dominant upper wick — repeated selling at highs", "warning", 300));
      penalties.push(0.65); safeBlocked = true;
    }
  }

  // ── WEEKLY / MONTHLY PUMP (7.7.16+) ─────────────────────────────────────────
  // Tokens that have pumped heavily over 7 or 30 days carry elevated retrace
  // risk even when the contract is clean. These flags block SAFE so blue chips
  // show CAUTION rather than a false-positive green signal.
  //
  // Both tiers are "warning" severity — a pump alone is NEVER critical,
  // whatever the percentage: legit blue chips can do +10000% at launch.
  // The flag informs the trader of the retrace risk and lets them decide;
  // only the label escalates ("elevated" → "high") with the magnitude.
  //   200–499%: "elevated retrace risk" — CAUTION max
  //   ≥ 500%:  "high retrace risk"     — CAUTION max (stronger penalty)
  //
  // dailyCandles are 4-hour candles from fetchDexCandlesDaily (sorted oldest-first).
  //   7-day  = 42 candles back  (42 × 4h = 168h = 7 days)
  //   30-day = 182 candles back (182 × 4h ≈ 30.3 days)
  // 4h candles are far more reliably available on GeckoTerminal than /day.
  // Requires at least 5 candles to avoid false positives on brand-new pairs.
  if (dailyCandles && dailyCandles.length >= 5) {
    const latestClose = dailyCandles[dailyCandles.length - 1].c;
    if (latestClose > 0) {
      // 7-day: 42 × 4h candles back
      const idx7 = Math.max(0, dailyCandles.length - 43); // -43 so candle AT -42 is the ref
      const close7d = dailyCandles[idx7].c;
      // Only compute if reference candle is meaningfully older (> 5 candles away)
      if (close7d > 0 && (dailyCandles.length - 1 - idx7) >= 5) {
        const pct7d = ((latestClose - close7d) / close7d) * 100;
        // Ledger #30: pure pump signal. Pump rule applies — warning shown,
        // never scored, never blocks SAFE regardless of magnitude.
        if (pct7d >= PUMP_7D_HIGH_PCT) {
          flags.push(makeFlag(`Pumped +${Math.round(pct7d)}% over 7 days — high retrace risk at current prices`, "warning", 0));
          penalties.push(0.55);
        } else if (pct7d >= PUMP_7D_WARN_PCT) {
          flags.push(makeFlag(`Pumped +${Math.round(pct7d)}% over 7 days — elevated retrace risk at current prices`, "warning", 0));
          penalties.push(0.75);
        }
      }

      // 30-day: 182 × 4h candles back (or oldest available)
      const idx30 = Math.max(0, dailyCandles.length - 183);
      const close30d = dailyCandles[idx30].c;
      // Only compute if we have at least 42 candles (> 7 days) for meaningful 30d reading
      if (close30d > 0 && (dailyCandles.length - 1 - idx30) >= 42) {
        const pct30d = ((latestClose - close30d) / close30d) * 100;
        if (pct30d >= PUMP_30D_HIGH_PCT) {
          flags.push(makeFlag(`Pumped +${Math.round(pct30d)}% over 30 days — high retrace risk at current prices`, "warning", 0));
          penalties.push(0.55);
        } else if (pct30d >= PUMP_30D_WARN_PCT) {
          flags.push(makeFlag(`Pumped +${Math.round(pct30d)}% over 30 days — elevated retrace risk at current prices`, "warning", 0));
          penalties.push(0.75);
        }
      }
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
  // Ledger #33 (LOT C): cross-source conflicts are data-reliability signals,
  // not risk facts — light points, safeBlocked kept (never SAFE on
  // contradictory data).
  if (rugData?.lpBurned === true) {
    const lpStillActive = rawHolderAccounts.some(h => LP_PROGRAM_ADDRESSES.has(h.owner));
    if (lpStillActive) {
      flags.push(makeFlag("LP burn conflict: RugCheck vs on-chain data", "warning", 100));
      safeBlocked = true;
    }
  }
  if (goplus && rugData) {
    const gpMint = goplus.mint_authority;
    const gpOff = ["0","false","null",""].includes(String(gpMint).trim().toLowerCase());
    if (gpOff && rugData.mintAuthorityEnabled === true) {
      flags.push(makeFlag("Mint authority conflict: GoPlus vs RugCheck", "warning", 100));
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
      flags.push(makeFlag("Holder concentration conflict between RugCheck and Helius", "warning", 100));
      safeBlocked = true;
    }
  }
  return { source: "crossvalidation", trust: 1.0, available: true, flags, forceRug, safeBlocked };
}
