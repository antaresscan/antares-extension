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
  [/unverified LP|LP not burned but token is mature/i, "lp_unverified"],
  [/LP not burned|LP not locked|dev can rug/i, "lp"],           // FIX: LP is now a HARD reason
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
  [/deceptive name/i, "deceptive_name"],                         // FIX: deceptive names are hard
    [/very few holders|few holders|<15|<50/i, "low_holders"], // FIX: very low holders is a HARD reason
  // Single-wallet concentration of 15% or more cannot soft-unlock.
  // Layers.ts emits the flag as critical at this threshold; we trap
  // it here as a hard reason so applySafeGateOverride keeps the gate
  // closed and verdict.ts routes the score band to DANGER/RUG.
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
        for (const f of layer.flags) {
          if (/pump|exit trap/i.test(f.label)) add("pump");
          if (/rug|dump/i.test(f.label)) add("rug_pattern");
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
