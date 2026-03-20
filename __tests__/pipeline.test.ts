import { describe, it, expect } from "vitest";
import {
  evaluatePostLayerFlags,
  applySafeGateOverride,
  applyEstablishedBonus,
  determineVerdict,
} from "../api/_lib/pipeline";
import type {
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

  it("3. Soft reason 'age' + all conditions met -> returns false (unlocked)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: 600, lpBurned: true, goPlusClean: true,
    }))).toBe(false);
  });

  it("4. Soft reason 'holders' + all conditions met -> returns false (unlocked)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["holders"], holders: 600, lpBurned: true, goPlusClean: true,
    }))).toBe(false);
  });

  it("5. Both soft reasons ['age','holders'] + all conditions met -> returns false (unlocked)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age", "holders"], holders: 600, lpBurned: true, goPlusClean: true,
    }))).toBe(false);
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

  it("12. Soft reason but holders=501 -> returns false (just above threshold)", () => {
    expect(applySafeGateOverride(makeSafeGateInput({
      safeBlockedReasons: ["age"], holders: 501,
    }))).toBe(false);
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
});

// ─── applyEstablishedBonus ──────────────────────────────────────────────────

describe("applyEstablishedBonus", () => {
  it("1. All conditions met, score=920 -> capped at 1000", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ score: 920 }))).toBe(1000);
  });

  it("2. All conditions met, score=800 -> 920", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ score: 800 }))).toBe(920);
  });

  it("3. All conditions met, score=500 -> 575", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ score: 500 }))).toBe(575);
  });

  it("4. tokenAgeHours=100 -> score unchanged (needs >720)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: 100 }))).toBe(920);
  });

  it("5. tokenAgeHours=720 -> score unchanged (boundary: needs >720)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: 720 }))).toBe(920);
  });

  it("6. tokenAgeHours=721 + all conditions met -> bonus applied", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ tokenAgeHours: 721 }))).toBe(1000);
  });

  it("7. holders=500 -> score unchanged (needs >1000)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: 500 }))).toBe(920);
  });

  it("8. holders=1000 -> score unchanged (boundary: needs >1000)", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: 1000 }))).toBe(920);
  });

  it("9. holders=1001 + all conditions met -> bonus applied", () => {
    expect(applyEstablishedBonus(makeEstablishedBonusInput({ holders: 1001 }))).toBe(1000);
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

  it("4. safeBlocked=true, score=850 -> CAUTION (blocked + score>=600)", () => {
    expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 850 }))).toBe("CAUTION");
  });

  it("5. safeBlocked=true, score=600 -> CAUTION (blocked + score=600 exactly)", () => {
    expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 600 }))).toBe("CAUTION");
  });

  it("6. safeBlocked=true, score=599 -> DANGER (blocked + score<600)", () => {
    expect(determineVerdict(makeVerdictInput({ safeBlocked: true, score: 599 }))).toBe("DANGER");
  });

  it("7. score=850, normal conditions -> SAFE", () => {
    expect(determineVerdict(makeVerdictInput({ score: 850 }))).toBe("SAFE");
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
