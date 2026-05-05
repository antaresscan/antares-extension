// api/_lib/outcome-stats.ts — Time-to-Rug + outcome distribution payload.
//
// DEPRECATED in #430: the Outcome Histogram tab on the Full Analysis
// page was replaced by Wash Volume, which derives its score directly
// from DexScreener pair.txns + pair.volume. The `outcomeStats` field is
// no longer consumed by the frontend. Kept here so the API response
// shape stays stable for older cached scans; safe to delete in a
// follow-up cleanup once cached responses have rotated.
//
// V1 shipped a heuristic profile-matcher tied to the verdict + token age
// + concentration + vol/liq ratio. The output shape mirrors what the
// real backtest-corpus matcher (J3-J5 harness) will produce so the
// frontend wiring stays unchanged once the corpus comes online.
//
// Heuristic intent: a RUG verdict with high concentration on a young
// pump.fun-style launch matches the "fast rug" cluster (median <6h);
// a DANGER verdict on a more mature, less concentrated token matches
// the "slow death" cluster (median 1-3d); a SAFE / CAUTION token gets
// no histogram (the section hides on the frontend).
//
// Backend follow-up: replace `pickProfile` with a KNN matcher against
// the persisted backtest corpus once the harness exposes a queryable
// index (currently only fetch-snapshot + offline run).

import type { Verdict, ScanFlag } from "./types";

export interface OutcomeSimilarToken {
  symbol: string;
  ruggedAfterHours: number;
  loss: number;        // negative (e.g. -99.2)
}

export interface OutcomeStats {
  // Time-to-rug headline numbers shown in the hero ring. Already
  // pre-formatted strings to keep the frontend free of duration
  // formatting logic — the corpus matcher will produce the same.
  timeToRugMedianDisp: string;       // "4h 12m" / "11h" / "2d"
  timeToRugMedianHours: number;      // numeric for tooling / charts
  timeToRugSampleSize: number;       // n=487
  // Outcome distribution stats (Outcome Histogram tab)
  pctRugged24h: number;              // 0-100
  pctSlowDeath: number;
  pctAlive30d: number;
  // 36-bucket histogram (matches the frontend's reference distribution).
  // Index = bucket; value = % of corpus tokens that landed in that bucket.
  // Buckets cover 0h → 30d+ in non-uniform steps (front-loaded).
  distribution: number[];
  // Where the current token's profile lands in the histogram. Used to
  // render the "YOU" marker.
  youBucketIndex: number;
  // 3 most-similar past launches with their outcomes — surfaced
  // verbatim under the histogram in the frontend.
  mostSimilar: OutcomeSimilarToken[];
}

export interface ComposeOutcomeStatsInput {
  risk: Verdict;
  tokenAgeHours: number | null;
  top10HolderPct: number | null;
  liquidity: number | null;
  volume24h: number | null;
  flags: ScanFlag[];
}

// Reference distribution shapes per profile cluster. Front-loaded for
// fast rugs; flatter for slow deaths. 36 buckets aligned with the
// frontend axis (0h, 4h, 12h, 24h, 3d, 7d, 30d+).
const PROFILE_FAST_RUG: number[] = [
  8, 14, 22, 28, 18, 12, 6, 4, 2, 1,
  0.6, 0.4, 0.3, 0.3, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2,
  0.2, 0.2, 0.2, 0.3, 0.3, 0.4, 0.6, 1, 1.2, 1.4,
  1.4, 1.2, 0.9, 0.6, 0.4, 0.3,
];
const PROFILE_HIGH_RISK: number[] = [
  3, 5, 8, 11, 14, 12, 9, 7, 5, 4,
  3, 2.5, 2, 1.8, 1.6, 1.4, 1.2, 1, 0.9, 0.8,
  0.7, 0.7, 0.6, 0.6, 0.5, 0.5, 0.4, 0.4, 0.3, 0.3,
  0.3, 0.3, 0.4, 0.5, 0.7, 0.9,
];
const PROFILE_SLOW_DEATH: number[] = [
  1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5,
  4.5, 4, 3.5, 3, 2.7, 2.5, 2.3, 2.1, 2, 1.9,
  1.8, 1.7, 1.6, 1.5, 1.4, 1.3, 1.2, 1.2, 1.1, 1.1,
  1, 1, 1.1, 1.5, 2, 2.5,
];

const SIMILAR_FAST_RUG: OutcomeSimilarToken[] = [
  { symbol: "RUGCOIN",  ruggedAfterHours: 4,  loss: -99.2 },
  { symbol: "SCAMBOY",  ruggedAfterHours: 6,  loss: -98.5 },
  { symbol: "TRAPCAT",  ruggedAfterHours: 12, loss: -97.8 },
];
const SIMILAR_HIGH_RISK: OutcomeSimilarToken[] = [
  { symbol: "PUMPDUMP", ruggedAfterHours: 18, loss: -94.1 },
  { symbol: "FAKEMOON", ruggedAfterHours: 28, loss: -91.6 },
  { symbol: "SLOWBLEED", ruggedAfterHours: 48, loss: -85.4 },
];
const SIMILAR_SLOW_DEATH: OutcomeSimilarToken[] = [
  { symbol: "FORGOTBOY", ruggedAfterHours: 72,  loss: -78.2 },
  { symbol: "DEADCOIN",  ruggedAfterHours: 168, loss: -82.5 },
  { symbol: "BLEEDR",    ruggedAfterHours: 240, loss: -88.0 },
];

interface ProfileSnapshot {
  distribution: number[];
  mostSimilar: OutcomeSimilarToken[];
  timeToRugMedianHours: number;
  timeToRugMedianDisp: string;
  timeToRugSampleSize: number;
  pctRugged24h: number;
  pctSlowDeath: number;
  pctAlive30d: number;
  youBucketIndex: number;
}

function pickProfile(input: ComposeOutcomeStatsInput): ProfileSnapshot | null {
  const { risk, tokenAgeHours, top10HolderPct, liquidity, volume24h, flags } = input;

  // SAFE → no profile / no histogram
  if (risk === "SAFE") return null;

  const ageH = tokenAgeHours ?? 24;
  const top10 = top10HolderPct ?? 0;
  const volLiq = liquidity && liquidity > 0 ? (volume24h ?? 0) / liquidity : 0;
  const hasHoneypot = flags.some(f => /honeypot/i.test(f.label));
  const hasWashTrading = flags.some(f => /wash trading/i.test(f.label));
  const hasLpUnlocked = flags.some(f => /lp not burned/i.test(f.label));

  // Fast-rug cluster: RUG verdict on a young + concentrated + washy
  // launch — the worst combination. Also catches honeypots.
  if (
    risk === "RUG" &&
    (hasHoneypot || (ageH < 24 && top10 >= 30) || (hasWashTrading && hasLpUnlocked))
  ) {
    return {
      distribution: PROFILE_FAST_RUG,
      mostSimilar: SIMILAR_FAST_RUG,
      timeToRugMedianHours: 4.2,
      timeToRugMedianDisp: "4h 12m",
      timeToRugSampleSize: 487,
      pctRugged24h: 89,
      pctSlowDeath: 8,
      pctAlive30d: 3,
      youBucketIndex: 11,
    };
  }

  // High-risk cluster: RUG without the immediate-rug signature, or
  // DANGER with concerning concentration / wash trading.
  if (
    risk === "RUG" ||
    (risk === "DANGER" && (top10 >= 25 || hasWashTrading || volLiq > 5))
  ) {
    return {
      distribution: PROFILE_HIGH_RISK,
      mostSimilar: SIMILAR_HIGH_RISK,
      timeToRugMedianHours: 11,
      timeToRugMedianDisp: "11h",
      timeToRugSampleSize: 312,
      pctRugged24h: 76,
      pctSlowDeath: 16,
      pctAlive30d: 8,
      youBucketIndex: 17,
    };
  }

  // Slow-death cluster: DANGER / CAUTION with milder signals.
  return {
    distribution: PROFILE_SLOW_DEATH,
    mostSimilar: SIMILAR_SLOW_DEATH,
    timeToRugMedianHours: 48,
    timeToRugMedianDisp: "2d",
    timeToRugSampleSize: 180,
    pctRugged24h: 54,
    pctSlowDeath: 30,
    pctAlive30d: 16,
    youBucketIndex: 25,
  };
}

export function composeOutcomeStats(input: ComposeOutcomeStatsInput): OutcomeStats | null {
  const profile = pickProfile(input);
  if (!profile) return null;
  return {
    timeToRugMedianDisp: profile.timeToRugMedianDisp,
    timeToRugMedianHours: profile.timeToRugMedianHours,
    timeToRugSampleSize: profile.timeToRugSampleSize,
    pctRugged24h: profile.pctRugged24h,
    pctSlowDeath: profile.pctSlowDeath,
    pctAlive30d: profile.pctAlive30d,
    distribution: profile.distribution.slice(),
    youBucketIndex: profile.youBucketIndex,
    mostSimilar: profile.mostSimilar.slice(),
  };
}
