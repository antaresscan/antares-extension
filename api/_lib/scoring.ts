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
      const tags = f.tags ?? [];
      if (tags.includes("xv_lp_burn")) product *= XV_PENALTY_LP_BURN;
      else if (tags.includes("xv_mint_authority")) product *= XV_PENALTY_MINT_AUTH;
      else if (tags.includes("xv_age")) product *= XV_PENALTY_AGE;
      else if (tags.includes("xv_holder_concentration")) product *= XV_PENALTY_HOLDER_CONCENTRATION;
    }
  }

  return Math.round(Math.max(0, Math.min(1, product)) * 1000);
}

/**
 * The safe-gate reasons of the layers, read from the codes the layers put on their flags (ScanFlag.reasons, ScanFlag.fallbackReasons).
 * One pass over the flags, no regex: rewording a label cannot change it.
 *
 * Only a layer that is safeBlocked counts. In such a layer, the reasons of its flags count; if none of its flags has any, its fallback
 * reasons count instead (what the per-source fallback has always done). "lp" is dropped once "lp_unverified" is in.
 */
export function classifySafeBlockedReasons(layers: LayerResult[]): SafeBlockedReason[] {
  const reasons: SafeBlockedReason[] = [];
  const seen: Record<string, boolean> = {};
  function add(r: SafeBlockedReason) { if (r === "lp" && seen["lp_unverified"]) return; if (!seen[r]) { seen[r] = true; reasons.push(r); } }

  for (const layer of layers) {
    if (!layer.safeBlocked) continue;
    let matched = false;
    for (const flag of layer.flags) {
      const own = flag.reasons ?? [];
      if (own.length > 0) matched = true;
      for (const r of own) add(r);
    }
    if (!matched) {
      for (const flag of layer.flags) {
        for (const r of flag.fallbackReasons ?? []) add(r);
      }
    }
  }

  return reasons;
}
