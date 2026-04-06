// api/pipeline.ts — Pure decision functions extracted from scan.ts handler

import type {
  ScanFlag, Verdict,
  PostLayerFlagsInput, PostLayerFlagsResult,
  SafeGateInput, EstablishedBonusInput, VerdictInput,
} from "./types";
import { makeFlag } from "./helpers";

export function evaluatePostLayerFlags(input: PostLayerFlagsInput): PostLayerFlagsResult {
  const flags: ScanFlag[] = [];
  let forceRug = false;
  let safeBlocked = false;

  const totalTxns5m = (input.buys5m ?? 0) + (input.sells5m ?? 0);

  if (
    input.sells5m === 0 &&
    input.buys5m > 10 &&
    input.liqUsd > 5000 &&
    input.ageMin > 30 &&
    totalTxns5m > 5
  ) {
    flags.push(makeFlag("Sells blocked (social honeypot)", "critical", 0));
    forceRug = true;
    safeBlocked = true;
  }

  if (Array.isArray(input.recentTransfers) && input.recentTransfers.length >= 10) {
    const wallets = new Set<string>();
    for (const tx of input.recentTransfers) {
      const from = tx.from_address ?? tx.from;
      const to = tx.to_address ?? tx.to;
      if (typeof from === "string") wallets.add(from);
      if (typeof to === "string") wallets.add(to);
    }
    if (wallets.size <= 3) {
      flags.push(makeFlag("Wash trading via transfers (\u22643 unique wallets in 10+ txs)", "critical", 0));
      forceRug = true;
    }
  }

  if (input.ageMin > 0 && input.ageMin < 60 && input.volLiqRatio > 15) {
    flags.push(makeFlag("Pump.fun-style launch: <1h + vol/liq >15 \u2014 DANGER", "critical", 0));
    safeBlocked = true;
  }

  if (input.creatorReputation?.flagged && input.creatorReputation.reason) {
    flags.push(makeFlag(input.creatorReputation.reason, "critical", 0));
    safeBlocked = true;
  }

  return { flags, forceRug, safeBlocked };
}

export function applySafeGateOverride(input: SafeGateInput): boolean {
  if (!input.safeBlocked) return false;
  if (input.forceRug) return true;

  // HARD reasons can NEVER be soft-unlocked regardless of age, holders, or source count.
  // 'lp': dev can pull liquidity at any time — fundamentally unacceptable for SAFE verdict.
  // 'deceptive_name': intentional fraud signal, not a maturity issue.
  const HARD_REASONS = new Set([
    "lp", "mint", "freeze", "honeypot", "copycat", "deceptive_name",
    "rug_pattern", "wash_trading", "pump", "bundle", "sniper", "chart",
  ]);
  const hasHardReason = input.safeBlockedReasons.some(r => HARD_REASONS.has(r));
  if (hasHardReason) return true; // Always keep safeBlocked for hard reasons

  // Only 'age' and 'holders' are soft reasons that can potentially unlock
  const SOFT_REASONS: Record<string, boolean> = { age: true, holders: true };
  const onlySoftReasons = input.safeBlockedReasons.length > 0 &&
    input.safeBlockedReasons.every(r => SOFT_REASONS[r] === true);

  if (onlySoftReasons) {
    const ageHours = input.tokenAgeHours ?? 0;
    if (input.tokenAgeHours !== null && ageHours < 48) return true;
    const hasEnoughSources = input.sourcesAvailableCount >= 5;
    // ALL conditions must be met to unlock: age>48h, 5+ sources, 1000+ holders, LP burned, GoPlus clean
    if (
      (input.tokenAgeHours === null || ageHours > 48) &&
      hasEnoughSources &&
      (input.holders ?? 0) > 1000 &&
      input.lpBurned &&
      input.goPlusClean
    ) {
      return false;
    }
  }

  // safeBlockedReasons is empty (unclassified) — keep blocked by default
  return true;
}

export function applyEstablishedBonus(input: EstablishedBonusInput): number {
  // Require 90 days, 5000 holders, LP burned AND GoPlus clean to get bonus
  if (
    input.tokenAgeHours !== null &&
    input.tokenAgeHours > 2160 &&
    (input.holders ?? 0) > 5000 &&
    input.lpBurned &&
    input.goPlusClean
  ) {
    return Math.min(1000, Math.round(input.score * 1.05));
  }
  return input.score;
}

export function determineVerdict(input: VerdictInput): Verdict {
  if (input.forceRug) return "RUG";
  if (!input.sourcesUsedCount || input.sourcesUsedCount <= 0) return "DANGER";

  if (input.safeBlocked) {
    // HARD reasons: 'lp' and 'deceptive_name' added alongside existing hard reasons.
    // A token where LP is not burned can rug at any time — must return DANGER or RUG.
    const HARD_REASONS = new Set([
      "lp", "deceptive_name",
      "honeypot", "mint", "freeze", "bundle", "rug_pattern",
      "wash_trading", "sniper", "pump", "chart",
    ]);
    const hasHardReason = input.safeBlockedReasons?.some(r => HARD_REASONS.has(r));
    if (hasHardReason) return input.score >= 400 ? "DANGER" : "RUG";
    // Soft reasons (age/holders) only: tightened from 550 to 700 for CAUTION
    if (input.score >= 700) return "CAUTION";
    return "DANGER";
  }

  // HARDENED: SAFE requires score >= 900 AND at least 5 sources
  if (input.score >= 900 && input.sourcesUsedCount >= 5) return "SAFE";
  if (input.score >= 600) return "CAUTION";
  if (input.score >= 350) return "DANGER";
  return "RUG";
}
