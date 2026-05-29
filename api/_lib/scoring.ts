// api/scoring.ts — Final scoring, verdict & safe-block classification

import type { LayerResult, SafeBlockedReason } from "./types";
import { LAYER_WEIGHTS, TRUST_FLOOR, XV_PENALTY_LP_BURN, XV_PENALTY_MINT_AUTH, XV_PENALTY_AGE, XV_PENALTY_HOLDER_CONCENTRATION } from "./constants";

export function computeFinalScore(layers: LayerResult[]): number {
  if (layers.filter(l => l.available).some(l => l.trust === 0)) return 0;

  const weightedSources = Object.keys(LAYER_WEIGHTS);
  let totalWeight = 0;
  const availableLayers: Array<{ trust: number; weight: number; source: string }> = [];

  for (const src of weightedSources) {
    const layer = layers.find(l => l.source === src);
    const w = LAYER_WEIGHTS[src] ?? 0;
    if (!layer || !layer.available) continue;
    availableLayers.push({ trust: Math.max(TRUST_FLOOR, layer.trust), weight: w, source: src });
    totalWeight += w;
  }

  if (!totalWeight || totalWeight <= 0) return 0;

  let product = 1.0;
  for (const { trust, weight } of availableLayers) {
    const normalizedWeight = weight / totalWeight;
    product *= Math.pow(trust, normalizedWeight);
  }

  const xv = layers.find(l => l.source === "crossvalidation");
  if (xv?.available && xv.flags.length > 0) {
    for (const f of xv.flags) {
      if (/LP burn conflict/i.test(f.label)) product *= XV_PENALTY_LP_BURN;
      else if (/Mint authority conflict/i.test(f.label)) product *= XV_PENALTY_MINT_AUTH;
      else if (/age conflict/i.test(f.label)) product *= XV_PENALTY_AGE;
      else if (/holder concentration/i.test(f.label)) product *= XV_PENALTY_HOLDER_CONCENTRATION;
    }
  }

  return Math.round(Math.max(0, Math.min(1, product)) * 1000);
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
  // Single-wallet concentration of 10% or more is a HARD block.
  //
  // Founder rule (2026-05-28): "si un wallet du top 10 dépasse 10%
  // c'est danger automatiquement". Since the top-10 list is sorted by
  // holdings, this reduces to "top-1 > 10%" — the regex captures
  // any flag mentioning "single wallet holds X% of supply" where X
  // is 10-99 or 100+.
  //
  // The previous tiered approach (15%+ hard, 10-14% "concentration_
  // warning" soft) was reframed because:
  //   - 10-14% wallets had let RIV-class tokens land on SAFE when
  //     paired with established-token signals
  //   - asymmetric risk: missing a small pump on a clean token is
  //     a much smaller loss than getting rugged at 11%
  //   - simpler rule = easier to reason about + harder to misclassify
  //
  // Regex split into two tiers (founder rule 2026-05-29):
  //   10–14%: "concentration_light" → soft reason → max CAUTION, never SAFE
  //   15%+:   "concentration"       → hard reason → DANGER or RUG, never CAUTION
  //
  // 10-14% regex: `1[0-4]` matches 10, 11, 12, 13, 14.
  // 15%+  regex: `1[5-9]|[2-9]\d|\d{3,}` matches 15-19, 20-99, 100+.
  [/single wallet holds 1[0-4]% of supply/i, "concentration_light"],
  [/single wallet holds (1[5-9]|[2-9]\d|\d{3,})% of supply/i, "concentration"],
  [/top 1 holder > 20%/i, "concentration"],
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
