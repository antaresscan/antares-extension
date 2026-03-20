// api/scoring.ts — Final scoring, verdict & safe-block classification

import type { LayerResult, SafeBlockedReason } from "./types";
import { LAYER_WEIGHTS, TRUST_FLOOR, XV_PENALTY_LP_BURN, XV_PENALTY_MINT_AUTH, XV_PENALTY_AGE } from "./constants";

// ═══ SCORING FINAL ═══════════════════════════════════════════════════════════════
export function computeFinalScore(layers: LayerResult[]): number {
  const sources = ["dexscreener","rugcheck","goplus","helius","solscan","chart"] as const;
  let product = 1.0;
  let totalWeight = 0;
  for (const src of sources) {
    const layer = layers.find(l => l.source === src);
    const w = LAYER_WEIGHTS[src];
    if (!layer || !layer.available) continue;
    product *= Math.pow(Math.max(TRUST_FLOOR, layer.trust), w);
    totalWeight += w;
  }
  if (totalWeight === 0) return 0;
  product = Math.pow(product, 1 / totalWeight);
  const identity = layers.find(l => l.source === "identity");
  if (identity?.available) product *= identity.trust;
  const xv = layers.find(l => l.source === "crossvalidation");
  if (xv?.available && xv.flags.length > 0) {
    for (const f of xv.flags) {
      if (/LP burn conflict/i.test(f.label)) product *= XV_PENALTY_LP_BURN;
      else if (/Mint authority conflict/i.test(f.label)) product *= XV_PENALTY_MINT_AUTH;
      else if (/age conflict/i.test(f.label)) product *= XV_PENALTY_AGE;
    }
  }
  return Math.round(Math.max(0, Math.min(1, product)) * 1000);
}

// ─── [2.3] SAFE-BLOCK REASON CLASSIFIER ────────────────────────────────────
export const HARD_BLOCK_PATTERNS: Array<[RegExp, SafeBlockedReason]> = [
  [/mint authority/i, "mint"],
  [/freeze authority/i, "freeze"],
  [/honeypot/i, "honeypot"],
  [/copycat|brand imitation/i, "copycat"],
  [/wash trading/i, "wash_trading"],
  [/bundle|bundler/i, "bundle"],
  [/sniper/i, "sniper"],
  [/rug|dump|exit trap/i,"rug_pattern"],
  [/pump|parabolic/i, "pump"],
  [/chart|blow-off|stair-step|volume exhaustion|liquidity mirage/i, "chart"],
];

export function classifySafeBlockedReasons(layers: LayerResult[]): SafeBlockedReason[] {
  const reasons: SafeBlockedReason[] = [];
  const seen: Record<string, boolean> = {};
  function add(r: SafeBlockedReason) { if (!seen[r]) { seen[r] = true; reasons.push(r); } }
  for (const layer of layers) {
    if (!layer.safeBlocked) continue;
    let matched = false;
    for (const flag of layer.flags) {
      for (const entry of HARD_BLOCK_PATTERNS) {
        if (entry[0].test(flag.label)) { add(entry[1]); matched = true; }
      }
    }
    if (!matched) {
      if (layer.source === "solscan" || layer.source === "helius") {
        for (const f of layer.flags) {
          if (/holder/i.test(f.label) || /wallet.*holds/i.test(f.label) || /top.*hold/i.test(f.label)) add("holders");
          if (/newborn|fresh|age|<\d+h|<\d+min/i.test(f.label)) add("age");
        }
      }
    }
  }
  return reasons;
}
