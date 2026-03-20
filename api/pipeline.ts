// api/pipeline.ts — Pure decision functions extracted from scan.ts handler
// Session 1: Zero side-effects, zero console.log, zero async.

import type {
  ScanFlag, Verdict, SafeBlockedReason,
  PostLayerFlagsInput, PostLayerFlagsResult,
  SafeGateInput, EstablishedBonusInput, VerdictInput,
  SolscanTransfer,
} from "./types";
import { makeFlag } from "./helpers";

// ─── BLOCK E: Post-layer flags ──────────────────────────────────────────────
export function evaluatePostLayerFlags(input: PostLayerFlagsInput): PostLayerFlagsResult {
  const flags: ScanFlag[] = [];
  let forceRug = false;
  let safeBlocked = false;

  // [2.5] Social honeypot detection
  if (input.sells5m === 0 && input.buys5m > 10 && input.liqUsd > 5000 && input.ageMin > 30) {
    flags.push(makeFlag("Sells blocked (social honeypot)", "critical", 0));
    forceRug = true;
  }

  // [2.6] Wash trading detection via transfers
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

  // [2.7] Pump.fun bonding curve guard
  if (input.ageMin > 0 && input.ageMin < 60 && input.volLiqRatio > 15) {
    flags.push(makeFlag("Pump.fun-style launch: <1h + vol/liq >15 — DANGER", "critical", 0));
    safeBlocked = true;
  }

  // [5.1] Creator reputation — flag serial deployers
  if (input.creatorReputation?.flagged && input.creatorReputation.reason) {
    flags.push(makeFlag(input.creatorReputation.reason, "critical", 0));
    safeBlocked = true;
  }

  return { flags, forceRug, safeBlocked };
}

// ─── BLOCK F: Safe gate override ────────────────────────────────────────────
export function applySafeGateOverride(input: SafeGateInput): boolean {
  if (!input.safeBlocked) return false;
  if (input.forceRug) return true;

  const SOFT_REASONS: Record<string, boolean> = { age: true, holders: true };
  const onlySoftReasons = input.safeBlockedReasons.length > 0 &&
    input.safeBlockedReasons.every(r => SOFT_REASONS[r] === true);

  if (onlySoftReasons &&
      (input.holders ?? 0) > 500 && input.lpBurned && input.goPlusClean) {
    return false; // unlocked
  }

  return true; // stays blocked
}

// ─── BLOCK G: Established token bonus ───────────────────────────────────────
export function applyEstablishedBonus(input: EstablishedBonusInput): number {
  if (input.tokenAgeHours !== null && input.tokenAgeHours > 720 &&
      (input.holders ?? 0) > 1000 && input.lpBurned && input.goPlusClean) {
    return Math.min(1000, Math.round(input.score * 1.15));
  }
  return input.score;
}

// ─── BLOCK H: Verdict determination ────────────────────────────────────────
export function determineVerdict(input: VerdictInput): Verdict {
  if (input.forceRug)                                   return "RUG";
  if (input.sourcesUsedCount === 0)                     return "DANGER";
  if (input.safeBlocked && input.score >= 600)          return "CAUTION";
  if (input.safeBlocked)                                return "DANGER";
  // SAFE threshold raised to 850 (from 800) — ref: P3
  if (input.score >= 850)                               return "SAFE";
  if (input.score >= 600)                               return "CAUTION";
  if (input.score >= 350)                               return "DANGER";
  return "RUG";
}
