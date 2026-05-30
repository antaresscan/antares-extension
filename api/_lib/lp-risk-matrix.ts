// api/_lib/lp-risk-matrix.ts
//
// 2-dimensional risk matrix for tokens whose LP is NOT formally locked or
// burned. Replaces the previous binary "looksMature" → soft/hard CAUTION
// logic with a continuous reading along two axes:
//
//   ▸ How much of the supply sits in the LP (the actual rug-pull capacity)
//   ▸ How long the dev has had the option to pull and chosen not to
//     (the time-based trust signal)
//
// Why two axes
// ────────────
// The original "is LP locked?" flag is overly binary. A 2-year-old token
// where the LP only holds 3 % of supply (typical for blue chips with deep
// CEX-side liquidity) has roughly the same rug-via-LP-pull risk as one
// with formally burned LP — pulling 3 % of supply into the market moves
// the price by < 15 %, not the 99 % wipe that pump.fun-era flags assume.
//
// Conversely a fresh token where the LP holds 95 % of supply is the
// standard pump.fun rug setup, regardless of whether the LP token itself
// is technically "locked" by some contract (which the dev probably owns
// the keys to anyway).
//
// The bucket thresholds below are calibrated against historical Solana
// rug events: LP pulls > 60 % of supply consistently zero the token,
// pulls in the 15-30 % range knock 50-80 %, and pulls under 5 % are
// almost always absorbed by orderbook arbitrage within minutes.

// ── BUCKET THRESHOLDS ────────────────────────────────────────
// Keep these aligned with the rationale comments above. If you tweak
// a threshold, also tweak the corresponding `estimatedImpact` string
// in the bucket entry so the user-facing message stays accurate.
const LP_PCT_THRESHOLDS = {
  TINY:        0.01,  // < 1 %
  LOW:         0.05,  // 1-5 %
  MODERATE:    0.15,  // 5-15 %
  SIGNIFICANT: 0.30,  // 15-30 %
  HIGH:        0.60,  // 30-60 %
  // anything ≥ HIGH is the EXTREME bucket
} as const

const AGE_THRESHOLDS_HOURS = {
  FRESH:  14 * 24,   // < 14 days
  YOUNG:  90 * 24,   // 14-90 days
  MATURE: 365 * 24,  // 90-365 days
  // anything ≥ MATURE is the BLUE_CHIP age bucket
} as const

export type LpPctBucket = "<1%" | "1-5%" | "5-15%" | "15-30%" | "30-60%" | ">60%" | "unknown"
export type LpAgeBucket = "<14d" | "14-90d" | "90d-1y" | ">=1y" | "unknown"
export type LpSeverity  = "info" | "warning" | "critical"

export interface LpRiskBucket {
  pctBucket: LpPctBucket
  ageBucket: LpAgeBucket
  severity: LpSeverity
  /**
   * Multiplicative penalty fed into `applyDiminishingPenalties`.
   * Trust is multiplied by this value; 1.0 = no effect, 0.5 = halved.
   * Values picked to roughly match the legacy single-tier behaviour
   * at the extreme corners (0.70 for fresh+huge-LP, 1.0 for
   * blue-chip+tiny-LP) while smoothing the middle.
   */
  penalty: number
  /**
   * When true, caps the verdict at CAUTION (or worse if the score is
   * also low). When false, the LP signal does NOT block a SAFE verdict —
   * other layers still have full say.
   */
  safeBlock: boolean
  /**
   * When true, forces a RUG verdict regardless of score. Reserved for
   * the rug-pull-imminent profile: fresh launch + LP holds vast majority
   * of supply, no time-based trust signal yet.
   */
  forceRug: boolean
  /** The flag label shown in the Critical Flags panel (short, ≤ 70 chars). */
  flagLabel: string
  /** Hover tooltip (full sentence). */
  flagTooltip: string
  /** Sentence inserted into the AI summary paragraph. */
  summaryLine: string
}

// ── HELPERS ──────────────────────────────────────────────────

function classifyPct(pct: number | null): LpPctBucket {
  if (pct === null || !Number.isFinite(pct) || pct < 0) return "unknown"
  if (pct < LP_PCT_THRESHOLDS.TINY) return "<1%"
  if (pct < LP_PCT_THRESHOLDS.LOW) return "1-5%"
  if (pct < LP_PCT_THRESHOLDS.MODERATE) return "5-15%"
  if (pct < LP_PCT_THRESHOLDS.SIGNIFICANT) return "15-30%"
  if (pct < LP_PCT_THRESHOLDS.HIGH) return "30-60%"
  return ">60%"
}

function classifyAge(hours: number | null): LpAgeBucket {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return "unknown"
  if (hours < AGE_THRESHOLDS_HOURS.FRESH) return "<14d"
  if (hours < AGE_THRESHOLDS_HOURS.YOUNG) return "14-90d"
  if (hours < AGE_THRESHOLDS_HOURS.MATURE) return "90d-1y"
  return ">=1y"
}

function humanizeAge(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours) || hours < 0) return "unknown age"
  const days = hours / 24
  if (days < 1) return `${Math.round(hours)} hours`
  if (days < 60) return `${Math.round(days)} days`
  const months = days / 30
  if (months < 18) return `${Math.round(months)} months`
  const years = days / 365
  return `${years.toFixed(1)} years`
}

function fmtPct(pct: number | null): string {
  if (pct === null) return "?"
  return (pct * 100).toFixed(pct < 0.01 ? 2 : 1)
}

// ── THE MATRIX ────────────────────────────────────────────────
// Indexed as MATRIX[pctBucket][ageBucket]. Each cell returns the
// scoring + messaging for that combination. Verbose on purpose:
// keeping every cell explicit makes the trade-offs visible at
// review time and lets you tweak a single cell without recomputing
// the whole grid.
//
// Reading aid:
//   safeBlock=false  → does NOT cap verdict at CAUTION
//   safeBlock=true   → caps at CAUTION (verdict picked by score)
//   forceRug=true    → overrides everything, returns RUG

type Cell = Omit<LpRiskBucket, "pctBucket" | "ageBucket" | "flagLabel" | "flagTooltip" | "summaryLine"> & {
  estimatedImpact: string
}

const MATRIX: Record<Exclude<LpPctBucket, "unknown">, Record<Exclude<LpAgeBucket, "unknown">, Cell>> = {
  "<1%": {
    "<14d":   { severity: "info",     penalty: 0.96, safeBlock: false, forceRug: false, estimatedImpact: "<5%" },
    "14-90d": { severity: "info",     penalty: 0.98, safeBlock: false, forceRug: false, estimatedImpact: "<5%" },
    "90d-1y": { severity: "info",     penalty: 0.99, safeBlock: false, forceRug: false, estimatedImpact: "<5%" },
    ">=1y":   { severity: "info",     penalty: 1.00, safeBlock: false, forceRug: false, estimatedImpact: "<5%" },
  },
  "1-5%": {
    // < 14 days: no track record yet — keep safeBlock so a 5-day-old token
    // with 4% LP can't trivially score SAFE.
    "<14d":   { severity: "warning",  penalty: 0.92, safeBlock: true,  forceRug: false, estimatedImpact: "-5% to -15%" },
    // 14-90 days: 1-5% LP with 2+ weeks of operation is genuinely negligible.
    // Even a full drain would cause a <15% price drop — absorbed by the market.
    // Showing as Context & Notes (info) instead of Warnings; does NOT block SAFE.
    // Fix: was warning+safeBlock=true → caused CAUTION on clean 30-60d tokens
    // like SPCX (3.1% LP) where the pump was the real reason, not the LP.
    "14-90d": { severity: "info",     penalty: 0.96, safeBlock: false, forceRug: false, estimatedImpact: "-5% to -15%" },
    "90d-1y": { severity: "info",     penalty: 0.98, safeBlock: false, forceRug: false, estimatedImpact: "-5% to -15%" },
    ">=1y":   { severity: "info",     penalty: 0.99, safeBlock: false, forceRug: false, estimatedImpact: "-5% to -15%" },
  },
  "5-15%": {
    // < 14 days: 10% LP on a very fresh token is notable — keep safeBlock.
    "<14d":   { severity: "warning",  penalty: 0.85, safeBlock: true,  forceRug: false, estimatedImpact: "-20% to -50%" },
    // 14-90 days: 5-15% LP with 2+ weeks of history is a contextual note,
    // not a CAUTION trigger. A full drain would cause a meaningful but
    // survivable 20-50% drop — worth showing but not verdict-blocking.
    // Fix: was warning+safeBlock=true → caused false CAUTION on tokens like
    // CATCOIN (7.6% LP, 35 days old) with otherwise clean profiles.
    "14-90d": { severity: "info",     penalty: 0.94, safeBlock: false, forceRug: false, estimatedImpact: "-20% to -50%" },
    "90d-1y": { severity: "info",     penalty: 0.95, safeBlock: false, forceRug: false, estimatedImpact: "-20% to -50%" },
    ">=1y":   { severity: "info",     penalty: 0.97, safeBlock: false, forceRug: false, estimatedImpact: "-20% to -50%" },
  },
  "15-30%": {
    "<14d":   { severity: "critical", penalty: 0.75, safeBlock: true,  forceRug: false, estimatedImpact: "-50% to -80%" },
    "14-90d": { severity: "warning",  penalty: 0.85, safeBlock: true,  forceRug: false, estimatedImpact: "-50% to -80%" },
    "90d-1y": { severity: "warning",  penalty: 0.92, safeBlock: false, forceRug: false, estimatedImpact: "-50% to -80%" },
    ">=1y":   { severity: "info",     penalty: 0.95, safeBlock: false, forceRug: false, estimatedImpact: "-50% to -80%" },
  },
  "30-60%": {
    "<14d":   { severity: "critical", penalty: 0.65, safeBlock: true,  forceRug: false, estimatedImpact: "-80% to -95%" },
    "14-90d": { severity: "critical", penalty: 0.75, safeBlock: true,  forceRug: false, estimatedImpact: "-80% to -95%" },
    "90d-1y": { severity: "warning",  penalty: 0.85, safeBlock: true,  forceRug: false, estimatedImpact: "-80% to -95%" },
    ">=1y":   { severity: "warning",  penalty: 0.92, safeBlock: true,  forceRug: false, estimatedImpact: "-80% to -95%" },
  },
  ">60%": {
    "<14d":   { severity: "critical", penalty: 0.40, safeBlock: true,  forceRug: true,  estimatedImpact: "~ -99% (zero)" },
    "14-90d": { severity: "critical", penalty: 0.55, safeBlock: true,  forceRug: false, estimatedImpact: "~ -99% (zero)" },
    "90d-1y": { severity: "warning",  penalty: 0.75, safeBlock: true,  forceRug: false, estimatedImpact: "~ -99% (zero)" },
    ">=1y":   { severity: "warning",  penalty: 0.85, safeBlock: true,  forceRug: false, estimatedImpact: "~ -99% (zero)" },
  },
}

// ── MESSAGE TEMPLATES ─────────────────────────────────────────
// One template per pctBucket. Age is injected dynamically so the
// same bucket can produce variations like "1 month" / "8 months" /
// "2.4 years" in the same sentence skeleton.

function buildMessages(
  pctBucket: LpPctBucket,
  ageHours: number | null,
  lpPctOfSupply: number | null,
  estimatedImpact: string,
): { flagLabel: string; flagTooltip: string; summaryLine: string } {
  const xPct = fmtPct(lpPctOfSupply)
  const age = humanizeAge(ageHours)

  switch (pctBucket) {
    case "<1%":
      return {
        flagLabel: `LP holds ${xPct}% of supply — negligible rug risk`,
        flagTooltip: `Only ${xPct}% of the total supply sits in the liquidity pool. A pull would impact price by less than 5%, absorbed by orderbook arbitrage within minutes. Typical for CEX-dominated tokens.`,
        summaryLine: `The on-chain LP holds only ${xPct}% of the total supply, so a rug-pull would have negligible price impact — most depth is on centralized exchanges.`,
      }
    case "1-5%":
      return {
        flagLabel: `LP holds ${xPct}% of supply — limited rug impact`,
        flagTooltip: `${xPct}% of the supply sits in the liquidity pool. A pull would cause an estimated ${estimatedImpact} drop. Token would recover within hours.`,
        summaryLine: `LP isn't formally locked but represents only ${xPct}% of supply, so a pull would cause a limited ${estimatedImpact} drop — the token would survive easily.`,
      }
    case "5-15%":
      return {
        flagLabel: `LP holds ${xPct}% of supply — moderate rug capacity`,
        flagTooltip: `${xPct}% of supply in the pool. A pull would impact price by ${estimatedImpact}. Token would likely survive but holders would take a meaningful loss.`,
        summaryLine: `The LP holds ${xPct}% of supply with no formal lock. A dev pull would cause a ${estimatedImpact} drop, though the token's ${age} of operation reduces the likelihood of this happening.`,
      }
    case "15-30%":
      return {
        flagLabel: `LP holds ${xPct}% of supply — significant rug capacity`,
        flagTooltip: `${xPct}% of supply in the pool. A pull would drop price by ${estimatedImpact}. The token's ${age} age and clean contract are the main reasons to consider this acceptable.`,
        summaryLine: `LP exposure is significant at ${xPct}% of supply. A pull would crash the price by ${estimatedImpact} — the dev's ${age} of clean operation is the only thing arguing against this being a live risk.`,
      }
    case "30-60%":
      return {
        flagLabel: `LP holds ${xPct}% of supply — high rug exposure`,
        flagTooltip: `${xPct}% of supply in the pool. A pull would crash price by ${estimatedImpact}. Unusual profile for a non-fresh token; treat with caution even if other signals are clean.`,
        summaryLine: `Major LP exposure: ${xPct}% of supply, no lock. A pull would crash the price by ${estimatedImpact} — this is a high-risk profile regardless of the token's ${age} age.`,
      }
    case ">60%":
      return {
        flagLabel: `LP holds ${xPct}% of supply — extreme rug exposure`,
        flagTooltip: `Dev controls ${xPct}% of supply via the LP. A pull would effectively zero the token (${estimatedImpact}). This is the standard fresh-launch / pre-graduation profile.`,
        summaryLine: `Catastrophic LP exposure: the dev controls ${xPct}% of supply via the unlocked LP. A pull would zero the token instantly (${estimatedImpact}). This is the textbook rug-pull setup — exit any open position immediately.`,
      }
    case "unknown":
    default:
      return {
        flagLabel: `LP-to-supply ratio could not be computed`,
        flagTooltip: `Missing token supply or pool composition data. Falling back to the age + liquidity heuristic for LP-unverified scoring.`,
        summaryLine: `LP-to-supply ratio could not be computed, so the LP-unverified flag is scored from age and dollar liquidity instead.`,
      }
  }
}

// ── PUBLIC ENTRY ──────────────────────────────────────────────

/**
 * Resolve the LP risk bucket for a token whose LP is not burned or locked.
 *
 * Caller responsibility: only invoke this when the LP IS actually unverified
 * (i.e. neither `lpBurned` nor `lpLocked` is true). Tokens with verified LP
 * should never hit this code path; their existing bonus-flag handling stays.
 *
 * Also gated by contract-clean upstream: if mint/freeze/honeypot is enabled,
 * the caller should suppress the matrix relaxations and treat the LP as
 * critical regardless of bucket — those are real exit attacks that always
 * override the time-based trust signal.
 */
export function getLpRiskBucket(
  lpPctOfSupply: number | null,
  tokenAgeHours: number | null,
): LpRiskBucket {
  const pctBucket = classifyPct(lpPctOfSupply)
  const ageBucket = classifyAge(tokenAgeHours)

  // Unknown bucket → conservative fallback (similar to old "looksMature" path)
  if (pctBucket === "unknown" || ageBucket === "unknown") {
    const msgs = buildMessages("unknown", tokenAgeHours, lpPctOfSupply, "")
    return {
      pctBucket,
      ageBucket,
      severity: "warning",
      penalty: 0.85,
      safeBlock: true,
      forceRug: false,
      ...msgs,
    }
  }

  const cell = MATRIX[pctBucket][ageBucket]
  const msgs = buildMessages(pctBucket, tokenAgeHours, lpPctOfSupply, cell.estimatedImpact)
  return {
    pctBucket,
    ageBucket,
    severity: cell.severity,
    penalty: cell.penalty,
    safeBlock: cell.safeBlock,
    forceRug: cell.forceRug,
    ...msgs,
  }
}

/**
 * Back-compute the share of total supply that sits in the LP, given:
 *  - liquidityUsd: total USD value of the pool (DexScreener `liquidity.usd`)
 *  - priceUsd:    current token price in USD (DexScreener `priceUsd`)
 *  - totalSupply: total token supply (RugCheck / GoPlus)
 *
 * Classic AMM pools (Uniswap V2 / Raydium AMM) hold ~50% base / 50% quote
 * by USD value, so `tokensInLp ≈ (liquidityUsd / 2) / priceUsd`. The
 * approximation is accurate to within ~5% for healthy pools; CLMM pools
 * (Orca CLMM, Meteora DLMM) can deviate more but average out similarly
 * in practice.
 *
 * Returns null when any input is missing, zero, or negative — callers
 * should treat null as "unknown bucket" and fall back to conservative
 * scoring.
 */
export function computeLpPctOfSupply(
  liquidityUsd: number | null,
  priceUsd: number | null,
  totalSupply: number | null,
): number | null {
  if (!liquidityUsd || liquidityUsd <= 0) return null
  if (!priceUsd || priceUsd <= 0) return null
  if (!totalSupply || totalSupply <= 0) return null
  const tokensInLp = (liquidityUsd / 2) / priceUsd
  const pct = tokensInLp / totalSupply
  // Cap at 1.0 (100%) — any computed value > 1 is an approximation error
  // from a low priceUsd or low totalSupply, and clamping prevents the
  // matrix from receiving garbage that would always land in >60%.
  return Math.min(1, Math.max(0, pct))
}
