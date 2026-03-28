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

  // Fix: require at least 5 total transactions to avoid false positives on brand-new tokens
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
  }

  if (Array.isArray(input.recentTransfers) && input.recentTransfers.length >= 10) {
    const wallets = new Set<string>();
    for (const tx of input.recentTransfers) {
      const from = tx.from_address ?? tx.from;
      const to   = tx.to_address   ?? tx.to;
      if (typeof from === "string") wallets.add(from);
      if (typeof to   === "string") wallets.add(to);
    }
    if (wallets.size <= 3) {
      flags.push(makeFlag("Wash trading via transfers (≤3 unique wallets in 10+ txs)", "critical", 0));
      forceRug = true;
    }
  }

  if (input.ageMin > 0 && input.ageMin < 60 && input.volLiqRatio > 15) {
    flags.push(makeFlag("Pump.fun-style launch: <1h + vol/liq >15 — DANGER", "critical", 0));
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
  const SOFT_REASONS: Record<string, boolean> = { age: true, holders: true };
  const onlySoftReasons = input.safeBlockedReasons.length > 0 &&
    input.safeBlockedReasons.every(r => SOFT_REASONS[r] === true);
  if (onlySoftReasons) {
    const ageHours = input.tokenAgeHours ?? 0;
    const hasEnoughSources = input.sourcesAvailableCount >= 4;
    if ((input.holders ?? 0) > 500 && input.lpBurned && input.goPlusClean) {
      return false;
    }
    if (ageHours > 24 && hasEnoughSources && (input.holders ?? 0) > 200 && input.goPlusClean) {
      return false;
    }
  }
  return true;
}

export function applyEstablishedBonus(input: EstablishedBonusInput): number {
  if (
    input.tokenAgeHours !== null &&
    input.tokenAgeHours > 720 &&
    (input.holders ?? 0) > 1000 &&
    input.lpBurned &&
    input.goPlusClean
  ) {
    return Math.min(1000, Math.round(input.score * 1.15));
  }
  return input.score;
}

export function determineVerdict(input: VerdictInput): Verdict {
  if (input.forceRug) return "RUG";
  if (input.sourcesUsedCount === 0) return "DANGER";

  if (input.safeBlocked) {
    const HARD_REASONS = new Set(["honeypot", "mint", "freeze", "bundle", "rug_pattern", "wash_trading", "sniper", "pump"]);
    const hasHardReason = input.safeBlockedReasons?.some(r => HARD_REASONS.has(r));
    if (hasHardReason) return input.score >= 400 ? "DANGER" : "RUG";
    if (input.score >= 550) return "CAUTION";
    return "DANGER";
  }

  if (input.score >= 850) return "SAFE";
  if (input.score >= 600) return "CAUTION";
  if (input.score >= 350) return "DANGER";
  return "RUG";
}
