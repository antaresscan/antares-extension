// api/_lib/upstream-text.ts — The one place where the TEXT of a flag still says which safe-gate reasons it stands for.
//
// The layers put the reasons on their own flags (ScanFlag.reasons / fallbackReasons) and the classifier reads those: nothing reads a
// label any more, so rewording one cannot move a verdict. The exception is the text an upstream invents: RugCheck's risk names cannot
// be known in advance, so the layer reads each one ONCE, when it creates the flag (codesFromUpstreamText), with the tables below.
// The tables are also the specification the tests hold the codes of the layers to (a flag whose label matches a pattern must say so).

import type { SafeBlockedReason } from "./types";
import type { FlagCodes } from "./helpers";

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

/** What the TEXT of a flag makes of it, by HARD_BLOCK_PATTERNS, in table order, without repeats. */
export function reasonsOfText(label: string): SafeBlockedReason[] {
  const out: SafeBlockedReason[] = [];
  for (const entry of HARD_BLOCK_PATTERNS) {
    if (entry[0].test(label) && !out.includes(entry[1])) out.push(entry[1]);
  }
  return out;
}

/**
 * What the per-source fallback reads in the TEXT of a flag, in the order it has always read it. It applies to a layer only when no
 * flag of that layer matched HARD_BLOCK_PATTERNS. Legacy: see classifySafeBlockedReasons.
 */
export function fallbackReasonsOfText(source: string, label: string): SafeBlockedReason[] {
  const out: SafeBlockedReason[] = [];
  const add = (r: SafeBlockedReason) => { if (!out.includes(r)) out.push(r); };
  if (source === "dexscreener") {
    // Per-source fallback heuristics. The patterns here mirror the
    // tightened HARD_BLOCK_PATTERNS regexes — bare /pump/ and /rug/
    // were matching legitimate flags like "Pump.fun launch" and
    // "...dev can rug liquidity" (which already classify as `lp`).
    // Tighten to the same specific pattern names.
    if (/(?:extreme |coordinated )?pump pattern|parabolic|pump.fun.*exit trap|pump.*newborn/i.test(label)) add("pump");
    if (/rug staircase|rug pattern|coordinated dump|dump and run|exit trap|exit liquidity/i.test(label)) add("rug_pattern");
    if (/wash/i.test(label)) add("wash_trading");
  }
  if (source === "solscan" || source === "helius") {
    if (/holder/i.test(label) || /wallet.*holds/i.test(label) || /top.*hold/i.test(label)) add("holders");
    if (/newborn|fresh|age|<\d+h|<\d+min/i.test(label)) add("age");
  }
  // FIX: rugcheck layer with safeBlocked but unmatched flag — treat as lp if LP-related
  if (source === "rugcheck") {
    if (/LP|liquidity/i.test(label)) add("lp");
  }
  return out;
}

/**
 * The codes of a flag whose label is text an upstream invents (RugCheck's risk names): read once, here, when the layer creates the
 * flag, and never again. This is the one place where the text of a flag still decides something: a name nobody here has seen cannot
 * be known in advance.
 */
export function codesFromUpstreamText(source: string, label: string): FlagCodes {
  return { reasons: reasonsOfText(label), fallbackReasons: fallbackReasonsOfText(source, label) };
}
