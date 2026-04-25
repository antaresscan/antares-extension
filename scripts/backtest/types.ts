// scripts/backtest/types.ts
//
// Type contract for the historical backtest harness.
//
// The backtest answers a single question:
// "Of the tokens whose true outcome we already know (because they have
//  on-chain history we can verify), how many did our scoring engine
//  classify correctly?"
//
// To answer it we capture two snapshots of every corpus entry:
//   - `initial` — the state of the token at scan time (T+24h after launch)
//   - `current` — the state today (used to derive ground truth)
//
// Then we apply deterministic auto-label rules + optional external
// oracles (RugCheck classification, Solscan scam flag) to derive a
// HIGH/MEDIUM/LOW confidence ground-truth verdict, and compare against
// what the scoring engine output for `initial`.
//
// All shapes here are pure data — no I/O, no side effects. The auto-
// label module operates only on these types so it can be unit-tested
// without API mocks.

/** A point-in-time snapshot of a token's externally-observable state. */
export interface TokenSnapshot {
  // ─── Identity ────────────────────────────────────────────────────────
  /** Mint contract address (Solana base58). */
  ca: string;
  /** Unix epoch seconds at which this snapshot was taken. */
  capturedAt: number;

  // ─── Liquidity (DexScreener-equivalent) ──────────────────────────────
  /** Total USD liquidity across pairs at capturedAt. null = unknown. */
  liquidityUsd: number | null;

  // ─── Holder distribution (Helius / Solscan-equivalent) ───────────────
  /** Total holder count at capturedAt. */
  holderCount: number | null;
  /** Largest single holder's % of supply (0–100). */
  top1HolderPct: number | null;

  // ─── Token age ───────────────────────────────────────────────────────
  /** Hours since the mint was created. */
  tokenAgeHours: number | null;

  // ─── Authority / honeypot status (GoPlus / RugCheck-equivalent) ──────
  /** True if mint authority is still controllable by the dev. */
  mintAuthorityActive: boolean | null;
  /** True if freeze authority is still controllable by the dev. */
  freezeAuthorityActive: boolean | null;
  /** True if the contract is confirmed to block sells. */
  honeypot: boolean | null;

  // ─── LP status (RugCheck-equivalent) ─────────────────────────────────
  lpBurned: boolean | null;
  lpLocked: boolean | null;

  // ─── Trading activity ────────────────────────────────────────────────
  /** USD volume in the 24h before capturedAt. */
  volume24hUsd: number | null;

  // ─── External oracle classifications (optional, for multi-oracle GT) ─
  /**
   * RugCheck's published classification at capturedAt, if known.
   * Used as one of the oracles in deriveGroundTruth — does NOT directly
   * become the ground truth on its own; we require multi-oracle agreement.
   */
  rugcheckClassification: "safe" | "danger" | "rug" | null;
  /** Solscan's scam tag, if set. */
  solscanScamFlag: boolean | null;
}

/** What the scoring engine output for the `initial` snapshot. */
export interface EngineVerdict {
  /** The verdict bucket the engine assigned. */
  verdict: "SAFE" | "CAUTION" | "DANGER" | "RUG";
  /** Engine score 0–1000 at scan time. */
  score: number;
  /** Engine version that produced this verdict. */
  scoringVersion: string;
}

/** Possible ground-truth outcomes derived from observing token history. */
export type GroundTruthVerdict = "RUG" | "DANGER" | "SAFE" | "UNKNOWN";

/** A derived ground-truth label, with reasoning so it stays auditable. */
export interface GroundTruthLabel {
  verdict: GroundTruthVerdict;
  /**
   * HIGH — multi-oracle agreement OR a single high-confidence on-chain
   *        signal (e.g. liquidity collapse > 95%).
   * MEDIUM — single oracle, or weaker on-chain signal.
   * LOW — only one weak signal; should be excluded from headline metrics.
   */
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Human-readable reasons that triggered this verdict. */
  reasons: string[];
  /** Number of independent oracles that voted for this verdict. */
  oraclesAgreed: number;
}

/** A single corpus entry: the snapshots, the engine output, the truth. */
export interface CorpusEntry {
  /** Snapshot at scan time (T+24h after token launch, typically). */
  initial: TokenSnapshot;
  /**
   * Snapshot taken later (typically 7–90 days after `initial`) and used
   * to derive ground truth. Must be `capturedAt` > initial.capturedAt.
   */
  current: TokenSnapshot;
  /** What the engine said for `initial`. */
  engineVerdict: EngineVerdict;
}

/** Outcome of comparing one corpus entry: was the engine right? */
export type ComparisonOutcome =
  | "TRUE_POSITIVE"   // Engine flagged DANGER/RUG, ground truth confirms
  | "TRUE_NEGATIVE"   // Engine said SAFE, ground truth confirms SAFE
  | "FALSE_POSITIVE"  // Engine flagged DANGER/RUG, ground truth says SAFE
  | "FALSE_NEGATIVE"  // Engine said SAFE, ground truth says DANGER/RUG
  | "AMBIGUOUS";      // Engine CAUTION, or ground truth UNKNOWN — not scored

/** A single scored row of the backtest output. */
export interface BacktestRow {
  ca: string;
  groundTruth: GroundTruthLabel;
  engineVerdict: EngineVerdict;
  outcome: ComparisonOutcome;
}

/** Aggregated headline metrics across the full corpus. */
export interface BacktestSummary {
  /** Total entries in the corpus. */
  totalEntries: number;
  /** Entries with HIGH-confidence ground truth (the headline cohort). */
  highConfidenceEntries: number;
  /** Detection rate on HIGH-confidence cohort: TP / (TP + FN). */
  detectionRate: number;
  /** False-positive rate on HIGH-confidence cohort: FP / (FP + TN). */
  falsePositiveRate: number;
  /** False-negative rate on HIGH-confidence cohort: FN / (TP + FN). */
  falseNegativeRate: number;
  /** Counts per outcome bucket. */
  outcomeCounts: Record<ComparisonOutcome, number>;
  /** Engine version this summary describes. */
  scoringVersion: string;
  /** Unix seconds at which this summary was generated. */
  generatedAt: number;
}
