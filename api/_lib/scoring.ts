// api/scoring.ts — Final scoring, verdict & safe-block classification

import type { LayerResult, ScanFlag, SafeBlockedReason } from "./types";

// ═══ ADDITIVE SCORING MODEL ══════════════════════════════════════════════════
//
// Replaces the previous per-layer geometric-mean trust model. Every flag now
// carries its own point cost in `impact` (positive = deduct, negative = bonus,
// set by the layer that raises it). The final score is a flat additive
// deduction from 1000 across every flag from every layer + pipeline check,
// not a weighted product of per-layer trust scores.
//
// Why: the old model let layer WEIGHTS (not flag severity) decide how much a
// problem mattered, and one bad flag on a low-weight layer could get diluted
// by clean scores elsewhere. The additive model makes each flag's cost
// explicit and comparable regardless of which layer raised it.
//
// Stacking dampening — sort flags worst-first, then weight by rank:
//   1st (worst)     → 100%
//   2nd             → 75%
//   3rd             → 50%
//   4th and beyond  → 25% (plateau, not a return to 0%)
// This means real additional flags always make the score worse (no ceiling
// on how many flags "count"), while a handful of moderate, uncorroborated
// signals can't alone crash a token to RUG — that still takes either one
// severe/structural flag or several flags stacking together.
const STACK_WEIGHTS = [1, 0.75, 0.5];
const STACK_PLATEAU_WEIGHT = 0.25;

export function computeFinalScore(flags: ScanFlag[]): number {
  const deductions = flags
    .map(f => f.impact)
    .filter(points => points > 0)
    .sort((a, b) => b - a);

  let totalDeduction = 0;
  deductions.forEach((points, i) => {
    totalDeduction += points * (STACK_WEIGHTS[i] ?? STACK_PLATEAU_WEIGHT);
  });

  // Bonus flags (negative impact) add back flat, undamped points — clean
  // contracts aren't penalized for lacking bonuses, but genuine positive
  // signals (LP burned, established token, well-distributed supply) still
  // nudge the score up.
  const bonusTotal = flags
    .map(f => f.impact)
    .filter(points => points < 0)
    .reduce((sum, points) => sum + Math.abs(points), 0);

  return Math.max(0, Math.min(1000, Math.round(1000 - totalDeduction + bonusTotal)));
}

// HARD_BLOCK_PATTERNS: flags that classify as hard safeBlocked reasons.
// CRITICAL: 'lp' is a HARD reason — LP not burned/locked can NEVER be soft-unlocked.
// Without this, LP-flagged tokens had safeBlockedReasons=[] which caused
// the safe gate to fall through and allow SAFE verdicts on rug-able tokens.
export const HARD_BLOCK_PATTERNS: Array<[RegExp, SafeBlockedReason]> = [
  // ── LP RISK MATRIX (SCORING_VERSION 7.6.0+) ───────────────────────────────
  // The 2-axis matrix (api/_lib/lp-risk-matrix.ts) produces 6 distinct flag
  // labels keyed off bucket severity. Critical buckets (LP 30 %+ of supply,
  // or any %  with `forceRug=true`) classify as hard "lp"; info/warning
  // buckets classify as soft "lp_unverified" (eligible for safe-gate unlock
  // via established-token signals). Order matters — the critical regex must
  // win before the general "LP holds" matcher.
  [/(high|extreme) rug exposure|dev can rug/i, "lp"],
  [/LP holds [\d.]+% of supply|LP-to-supply ratio could not be computed/i, "lp_unverified"],
  // Legacy labels (pre-7.6.0). Kept for cached/stored scans that pre-date
  // the matrix refactor. Safe to remove after the cache fully cycles.
  [/unverified LP|LP not burned but token is mature/i, "lp_unverified"],
  [/LP not burned|LP not locked/i, "lp"],
  [/mint authority/i, "mint"],
  [/freeze authority/i, "freeze"],
  [/honeypot/i, "honeypot"],
  [/wash trading/i, "wash_trading"],
  [/bundle|bundler/i, "bundle"],
  [/sniper/i, "sniper"],
  // rug_pattern matches actual chart/behaviour patterns, NOT every flag
  // that happens to contain the word "rug". Previous regex /rug|dump|.../
  // false-positive-classified the LP flag "LP not burned or locked — dev
  // can rug liquidity" as both "lp" AND "rug_pattern", which double-
  // counted hard reasons and made it impossible to soft-unlock even
  // mature tokens whose only real issue was unverified LP.
  // New regex requires specific pattern names rather than the bare word.
  [/rug staircase|rug pattern|coordinated dump|dump and run|exit trap|exit liquidity/i, "rug_pattern"],
  // pump pattern: same caveat. Bare /pump/ matched legitimate flags like
  // "Pump.fun launch" which is informational, not a hard exit-trap signal.
  [/(?:extreme |coordinated )?pump pattern|parabolic|pump.fun.*exit trap|pump.*newborn/i, "pump"],
  [/chart|blow-off|stair-step|volume exhaustion|liquidity mirage/i, "chart"],
  [/buy\/sell imbalance/i, "pump_imbalance"],
  [/deceptive name/i, "deceptive_name"],                         // FIX: deceptive names are hard
    [/very few holders|few holders|<15|<50/i, "low_holders"], // FIX: very low holders is a HARD reason
  // Top-10 distribution concentration (7.7.5+, 2-tier system).
  // Two tiers: fresh tokens (stricter) vs established tokens (looser).
  //
  // "elevated" labels (soft → max CAUTION, never SAFE):
  //   Fresh:       "Top 10 hold X% — elevated concentration · cluster risk"
  //   Established: "Top 10 hold X% — elevated · exchanges may be included"
  //   → Both caught by /elevated\b/ word-boundary match.
  //
  // "high / extreme" labels (hard → DANGER/RUG, no exceptions):
  //   Fresh:       "Top 10 hold X% — high concentration · control risk"
  //   Established: "Top 10 hold X% — high concentration"
  //   Both:        "Top 10 hold X% — extreme concentration"
  //   → Caught by /(high|extreme) concentration/.
  [/top 10 hold \d+% — elevated\b/i, "concentration_light"],
  [/top 10 hold \d+% — (high|extreme) concentration/i, "concentration"],
  // Single-wallet safety net (7.7.11): a single wallet >40% routes to the
  // hard "concentration" reason → DANGER/RUG. Catches the HAWK-class case
  // (one giant wallet + moderate top-10) the top-10 ladder alone misses.
  // Young-token elevated tier (7.7.12, 10-15%): soft → CAUTION max.
  // Must come BEFORE the hard "concentration" pattern so "elevated" labels
  // don't accidentally match the (high|extreme) regex below.
  [/single wallet holds \d+% — elevated\b/i, "concentration_light"],
  [/single wallet holds \d+% — (high|extreme) concentration/i, "concentration"],
];

export function classifySafeBlockedReasons(layers: LayerResult[]): SafeBlockedReason[] {
  const reasons: SafeBlockedReason[] = [];
  const seen: Record<string, boolean> = {};
  function add(r: SafeBlockedReason) { if (r === "lp" && seen["lp_unverified"]) return; if (!seen[r]) { seen[r] = true; reasons.push(r); } }

  for (const layer of layers) {
    if (!layer.safeBlocked) continue;
    let matched = false;
    for (const flag of layer.flags) {
      for (const entry of HARD_BLOCK_PATTERNS) {
        if (entry[0].test(flag.label)) { add(entry[1]); matched = true; }
      }
    }
    if (!matched) {
      if (layer.source === "dexscreener") {
        // Per-source fallback heuristics. The patterns here mirror the
        // tightened HARD_BLOCK_PATTERNS regexes — bare /pump/ and /rug/
        // were matching legitimate flags like "Pump.fun launch" and
        // "...dev can rug liquidity" (which already classify as `lp`).
        // Tighten to the same specific pattern names.
        for (const f of layer.flags) {
          if (/(?:extreme |coordinated )?pump pattern|parabolic|pump.fun.*exit trap|pump.*newborn/i.test(f.label)) add("pump");
          if (/rug staircase|rug pattern|coordinated dump|dump and run|exit trap|exit liquidity/i.test(f.label)) add("rug_pattern");
          if (/wash/i.test(f.label)) add("wash_trading");
        }
      }
      if (layer.source === "solscan" || layer.source === "helius") {
        for (const f of layer.flags) {
          if (/holder/i.test(f.label) || /wallet.*holds/i.test(f.label) || /top.*hold/i.test(f.label)) add("holders");
          if (/newborn|fresh|age|<\d+h|<\d+min/i.test(f.label)) add("age");
        }
      }
      // FIX: rugcheck layer with safeBlocked but unmatched flag — treat as lp if LP-related
      if (layer.source === "rugcheck") {
        for (const f of layer.flags) {
          if (/LP|liquidity/i.test(f.label)) add("lp");
        }
      }
    }
  }

  return reasons;
}
