// api/scoring.ts — Final scoring, verdict & safe-block classification

import type { LayerResult, SafeBlockedReason } from "./types";
import { LAYER_WEIGHTS, TRUST_FLOOR, XV_PENALTY_LP_BURN, XV_PENALTY_MINT_AUTH, XV_PENALTY_AGE, XV_PENALTY_HOLDER_CONCENTRATION } from "./constants";

export function computeFinalScore(layers: LayerResult[]): number {
  if (layers.filter(l => l.available).some(l => l.trust === 0)) return 0;

  const weightedSources = Object.keys(LAYER_WEIGHTS);
  let totalWeight = 0;
  const availableLayers: Array<{ trust: number; weight: number }> = [];

  for (const src of weightedSources) {
    const layer = layers.find(l => l.source === src);
    const w = LAYER_WEIGHTS[src] ?? 0;
    if (!layer || !layer.available) continue;
    availableLayers.push({ trust: Math.max(TRUST_FLOOR, layer.trust), weight: w });
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

export const HARD_BLOCK_PATTERNS: Array<[RegExp, SafeBlockedReason]> = [
  [/mint authority/i, "mint"],
  [/freeze authority/i, "freeze"],
  [/honeypot/i, "honeypot"],
  [/wash trading/i, "wash_trading"],
  [/bundle|bundler/i, "bundle"],
  [/sniper/i, "sniper"],
  [/rug|dump|exit trap/i, "rug_pattern"],
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
    }
  }
  return reasons;
}
