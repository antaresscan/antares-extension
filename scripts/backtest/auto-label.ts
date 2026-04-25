// scripts/backtest/auto-label.ts
//
// Pure functions that derive a ground-truth label from two snapshots
// of a token (initial + current) plus optional external oracles.
//
// Design principles:
//   - Every rule is a pure function of its inputs (testable without mocks).
//   - Each rule fires only when it has enough signal — `null` inputs do
//     not implicitly count as "no". Missing data => rule abstains.
//   - The aggregator deriveGroundTruth() requires at least 2 oracles to
//     agree to assign HIGH confidence. Single-source signals get MEDIUM
//     unless they are themselves overwhelming (e.g. liquidity collapse
//     >95% on a token that had >$5K initial liquidity).
//
// Why this matters: the backtest's headline metric (detection rate)
// only counts HIGH-confidence rows. So the bar for "this is definitely
// a rug" must be high enough that the corpus stays trustworthy.

import type {
  TokenSnapshot,
  GroundTruthLabel,
  GroundTruthVerdict,
  CorpusEntry,
  BacktestRow,
  BacktestSummary,
  ComparisonOutcome,
} from "./types";

// ─── INDIVIDUAL RULES ────────────────────────────────────────────────

/**
 * Liquidity collapse: token had real liquidity, now has almost none.
 * Strong signal of a rug (dev pulled the LP).
 *
 * Returns null when we can't decide (missing data, or initial liquidity
 * was too small for a "collapse" claim to be meaningful).
 */
export function detectLiquidityCollapse(
  initial: TokenSnapshot,
  current: TokenSnapshot,
): { collapsed: boolean; pctDrop: number } | null {
  if (initial.liquidityUsd == null || current.liquidityUsd == null) return null;
  // Need a meaningful starting point — a token that launched with $50 is
  // not "rugged" if it now has $5; it just died organically.
  if (initial.liquidityUsd < 5_000) return null;
  if (initial.liquidityUsd <= 0) return null;

  const pctDrop = 1 - (current.liquidityUsd / initial.liquidityUsd);
  return { collapsed: pctDrop >= 0.95, pctDrop };
}

/**
 * Mint authority active = the dev can still print new supply at any
 * time. Strong on-chain rug indicator if it's still active long after
 * launch (dev had every opportunity to renounce).
 */
export function detectMintAuthorityRisk(snapshot: TokenSnapshot): boolean {
  if (snapshot.mintAuthorityActive !== true) return false;
  if (snapshot.tokenAgeHours == null) return false;
  // Tokens older than 7 days that still have mint authority are intentional.
  return snapshot.tokenAgeHours >= 24 * 7;
}

/**
 * Honeypot detected post-scan: confirmed that the token blocks sells.
 * On its own this is a HIGH-confidence DANGER label.
 */
export function detectHoneypot(snapshot: TokenSnapshot): boolean {
  return snapshot.honeypot === true;
}

/**
 * Stable, long-lived, healthy token. Used to label SAFE with confidence.
 * All signals must align — partial agreement is not enough.
 */
export function detectStableSafeToken(snapshot: TokenSnapshot): boolean {
  if (snapshot.tokenAgeHours == null) return false;
  if (snapshot.tokenAgeHours < 24 * 90) return false;          // 90+ days alive
  if (snapshot.liquidityUsd == null) return false;
  if (snapshot.liquidityUsd < 10_000) return false;            // meaningful liquidity
  if (snapshot.holderCount == null || snapshot.holderCount < 500) return false;
  if (snapshot.honeypot === true) return false;
  if (snapshot.mintAuthorityActive === true) return false;
  if (snapshot.freezeAuthorityActive === true) return false;
  return true;
}

// ─── ORACLE COUNT ────────────────────────────────────────────────────

/**
 * Count how many independent oracles vote for the candidate verdict.
 * Used by the aggregator to decide HIGH vs MEDIUM confidence.
 */
function countOracles(
  candidate: GroundTruthVerdict,
  initial: TokenSnapshot,
  current: TokenSnapshot,
): { count: number; reasons: string[] } {
  const reasons: string[] = [];

  if (candidate === "RUG") {
    const liq = detectLiquidityCollapse(initial, current);
    if (liq?.collapsed) reasons.push(`Liquidity dropped ${(liq.pctDrop * 100).toFixed(1)}%`);
    if (current.rugcheckClassification === "rug") reasons.push("RugCheck classified as rug");
    if (current.solscanScamFlag === true) reasons.push("Solscan scam flag");
  } else if (candidate === "DANGER") {
    if (detectHoneypot(current)) reasons.push("Honeypot confirmed");
    if (detectMintAuthorityRisk(current)) reasons.push("Mint authority active long after launch");
    if (current.rugcheckClassification === "danger") reasons.push("RugCheck classified as danger");
    if (current.solscanScamFlag === true) reasons.push("Solscan scam flag");
  } else if (candidate === "SAFE") {
    if (detectStableSafeToken(current)) reasons.push("Stable, long-lived, no authority risks");
    if (current.rugcheckClassification === "safe") reasons.push("RugCheck classified as safe");
  }

  return { count: reasons.length, reasons };
}

// ─── AGGREGATOR ──────────────────────────────────────────────────────

/**
 * Derive a ground-truth verdict for a corpus entry. The verdict that
 * accumulates the most independent oracles wins; ties or single-source
 * signals get MEDIUM confidence; no signals at all get UNKNOWN.
 *
 * Importantly we evaluate each candidate independently — a token with
 * conflicting signals (e.g. RugCheck=safe but on-chain liquidity
 * collapsed) gets the verdict with the strongest evidence and a
 * MEDIUM confidence flag so the backtest can choose to exclude it
 * from headline metrics.
 */
export function deriveGroundTruth(
  initial: TokenSnapshot,
  current: TokenSnapshot,
): GroundTruthLabel {
  const candidates: Array<{ verdict: GroundTruthVerdict; count: number; reasons: string[] }> = [
    { verdict: "RUG", ...countOracles("RUG", initial, current) },
    { verdict: "DANGER", ...countOracles("DANGER", initial, current) },
    { verdict: "SAFE", ...countOracles("SAFE", initial, current) },
  ];

  // Sort by oracle count descending; bias towards RUG > DANGER > SAFE on ties
  // because a missed rug is always more harmful than a missed safe.
  const severity: Record<GroundTruthVerdict, number> = {
    RUG: 3,
    DANGER: 2,
    SAFE: 1,
    UNKNOWN: 0,
  };
  candidates.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return severity[b.verdict] - severity[a.verdict];
  });

  const top = candidates[0];

  if (top.count === 0) {
    return {
      verdict: "UNKNOWN",
      confidence: "LOW",
      reasons: ["No oracle reached threshold — insufficient signal"],
      oraclesAgreed: 0,
    };
  }

  // Confidence: 2+ oracles = HIGH, 1 oracle = MEDIUM (single-source).
  // Special-case: a single oracle qualifies as HIGH if it is the very
  // strong "liquidity collapse on a previously-liquid token" signal,
  // or a confirmed honeypot. Both are nearly impossible to fake.
  let confidence: "HIGH" | "MEDIUM" | "LOW";
  if (top.count >= 2) {
    confidence = "HIGH";
  } else if (
    (top.verdict === "RUG" && top.reasons.some(r => r.startsWith("Liquidity dropped"))) ||
    (top.verdict === "DANGER" && top.reasons.includes("Honeypot confirmed"))
  ) {
    confidence = "HIGH";
  } else {
    confidence = "MEDIUM";
  }

  return {
    verdict: top.verdict,
    confidence,
    reasons: top.reasons,
    oraclesAgreed: top.count,
  };
}

// ─── COMPARISON ──────────────────────────────────────────────────────

/**
 * Compare an engine verdict against a derived ground-truth label.
 *
 * Engine CAUTION is intentionally ambiguous (the engine is uncertain),
 * so we mark it as AMBIGUOUS and exclude it from headline metrics.
 * Same for ground-truth UNKNOWN.
 */
export function compareToGroundTruth(
  engine: { verdict: "SAFE" | "CAUTION" | "DANGER" | "RUG" },
  truth: GroundTruthLabel,
): ComparisonOutcome {
  if (truth.verdict === "UNKNOWN") return "AMBIGUOUS";
  if (engine.verdict === "CAUTION") return "AMBIGUOUS";

  const engineFlagged = engine.verdict === "DANGER" || engine.verdict === "RUG";
  const truthIsBad = truth.verdict === "DANGER" || truth.verdict === "RUG";

  if (engineFlagged && truthIsBad) return "TRUE_POSITIVE";
  if (!engineFlagged && !truthIsBad) return "TRUE_NEGATIVE";
  if (engineFlagged && !truthIsBad) return "FALSE_POSITIVE";
  return "FALSE_NEGATIVE";
}

// ─── SUMMARY ─────────────────────────────────────────────────────────

/**
 * Run deriveGroundTruth + compareToGroundTruth across an entire corpus
 * and aggregate the headline metrics. Only HIGH-confidence rows count
 * toward detectionRate / falsePositiveRate / falseNegativeRate so the
 * published numbers stay defensible.
 */
export function summariseCorpus(entries: CorpusEntry[]): BacktestSummary {
  const rows: BacktestRow[] = entries.map(entry => {
    const truth = deriveGroundTruth(entry.initial, entry.current);
    return {
      ca: entry.initial.ca,
      groundTruth: truth,
      engineVerdict: entry.engineVerdict,
      outcome: compareToGroundTruth(entry.engineVerdict, truth),
    };
  });

  const high = rows.filter(r => r.groundTruth.confidence === "HIGH");
  const counts: Record<ComparisonOutcome, number> = {
    TRUE_POSITIVE: 0,
    TRUE_NEGATIVE: 0,
    FALSE_POSITIVE: 0,
    FALSE_NEGATIVE: 0,
    AMBIGUOUS: 0,
  };
  for (const r of rows) counts[r.outcome]++;

  // Detection rate = TP / (TP + FN), computed on the HIGH-confidence cohort.
  // Same for FPR / FNR. Avoids divide-by-zero by returning 0.
  const highCounts = { tp: 0, tn: 0, fp: 0, fn: 0 };
  for (const r of high) {
    if (r.outcome === "TRUE_POSITIVE") highCounts.tp++;
    else if (r.outcome === "TRUE_NEGATIVE") highCounts.tn++;
    else if (r.outcome === "FALSE_POSITIVE") highCounts.fp++;
    else if (r.outcome === "FALSE_NEGATIVE") highCounts.fn++;
  }

  const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);
  const detectionRate = safeDiv(highCounts.tp, highCounts.tp + highCounts.fn);
  const falsePositiveRate = safeDiv(highCounts.fp, highCounts.fp + highCounts.tn);
  const falseNegativeRate = safeDiv(highCounts.fn, highCounts.tp + highCounts.fn);

  const scoringVersion = entries[0]?.engineVerdict.scoringVersion ?? "unknown";

  return {
    totalEntries: rows.length,
    highConfidenceEntries: high.length,
    detectionRate,
    falsePositiveRate,
    falseNegativeRate,
    outcomeCounts: counts,
    scoringVersion,
    generatedAt: Math.floor(Date.now() / 1000),
  };
}
