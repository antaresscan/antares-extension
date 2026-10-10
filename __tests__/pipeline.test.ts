import { describe, it, expect } from "vitest";
import {
  evaluatePostLayerFlags,
  applySafeGateOverride,
  applyEstablishedBonus,
  determineVerdict,
  dedupeFlags,
  countVerdictFlags,
} from "../api/_lib/pipeline";
import type {
  ScanFlag,
  PostLayerFlagsInput,
  SafeGateInput,
  EstablishedBonusInput,
  VerdictInput,
  SolscanTransfer,
} from "../api/_lib/types";

// ─── FACTORY HELPERS ──────────────────────────────────────────────────────────

function makeDiverseTransfers(count: number, uniqueWallets: number): SolscanTransfer[] {
  const wallets = Array.from({ length: uniqueWallets }, (_, i) =>
    `wallet${i}Abc123456789012345678901234567890`
  );
  return Array.from({ length: count }, (_, i) => ({
    from_address: wallets[i % uniqueWallets],
    to_address: wallets[(i + 1) % uniqueWallets],
    amount: 1000,
    block_time: Date.now(),
  }));
}

function makePostLayerFlagsInput(overrides: Partial<PostLayerFlagsInput> = {}): PostLayerFlagsInput {
  return {
    buys5m: 10,
    sells5m: 5,
    liqUsd: 50000,
    ageMin: 120,
    recentTransfers: makeDiverseTransfers(10, 8),
    creatorReputation: null,
    volLiqRatio: 2,
    ...overrides,
  };
}

function makeSafeGateInput(overrides: Partial<SafeGateInput> = {}): SafeGateInput {
  return {
    safeBlocked: true,
    safeBlockedReasons: ["age"],
    forceRug: false,
    holders: 600,
    lpBurned: true,
    goPlusClean: true,
    tokenAgeHours: null,
    sourcesAvailableCount: 5,
    ...overrides,
  };
}

function makeEstablishedBonusInput(overrides: Partial<EstablishedBonusInput> = {}): EstablishedBonusInput {
  return {
    score: 920,
    tokenAgeHours: 800,
    holders: 1500,
    lpBurned: true,
    goPlusClean: true,
    ...overrides,
  };
}

function makeVerdictInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    score: 900,
    forceRug: false,
    safeBlocked: false,
    sourcesUsedCount: 5,
    ...overrides,
  };
}

// ─── evaluatePostLayerFlags ─────────────────────────────────────────────────

describe("evaluatePostLayerFlags", () => {
  it("1. Normal data -> empty flags, forceRug=false, safeBlocked=false", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput());
    expect(result.flags).toEqual([]);
    expect(result.forceRug).toBe(false);
    expect(result.safeBlocked).toBe(false);
  });

  it("2. Social honeypot: sells5m=0, buys5m=15, liqUsd=10000, ageMin=60 -> forceRug=true", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 10000, ageMin: 60,
    }));
    expect(result.forceRug).toBe(true);
    expect(result.flags.some(f => /social honeypot/i.test(f.label))).toBe(true);
  });

  it("3. Social honeypot boundary: buys5m=10 -> NOT triggered (needs >10)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 10, liqUsd: 10000, ageMin: 60,
    }));
    expect(result.forceRug).toBe(false);
    expect(result.flags.some(f => /social honeypot/i.test(f.label))).toBe(false);
  });

  it("4. Social honeypot boundary: sells5m=1 -> NOT triggered (needs sells5m===0)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 1, buys5m: 15, liqUsd: 10000, ageMin: 60,
    }));
    expect(result.forceRug).toBe(false);
  });

  it("5. Social honeypot boundary: liqUsd=4999 -> NOT triggered (needs >5000)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 4999, ageMin: 60,
    }));
    expect(result.forceRug).toBe(false);
  });

  it("6. Social honeypot boundary: ageMin=29 -> NOT triggered (needs >30)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 10000, ageMin: 29,
    }));
    expect(result.forceRug).toBe(false);
  });

  it("6a. Social honeypot UPPER bound: ageMin=720 -> NOT triggered (needs <720)", () => {
    // Established tokens shouldn't trip the honeypot check just because
    // a 5-min slice happened to contain only buys. Real social honeypots
    // are fresh launches, not 12+ hour old tokens.
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 10000, ageMin: 720,
    }));
    expect(result.forceRug).toBe(false);
    expect(result.flags.some(f => /social honeypot/i.test(f.label))).toBe(false);
  });

  it("6b. Social honeypot UPPER bound: liqUsd=80000 -> NOT triggered (needs <80000)", () => {
    // Real social honeypots have small scammer-controlled liquidity,
    // not multi-million pools. Mid-cap and large-cap tokens should pass
    // the check even on buy-only 5-min slices.
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 80000, ageMin: 60,
    }));
    expect(result.forceRug).toBe(false);
    expect(result.flags.some(f => /social honeypot/i.test(f.label))).toBe(false);
  });

  it("6c. FARTCOIN-shaped regression: $7.5M liq, 18 months old -> NOT triggered", () => {
    // Real reproducer: FARTCOIN with ~$7.5M liquidity, ~600 days age,
    // happened to have a buy-only 5-minute window during scan. Used to
    // trigger 'social honeypot' and force RUG. After the upper bound
    // fix, doesn't trip.
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 7_500_000, ageMin: 600 * 24 * 60,
    }));
    expect(result.forceRug).toBe(false);
    expect(result.flags.some(f => /social honeypot/i.test(f.label))).toBe(false);
  });

  it("7. Wash trading: 10 transfers, 2 unique wallets -> forceRug=true", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      recentTransfers: makeDiverseTransfers(10, 2),
    }));
    expect(result.forceRug).toBe(true);
    expect(result.flags.some(f => /wash trading/i.test(f.label))).toBe(true);
  });

  it("8. Wash trading edge: 9 transfers, 2 wallets -> NOT triggered (needs >=10)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      recentTransfers: makeDiverseTransfers(9, 2),
    }));
    expect(result.flags.some(f => /wash trading/i.test(f.label))).toBe(false);
  });

  it("9. Wash trading edge: 10 transfers, 4 wallets -> NOT triggered (needs <=3)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      recentTransfers: makeDiverseTransfers(10, 4),
    }));
    expect(result.flags.some(f => /wash trading/i.test(f.label))).toBe(false);
  });

  it("10. Wash trading boundary: 10 transfers, 3 wallets -> triggered (exactly 3 = <=3)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      recentTransfers: makeDiverseTransfers(10, 3),
    }));
    expect(result.forceRug).toBe(true);
    expect(result.flags.some(f => /wash trading/i.test(f.label))).toBe(true);
  });

  it("11. Pump.fun guard: ageMin=30, volLiqRatio=20 -> safeBlocked=true", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      ageMin: 30, volLiqRatio: 20,
    }));
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /pump\.fun/i.test(f.label))).toBe(true);
  });

  it("12. Pump.fun edge: ageMin=60 -> NOT triggered (needs <60)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      ageMin: 60, volLiqRatio: 20,
    }));
    expect(result.flags.some(f => /pump\.fun/i.test(f.label))).toBe(false);
  });

  it("13. Pump.fun edge: volLiqRatio=15 -> NOT triggered (needs >15)", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      ageMin: 30, volLiqRatio: 15,
    }));
    expect(result.flags.some(f => /pump\.fun/i.test(f.label))).toBe(false);
  });

  it("14. Creator flagged: serial deployer -> safeBlocked=true, flag present", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      creatorReputation: { priorTokens: 5, flagged: true, reason: "Serial deployer" },
    }));
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /Serial deployer/i.test(f.label))).toBe(true);
  });

  it("15. Creator not flagged: null -> no flag added", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      creatorReputation: null,
    }));
    expect(result.flags.some(f => /deployer/i.test(f.label))).toBe(false);
  });

  it("16. Creator not flagged: flagged=false -> no flag added", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      creatorReputation: { priorTokens: 1, flagged: false, reason: null },
    }));
    expect(result.flags.some(f => /deployer/i.test(f.label))).toBe(false);
  });

  it("17. Multiple triggers: honeypot + wash trading -> both flags, forceRug=true", () => {
    const result = evaluatePostLayerFlags(makePostLayerFlagsInput({
      sells5m: 0, buys5m: 15, liqUsd: 10000, ageMin: 60,
      recentTransfers: makeDiverseTransfers(10, 2),
    }));
    expect(result.forceRug).toBe(true);
    expect(result.flags.some(f => /social honeypot/i.test(f.label))).toBe(true);
    expect(result.flags.some(f => /wash trading/i.test(f.label))).toBe(true);
  });
});

// ─── applySafeGateOverride ──────────────────────────────────────────────────

describe("applySafeGateOverride", () => {
  it("1. safeBlocked=false -> returns false (passthrough)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({ safeBlocked: false }))).toBe(false);
  });

  it("2. safeBlocked=true, forceRug=true -> returns true (forceRug bypasses)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({ forceRug: true }))).toBe(true);
  });

  it("3. Soft reason 'age' + all conditions met -> returns true (HARDENED: holders < 1000)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: 600, lpBurned: true, goPlusClean: true,
    }))).toBe(true);
  });

  it("4. 'holders' alone -> returns true (7.7.0: no longer soft-unlockable)", () => {
    // Pre-7.7.0 'holders' was soft and could unlock when holders ≥ 1000
    // + established conditions. After RIV (false-positive SAFE on a
    // token with 40% top-1 wallet), 'holders' is no longer SOFT —
    // without verified distribution we cannot be SAFE. Even with
    // generous holder count and LP burned the gate now stays closed.
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["holders"], holders: 5000, lpBurned: true, goPlusClean: true,
    }))).toBe(true);
  });

  it("5. Mixed ['age','holders'] -> returns true (any 'holders' keeps the gate closed)", () => {
    // 'age' alone would unlock if all conditions are met (Path 1), but
    // the presence of 'holders' poisons the all-soft check. This is
    // intentional after the 7.7.0 reclassification.
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age", "holders"], holders: 5000, lpBurned: true, goPlusClean: true,
    }))).toBe(true);
  });

  it("6. Hard reason 'mint' -> returns true (stays blocked)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["mint"],
    }))).toBe(true);
  });

  it("7. Hard reason 'freeze' -> returns true", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["freeze"],
    }))).toBe(true);
  });

  it("8. Hard reason 'honeypot' -> returns true", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["honeypot"],
    }))).toBe(true);
  });

  it("9. Mixed ['age','mint'] -> returns true (one hard reason blocks)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age", "mint"],
    }))).toBe(true);
  });

  it("10. Soft reason but holders=400 -> returns true (not enough holders)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: 400,
    }))).toBe(true);
  });

  it("11. Soft reason but holders=500 -> returns true (boundary: needs >500)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: 500,
    }))).toBe(true);
  });

    it("12. Soft reason but holders=501 -> returns true (HARDENED: needs > 1000)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: 501,
    }))).toBe(true);
  });

  it("13. Soft reason but lpBurned=false -> returns true", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], lpBurned: false,
    }))).toBe(true);
  });

  it("14. Soft reason but goPlusClean=false -> returns true", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], goPlusClean: false,
    }))).toBe(true);
  });

  it("15. Soft reason but holders=null -> returns true (null treated as 0)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: null,
    }))).toBe(true);
  });

  // Age-aware safe-gate tests
    it("HARDENED: keeps blocked for token < 48h with insufficient holders", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"],
      tokenAgeHours: 25,
      sourcesAvailableCount: 4,
      holders: 250,
      goPlusClean: true,
      lpBurned: false, // not burned, but relaxed unlock doesn't require it
    }))).toBe(true);
  });

  it("keeps blocked for token < 24h with only soft reasons", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"],
      tokenAgeHours: 12,
      sourcesAvailableCount: 4,
      holders: 250,
      goPlusClean: true,
      lpBurned: false,
    }))).toBe(true);
  });

  it("keeps blocked when sourcesAvailableCount < 4", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"],
      tokenAgeHours: 25,
      sourcesAvailableCount: 3,
      holders: 250,
      goPlusClean: true,
      lpBurned: false,
    }))).toBe(true);
  });

  it("always returns true when forceRug", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      forceRug: true,
      safeBlockedReasons: ["age"],
      tokenAgeHours: 25,
      sourcesAvailableCount: 5,
      holders: 1000,
      goPlusClean: true,
      lpBurned: true,
    }))).toBe(true);
  });
});

// ─── applyEstablishedBonus ──────────────────────────────────────────────────

describe("applyEstablishedBonus", () => {
    it("1. Default conditions (age<2160, holders<5000) -> no bonus, score unchanged", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ score: 920 }))).toBe(920);
  });

    it("2. Default conditions, score=800 -> no bonus, returns 800", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ score: 800 }))).toBe(800);
  });

  it("3. All conditions met, score=500 -> no bonus, returns 500", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ score: 500 }))).toBe(500);
  });

  it("4. tokenAgeHours=100 -> score unchanged (HARDENED: needs >2160)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: 100 }))).toBe(920);
  });

  it("5. tokenAgeHours=720 -> score unchanged (boundary: HARDENED: needs >2160)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: 720 }))).toBe(920);
  });

    it("6. tokenAgeHours=721 -> score unchanged (HARDENED: needs >2160)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: 721 }))).toBe(920);
  });

  it("7. holders=500 -> score unchanged (HARDENED: needs >5000)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: 500 }))).toBe(920);
  });

  it("8. holders=1000 -> score unchanged (boundary: HARDENED: needs >5000)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: 1000 }))).toBe(920);
  });

    it("9. holders=1001 -> score unchanged (HARDENED: needs >5000 AND age >2160)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: 1001 }))).toBe(920);
  });

  it("10. lpBurned=false -> score unchanged", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ lpBurned: false }))).toBe(920);
  });

  it("11. goPlusClean=false -> score unchanged", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ goPlusClean: false }))).toBe(920);
  });

  it("12. tokenAgeHours=null -> score unchanged", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: null }))).toBe(920);
  });

  it("13. holders=null -> score unchanged", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: null }))).toBe(920);
  });
});

// ─── determineVerdict ───────────────────────────────────────────────────────

describe("determineVerdict", () => {
  it("1. forceRug=true, score=999 -> RUG (forceRug always wins)", () => {
    expect(determineVerdict(makeVerdictInput({ forceRug: true, score: 999 }))).toBe("RUG");
  });

  it("2. forceRug=true, score=0 -> RUG (forceRug always wins)", () => {
    expect(determineVerdict(makeVerdictInput({ forceRug: true, score: 0 }))).toBe("RUG");
  });

  it("3. sourcesUsedCount=0, score=500 -> DANGER", () => {
    expect(determineVerdict(makeVerdictInput({ sourcesUsedCount: 0, score: 500 }))).toBe("DANGER");
  });

  it("4. safeBlocked=true, score=850, 0 flags -> SAFE (no-flags override inside safeBlocked)", () => {
    // No visible warnings + good score + enough sources → SAFE even when
    // safeBlocked is set by infrastructure (e.g. Helius unavailable).
    // The old expected value was CAUTION — that was the bug: "No issues found"
    // showing next to a CAUTION badge is a direct contradiction.
    expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 850 }))).toBe("SAFE");
  });

  it("4b. safeBlocked=true, score=850, warningFlagsCount=1 -> CAUTION (flag present, no-flags override blocked)", () => {
    // If there IS a visible flag the no-flags override must NOT fire.
    expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 850, warningFlagsCount: 1 }))).toBe("CAUTION");
  });

  // 7.7.21: unverified holders are the one soft-block case the no-flags
  // override must never lift. layerHelius sets the "holders" reason when it
  // has no holder data; without verified concentration SAFE is not honest.
  it("4c. safeBlocked + 'holders' reason, score=850, 0 visible flags -> CAUTION (never SAFE)", () => {
    expect(
      determineVerdict(makeVerdictInput({ safeBlocked: true, safeBlockedReasons: ["holders"], score: 850 })),
    ).toBe("CAUTION");
  });

  it("4d. 'holders' reason mixed with another soft reason still blocks SAFE", () => {
    expect(
      determineVerdict(
        makeVerdictInput({ safeBlocked: true, safeBlockedReasons: ["lp_unverified", "holders"], score: 880 }),
      ),
    ).toBe("CAUTION");
  });

  it("4e. 'holders' reason, score=699 -> DANGER (the CAUTION floor is unchanged)", () => {
    expect(
      determineVerdict(makeVerdictInput({ safeBlocked: true, safeBlockedReasons: ["holders"], score: 699 })),
    ).toBe("DANGER");
  });

  it("4f. other soft reasons keep the existing no-flags override (change is scoped to holders)", () => {
    expect(
      determineVerdict(makeVerdictInput({ safeBlocked: true, safeBlockedReasons: ["lp_unverified"], score: 850 })),
    ).toBe("SAFE");
  });

    it("5. safeBlocked=true, score=600 -> DANGER (HARDENED: blocked needs score>=700 for CAUTION)", () => {
        expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 600 }))).toBe("DANGER");
  });

    it("6. safeBlocked=true, score=599 -> DANGER (HARDENED: soft-blocked needs score>=700)", () => {
        expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 599 }))).toBe("DANGER");
  });

    it("7. score=850 -> CAUTION (HARDENED: SAFE needs >=900)", () => {
    expect(determineVerdict(makeVerdictInput({ score: 850 }))).toBe("CAUTION");
  });

  it("8. score=849 -> CAUTION (just below SAFE)", () => {
    expect(determineVerdict(makeVerdictInput({ score: 849 }))).toBe("CAUTION");
  });

  it("9. score=600 -> CAUTION", () => {
    expect(determineVerdict(makeVerdictInput({ score: 600 }))).toBe("CAUTION");
  });

  it("10. score=599 -> DANGER (just below CAUTION)", () => {
    expect(determineVerdict(makeVerdictInput({ score: 599 }))).toBe("DANGER");
  });

  it("11. score=350 -> DANGER", () => {
    expect(determineVerdict(makeVerdictInput({ score: 350 }))).toBe("DANGER");
  });

  it("12. score=349 -> RUG (<350)", () => {
    expect(determineVerdict(makeVerdictInput({ score: 349 }))).toBe("RUG");
  });

  it("13. score=0, sourcesUsedCount=3 -> RUG", () => {
    expect(determineVerdict(makeVerdictInput({ score: 0, sourcesUsedCount: 3 }))).toBe("RUG");
  });

  it("14. score=1000, all clean -> SAFE", () => {
    expect(determineVerdict(makeVerdictInput({ score: 1000 }))).toBe("SAFE");
  });
});

// ─── determineVerdict safeBlocked granularity ─────────────────────────────


describe("determineVerdict safeBlocked granularity", () => {
  it("should return DANGER for hard-blocked token with score 400", () => {
    expect(determineVerdict({
      score: 400, forceRug: false, safeBlocked: true,
      safeBlockedReasons: ["honeypot"], sourcesUsedCount: 5
    })).toBe("DANGER");
  });

  it("should return RUG for hard-blocked token with score 300", () => {
    expect(determineVerdict({
      score: 300, forceRug: false, safeBlocked: true,
      safeBlockedReasons: ["mint"], sourcesUsedCount: 5
    })).toBe("RUG");
  });

    it("should return DANGER for soft-blocked token with score 600 (HARDENED: needs >=700)", () => {
    expect(determineVerdict({
      score: 600, forceRug: false, safeBlocked: true,
      safeBlockedReasons: ["age"], sourcesUsedCount: 5
        })).toBe("DANGER");
  });

  it("should return DANGER for soft-blocked token with score 400", () => {
    expect(determineVerdict({
      score: 400, forceRug: false, safeBlocked: true,
      safeBlockedReasons: ["age"], sourcesUsedCount: 5
    })).toBe("DANGER");
  });
});


describe("low_holders as HARD reason", () => {
  it("applySafeGateOverride keeps safeBlocked when low_holders is present", () => {
    const result = applySafeGateOverride({
      safeBlocked: true,
      forceRug: false,
      safeBlockedReasons: ["low_holders"],
      tokenAgeHours: 500,
      sourcesAvailableCount: 7,
      holders: 30,
      lpBurned: true,
      goPlusClean: true,
    });
    expect(result).toBe(true);
  });

  it("determineVerdict returns DANGER for low_holders with score 500", () => {
    expect(determineVerdict({
      score: 500, forceRug: false, safeBlocked: true,
      safeBlockedReasons: ["low_holders"], sourcesUsedCount: 5
    })).toBe("DANGER");
  });

  it("determineVerdict returns RUG for low_holders with score 300", () => {
    expect(determineVerdict({
      score: 300, forceRug: false, safeBlocked: true,
      safeBlockedReasons: ["low_holders"], sourcesUsedCount: 5
    })).toBe("RUG");
  });
});

describe("pump_imbalance as SOFT reason — safe gate unlock", () => {
  it("BONK-class: pump_imbalance + LP burned + 1000+ holders → gate opens (returns false)", () => {
    // Established token with temporary buy/sell imbalance window should NOT be
    // locked out of SAFE. LP burned + large holder base is sufficient to unlock.
    const result = applySafeGateOverride({
      safeBlocked: true,
      forceRug: false,
      safeBlockedReasons: ["pump_imbalance"],
      tokenAgeHours: 500,
      sourcesAvailableCount: 5,
      holders: 5000,
      lpBurned: true,
      goPlusClean: true,
      mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    });
    expect(result).toBe(false);
  });

  it("scam-class: pump_imbalance + LP NOT burned → gate stays closed (returns true)", () => {
    // A scam token where LP is not burned should remain blocked even if
    // the only classified reason is pump_imbalance. Path 1 requires lpBurned.
    const result = applySafeGateOverride({
      safeBlocked: true,
      forceRug: false,
      safeBlockedReasons: ["pump_imbalance"],
      tokenAgeHours: 200,
      sourcesAvailableCount: 5,
      holders: 5000,
      lpBurned: false,
      goPlusClean: true,
      mint: "SomeFakeScamTokenCAhere11111111111111111",
    });
    expect(result).toBe(true);
  });

  it("pump_imbalance + LP hard reason → gate stays closed (hard reason wins)", () => {
    // When both pump_imbalance and a hard LP reason are present, the hard
    // reason dominates — the token is still blocked.
    const result = applySafeGateOverride({
      safeBlocked: true,
      forceRug: false,
      safeBlockedReasons: ["pump_imbalance", "lp"],
      tokenAgeHours: 500,
      sourcesAvailableCount: 5,
      holders: 5000,
      lpBurned: false,
      goPlusClean: true,
      mint: "SomeFakeScamTokenCAhere11111111111111111",
    });
    expect(result).toBe(true);
  });
});
// ─── determineVerdict: a visible price-only pump flag keeps a token out of SAFE (M6) ────────────────────────────────
//
// Pump-only flags are left out of warningFlagsCount (so a pump alone never reaches the 3-warnings -> DANGER floor). That also
// hid them from the "zero visible warnings -> SAFE" grants: a token with a +1784 % flag, clean otherwise, came out SAFE.
describe("determineVerdict — price-only pump flags", () => {
  it("safeBlocked with a pump flag and nothing else: CAUTION, not the 'no visible issue' SAFE", () => {
    const clean = { safeBlocked: true, safeBlockedReasons: [] as string[], score: 920, sourcesUsedCount: 6, warningFlagsCount: 0, criticalFlagsCount: 0 };
    expect(determineVerdict(makeVerdictInput({ ...clean, pumpPriceOnlyFlagsCount: 1 }))).toBe("CAUTION");
    // witness: the same input without the pump flag is the 'no visible issue' SAFE it always was
    expect(determineVerdict(makeVerdictInput(clean))).toBe("SAFE");
    expect(determineVerdict(makeVerdictInput({ ...clean, pumpPriceOnlyFlagsCount: 0 }))).toBe("SAFE");
  });

  it("not safeBlocked but a pump flag: no SAFE either, at the 900 and the 750 grants", () => {
    const base = { safeBlocked: false, sourcesUsedCount: 6, warningFlagsCount: 0, criticalFlagsCount: 0, pumpPriceOnlyFlagsCount: 2 };
    expect(determineVerdict(makeVerdictInput({ ...base, score: 950 }))).toBe("CAUTION");
    expect(determineVerdict(makeVerdictInput({ ...base, score: 780 }))).toBe("CAUTION");
    expect(determineVerdict(makeVerdictInput({ ...base, score: 780, pumpPriceOnlyFlagsCount: 0 }))).toBe("SAFE");
  });

  it("pump flags never count toward the 3-warnings DANGER floor, however many there are", () => {
    expect(determineVerdict(makeVerdictInput({ score: 800, safeBlocked: true, safeBlockedReasons: [], warningFlagsCount: 2, pumpPriceOnlyFlagsCount: 5 }))).toBe("CAUTION");
  });

  it("a pump flag does not soften anything: a critical flag, forceRug and a low score still win", () => {
    expect(determineVerdict(makeVerdictInput({ score: 950, pumpPriceOnlyFlagsCount: 1, criticalFlagsCount: 1 }))).toBe("DANGER");
    expect(determineVerdict(makeVerdictInput({ score: 950, pumpPriceOnlyFlagsCount: 1, forceRug: true }))).toBe("RUG");
    expect(determineVerdict(makeVerdictInput({ score: 300, pumpPriceOnlyFlagsCount: 1, safeBlocked: true, safeBlockedReasons: [] }))).toBe("DANGER");
  });
});

// ─── Flags: the verdict is decided on the deduplicated list (audit M4) ──────────────────────────────────────────────
const flag = (label: string, severity: ScanFlag["severity"]): ScanFlag => ({ label, severity, impact: 0 });

describe("dedupeFlags", () => {
  it("keeps one flag per label, the most severe occurrence", () => {
    const out = dedupeFlags([flag("Mutable metadata", "info"), flag("Mutable metadata", "warning"), flag("Mutable metadata", "info")]);
    expect(out).toEqual([flag("Mutable metadata", "warning")]);
  });

  it("merges the same pump seen by two layers (same rounded percentage), keeping the most severe", () => {
    const out = dedupeFlags([
      flag("Large 24h pump +553% on token <24h", "warning"),
      flag("Pumped +553% in 24h — exit liquidity risk on thin LP", "critical"),
      flag("Top 10 hold 40% — elevated", "warning"),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((f) => /553/.test(f.label))?.severity).toBe("critical");
  });

  it("does not merge pumps of different sizes, nor flags without a percentage", () => {
    expect(dedupeFlags([flag("Pumped +120% in 24h", "warning"), flag("Pumped +340% over 7 days", "warning")])).toHaveLength(2);
    expect(dedupeFlags([flag("Coordinated pump pattern", "warning"), flag("Buy/sell imbalance (coordinated pump)", "warning")])).toHaveLength(2);
  });
});

describe("countVerdictFlags", () => {
  it("counts warnings and criticals only: info and bonus flags are not issues", () => {
    expect(countVerdictFlags([flag("a", "warning"), flag("b", "critical"), flag("c", "info"), flag("d", "bonus")])).toEqual({ warning: 2, critical: 1, pumpPriceOnly: 0 });
  });

  it("pipeline-status flags describe a source, not the token: never counted", () => {
    expect(countVerdictFlags([flag("Helius unavailable — holder concentration unverified", "warning"), flag("GoPlus rate-limited", "warning")]).warning).toBe(0);
  });

  it("price-only pump flags are counted apart: never toward the DANGER floor, but visible", () => {
    const c = countVerdictFlags([flag("Pumped +340% over 7 days — high retrace risk at current prices", "warning"), flag("Extreme 24h pump +1784% — high retrace risk", "warning")]);
    expect(c).toEqual({ warning: 0, critical: 0, pumpPriceOnly: 2 });
  });
});

describe("the verdict counts what the user sees (M4)", () => {
  // Two real warnings, one of them emitted by two layers. Raw: 3 warnings -> the DANGER floor. Deduplicated: 2 -> CAUTION.
  const raw = [flag("Top 10 hold 40% — elevated", "warning"), flag("Mint authority conflict: on-chain vs GoPlus", "warning"), flag("Top 10 hold 40% — elevated", "warning")];
  const verdictOf = (flags: ScanFlag[]) => {
    const c = countVerdictFlags(flags);
    return determineVerdict(makeVerdictInput({ score: 800, safeBlocked: false, sourcesUsedCount: 5, warningFlagsCount: c.warning, criticalFlagsCount: c.critical, pumpPriceOnlyFlagsCount: c.pumpPriceOnly }));
  };

  it("the raw list would have been DANGER, the deduplicated one is CAUTION", () => {
    expect(verdictOf(raw)).toBe("DANGER");            // what the verdict used to be decided on
    expect(verdictOf(dedupeFlags(raw))).toBe("CAUTION"); // what it is decided on now
  });

  it("witness: three DISTINCT warnings are still the DANGER floor", () => {
    const three = [flag("w1", "warning"), flag("w2", "warning"), flag("w3", "warning")];
    expect(verdictOf(dedupeFlags(three))).toBe("DANGER");
  });
});
