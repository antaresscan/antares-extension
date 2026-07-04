// api/pipeline.ts — Pure decision functions extracted from scan.ts handler

import type {
  ScanFlag, Verdict,
  PostLayerFlagsInput, PostLayerFlagsResult,
  SafeGateInput, EstablishedBonusInput, VerdictInput,
} from "./types";
import { makeFlag } from "./helpers";
import { HARD_BLOCK_REASONS, SOFT_REASONS } from "./constants";
import { isKnownDaoTreasury } from "./known-treasuries";

export function evaluatePostLayerFlags(input: PostLayerFlagsInput): PostLayerFlagsResult {
  const flags: ScanFlag[] = [];
  let forceRug = false;
  let safeBlocked = false;

  const totalTxns5m = (input.buys5m ?? 0) + (input.sells5m ?? 0);

  // Social honeypot pattern: a fresh token where coordinated buyers all
  // pile in but the contract blocks sells (or sells are otherwise faked).
  // The signature is: brand-new token + thin scammer-controlled liquidity
  // + many buys + zero sells. We require BOTH lower AND upper bounds on
  // age and liquidity, otherwise the check misfires on established tokens
  // that simply happen to have a buy-only 5-minute window (e.g. FARTCOIN
  // with $7.5M liq and 18+ months age was getting flagged as RUG when a
  // quiet 5-min slice showed only buys — the kind of normal noise an
  // actively-traded mid-cap produces).
  const ageInHoneypotWindow = input.ageMin > 30 && input.ageMin < 720;
  const liqInHoneypotWindow = input.liqUsd > 5000 && input.liqUsd < 80_000;

  if (
    input.sells5m === 0 &&
    input.buys5m > 10 &&
    liqInHoneypotWindow &&
    ageInHoneypotWindow &&
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

  const hasEnoughSources = input.sourcesAvailableCount >= 5;

  // Path 3: BLUE-CHIP CONCENTRATION EXEMPTION (allowlist-only) ─────────
  //
  // 7.7.1 (founder rule, 2026-05-28): "si un wallet du top 10 dépasse
  // 10% c'est danger automatiquement". The previous metric-based
  // heuristic (50k+ holders + LP burned + 30d+ → unlock) was retired
  // because it let too many borderline tokens reach SAFE/CAUTION when
  // a wallet was actually sitting at 15-25%. New policy: only tokens
  // on the hardcoded `isKnownDaoTreasury` allowlist (JTO, ORCA, and a
  // small curated list) can bypass concentration. Every other token
  // with concentration → DANGER, no exceptions.
  //
  // Maintained because real DAOs (JTO multi-sig at ~17%) still need
  // a verdict that isn't DANGER. The allowlist is a single hardcoded
  // set in source — auditable, no per-token override surface for
  // attackers.
  //
  // concentration_warning historically lived here to keep 10-14%
  // tokens out of this exemption. Since 7.7.1 the 10-14% band is
  // folded into hard concentration, so the warning isn't needed
  // — but we keep the check in case any legacy cache still carries
  // the old reason name. Harmless if it never fires.
  const hasConcentrationWarning =
    input.safeBlockedReasons.includes("concentration_warning");
  const onlyConcentrationHard =
    !hasConcentrationWarning &&
    input.safeBlockedReasons.length > 0 &&
    input.safeBlockedReasons.every(r =>
      r === "concentration" || SOFT_REASONS[r] === true,
    );
  const isKnownDao = isKnownDaoTreasury(input.mint);
  if (onlyConcentrationHard && isKnownDao) {
    return false;
  }

  // HARD reasons can NEVER be soft-unlocked regardless of age, holders, or source count.
  // 'lp': dev can pull liquidity at any time — fundamentally unacceptable for SAFE verdict.
  // 'deceptive_name': intentional fraud signal, not a maturity issue.
  const hasHardReason = input.safeBlockedReasons.some(r => HARD_BLOCK_REASONS.has(r));
  if (hasHardReason) return true; // Always keep safeBlocked for hard reasons

  // Only 'age' and 'holders' are soft reasons that can potentially unlock
  // SOFT_REASONS imported from constants.ts
  const onlySoftReasons = input.safeBlockedReasons.length > 0 &&
    input.safeBlockedReasons.every(r => SOFT_REASONS[r] === true);

  if (onlySoftReasons) {
    const ageHours = input.tokenAgeHours ?? 0;
    if (input.tokenAgeHours !== null && ageHours < 48) return true;
    // Path 1: Standard unlock — ALL conditions including LP burn
    if (
      (input.tokenAgeHours === null || ageHours > 48) &&
      hasEnoughSources &&
      (input.holders ?? 0) > 1000 &&
      input.lpBurned &&
      input.goPlusClean
    ) {
      return false;
    }
    // Path 2: Established token override — for blue chips where LP is not burned
    // but the token is clearly legitimate (massive holder base, very old, GoPlus clean).
    // Tokens like Fartcoin (600k+ holders, 30d+) were stuck in DANGER because
    // the safe gate required lpBurned to unlock even soft reasons like 'holders'.
    // This path uses MUCH stricter thresholds to compensate for unburned LP.
    const isEstablished =
      (input.tokenAgeHours !== null && ageHours >= 720) && // 30+ days
      hasEnoughSources &&
      (input.holders ?? 0) >= 50000 && // 50k+ holders (vs 1k standard)
      input.goPlusClean;
    if (isEstablished) {
      return false;
    }
  }

  // safeBlockedReasons is empty (unclassified) — keep blocked by default
  return true;
}

export function applyEstablishedBonus(input: EstablishedBonusInput): number {
  // Require 90 days, 5000 holders, GoPlus clean. LP burned is preferred but
  // not required for the bonus if the token is truly established (50k+ holders).
  const meetsBase =
    input.tokenAgeHours !== null &&
    input.tokenAgeHours > 2160 &&
    (input.holders ?? 0) > 5000 &&
    input.goPlusClean;
  if (meetsBase && (input.lpBurned || (input.holders ?? 0) >= 50000)) {
    return Math.min(1000, Math.round(input.score * 1.05));
  }
  return input.score;
}

export function determineVerdict(input: VerdictInput): Verdict {
  if (input.forceRug) return "RUG";
  if (!input.sourcesUsedCount || input.sourcesUsedCount <= 0) return "DANGER";
  // Flag-count hard floors: 1+ critical OR 3+ total token-side flags → minimum DANGER.
  // Prevents tokens with many accumulated risk signals from staying at CAUTION when
  // individual layer penalties are offset by clean scores from other layers.
  if ((input.criticalFlagsCount ?? 0) >= 1) return "DANGER";
  if ((input.warningFlagsCount ?? 0) >= 3) return "DANGER";

  if (input.safeBlocked) {
    // HARD reasons: 'lp' and 'deceptive_name' added alongside existing hard reasons.
    // A token where LP is not burned can rug at any time — must return DANGER or RUG.
    const hasHardReason = input.safeBlockedReasons?.some(r => HARD_BLOCK_REASONS.has(r));
    if (hasHardReason) return input.score >= 400 ? "DANGER" : "RUG";

    // "No flags → SAFE" override for soft safeBlocked reasons (e.g. Helius
    // unavailable, partial data). The same rule exists below for the non-
    // safeBlocked path but was unreachable here — the early CAUTION return
    // at line 177 killed it. TRUMP-class case: LP "<1%" + "≥1y" gives
    // safeBlock=false (matrix), so safeBlocked must come from infrastructure
    // (Helius down). No user-visible flags exist yet the verdict was CAUTION.
    // Rule: if ZERO visible warnings AND no hard structural risk AND good
    // score AND enough data sources → override and grant SAFE.
    if (
      (input.warningFlagsCount ?? 0) === 0 &&
      input.score >= 750 &&
      (input.sourcesUsedCount ?? 0) >= 4
    ) return "SAFE";

    // Soft reasons (age/holders) only: tightened from 550 to 700 for CAUTION
    if (input.score >= 700) return "CAUTION";
    return "DANGER";
  }

  // SAFE requires ZERO warning/critical flags.
  // If Antares flagged any problem — even a single warning — the verdict
  // cannot be SAFE. Showing "SAFE" alongside "1 flag detected" is
  // contradictory and destroys credibility: either we detected a problem
  // (→ CAUTION at minimum) or we didn't (→ SAFE). Never both.
  // Back-compat: warningFlagsCount undefined (old callers) → treated as 0 → SAFE allowed.
  if (input.score >= 900 && input.sourcesUsedCount >= 5 && (input.warningFlagsCount ?? 0) === 0) return "SAFE";

  // "Clean blue-chip" path: when there are LITERALLY ZERO token-side
  // warning/critical flags AND the score is still reasonable (>= 750),
  // grant SAFE at a relaxed bar. Fixes the contradiction where the
  // overlay shows "No issues found" but the verdict is CAUTION because
  // infrastructure-side score drag (Helius unavailable, Holder data
  // unreliable, etc.) prevented the score from reaching 900.
  //
  // Gated by sourcesUsedCount >= 4 so a token with thin upstream
  // coverage can't sneak in via "no warnings because no data".
  // The score floor (750) is intentionally above the CAUTION floor
  // (600) so a token that's borderline-clean but actually mediocre
  // still gets CAUTION.
  if (
    input.warningFlagsCount === 0 &&
    input.score >= 750 &&
    input.sourcesUsedCount >= 4
  ) {
    return "SAFE";
  }

  if (input.score >= 600) return "CAUTION";
  if (input.score >= 350) return "DANGER";
  return "RUG";
}
