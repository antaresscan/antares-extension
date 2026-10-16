// api/_lib/upstream-text.ts — The one place where the TEXT of a flag still says which safe-gate reasons it stands for.
//
// The layers put the reasons on their own flags (ScanFlag.reasons / fallbackReasons) and the classifier reads those: nothing reads a
// label any more, so rewording one cannot move a verdict. The exception is the text an upstream invents: RugCheck's risk names cannot
// be known in advance, so the layer reads each one ONCE, when it creates the flag (codesFromUpstreamText), with the tables below.
// The tables are also the specification the tests hold the codes of the layers to (a flag whose label matches a pattern must say so).
// The same goes for the tags (what kind of signal a flag is) and the pump percentage, further down.

import type { SafeBlockedReason, FlagTag } from "./types";
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
  [/^Mint held by the .+ bridge/i, "bridge_mint"],
  [/mint authority/i, "mint"],
  [/freeze authority/i, "freeze"],
  [/honeypot/i, "honeypot"],
  [/permanent delegate —|pausable token —|new accounts start frozen|transfer hook — a program|transfer fee can be changed/i, "token_extension"],
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
  [/top 10 hold \d+% — (elevated\b|high · established token)/i, "concentration_light"],
  [/top 10 hold \d+% — (high|extreme) concentration/i, "concentration"],
  // Single-wallet safety net (7.7.11): a single wallet >40% routes to the
  // hard "concentration" reason → DANGER/RUG. Catches the HAWK-class case
  // (one giant wallet + moderate top-10) the top-10 ladder alone misses.
  // Young-token elevated tier (7.7.12, 10-15%): soft → CAUTION max.
  // Must come BEFORE the hard "concentration" pattern so "elevated" labels
  // don't accidentally match the (high|extreme) regex below.
  [/single wallet holds \d+% — (elevated\b|high · established token)/i, "concentration_light"],
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
 * flag of that layer matched HARD_BLOCK_PATTERNS.
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
  return { reasons: reasonsOfText(label), fallbackReasons: fallbackReasonsOfText(source, label), tags: tagsOfText(label) };
}

// ─── What else the text of a flag used to say ─────────────────────────────────────────────────────────────────────────────────
// Besides the safe-gate reasons, five places read a flag's label to know what kind of flag it was. The layers now say it with FlagTag;
// these tables are what the flags of the layers are held to by the tests, and what the door above applies to an upstream's own text.

/** The liquidity pool is the subject of the flag (the LP safety net of scan.ts looked for one in every layer). */
export const LP_TEXT = /\bLP\b|liquidity (?:not|is)|dev can rug|unverified LP|holds .+% of supply|rug (?:capacity|exposure|risk|impact)/i;

/** Pipeline-status flags ("Helius unavailable"...) describe the health of a source, not the token: never counted as a token risk. */
export const SOURCE_STATUS_TEXT = /^(Helius|GoPlus|RugCheck|Solscan|DexScreener|Birdeye|Helius RPC) (unavailable|rate[- ]limited|timed out|degraded)\b|Holder data unreliable|broken upstream/i;

/**
 * Pump-only flags are informational market signals, not structural rug risks. They must remain visible to the user but must never
 * count toward the 3-warnings -> forced-DANGER threshold in determineVerdict. (They still keep a token out of SAFE: see
 * VerdictInput.pumpPriceOnlyFlagsCount.)
 */
export const PUMP_PRICE_ONLY_TEXT = /Pumped \+[\d,]+% (in 24h|over \d+ days)|Large 24h pump|Extreme pump .* on newborn token|Vertical pump detected|Extreme (24h )?pump \+[\d,]+%( in 1h)? — high retrace risk/i;

/** Something that happened to the token, or a closed trap: what the rug database asks for (with a critical flag) besides a RUG verdict. */
export const RUG_EVIDENCE_TEXT = /abandoned pool|liquidity removed|honeypot detected|sells blocked|non-transferable|creator history of rugged|slow rug detected|exit (liquidity )?trap/i;

/**
 * The flags that stay what they were for an issuer-backed token: they are about the MARKET (can anybody sell, is there a pool, did the price
 * collapse), not about the structure. A positive list on purpose: a flag nobody thought about is not promoted to a verdict.
 */
export const MARKET_HEALTH: RegExp[] = [
  /^Very low liquidity/i, /^Low liquidity/i, /^Liquidity < /i, /abandoned pool/i,
  /^Brutal dump/i, /^Significant 24h dump/i, /^Sharp 6h sell-off/i, /^Sharp crash/i, /^Slow rug detected/i, /^Active dump/i,
  /^Progressive dump/i, /^Post-ATH dump/i, /^Collapsed -/i,
  /^Honeypot detected/i, /^Cannot sell all tokens/i, /^Non-transferable token/i, /^Sells blocked/i,
];

/** The flags about how thin the pool is. A vault share is redeemed with the protocol, not sold in a pool: they stay information for it. */
export const POOL_DEPTH: RegExp[] = [/^Very low liquidity/i, /^Low liquidity/i, /^Liquidity < /i];

/** The tags the TEXT of a label gives it among the six an upstream's own text can have. */
export function tagsOfText(label: string): FlagTag[] {
  const out: FlagTag[] = [];
  if (LP_TEXT.test(label)) out.push("lp");
  if (SOURCE_STATUS_TEXT.test(label)) out.push("source_status");
  if (PUMP_PRICE_ONLY_TEXT.test(label)) out.push("pump_price_only");
  if (RUG_EVIDENCE_TEXT.test(label)) out.push("rug_evidence");
  if (MARKET_HEALTH.some((re) => re.test(label))) out.push("market_health");
  if (POOL_DEPTH.some((re) => re.test(label))) out.push("pool_depth");
  return out;
}
