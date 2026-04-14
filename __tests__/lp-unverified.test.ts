import { describe, it, expect } from "vitest";
import { layerRugCheck } from "../api/_lib/layers";
import { classifySafeBlockedReasons } from "../api/_lib/scoring";
import { applySafeGateOverride, determineVerdict, applyEstablishedBonus } from "../api/_lib/pipeline";
import { HARD_BLOCK_REASONS } from "../api/_lib/constants";

describe("LP Unverified Logic (Fartcoin-like blue chip)", () => {
  const matureContext = {
    holders: 100000,
    liquidity: 5000000,
    tokenAgeHours: 2000,
    mintAuthority: false,
    freezeAuthority: false,
    honeypot: false,
  };

  const immatureContext = {
    holders: 500,
    liquidity: 10000,
    tokenAgeHours: 12,
    mintAuthority: false,
    freezeAuthority: false,
    honeypot: false,
  };

  const rugData = {
    lpBurned: false,
    lpLocked: false,
    metaMutable: false,
    mintAuthorityEnabled: false,
    freezeAuthorityEnabled: false,
    topHolders: { top10Percentage: 25, top1Percentage: 5 },
  };

  it("lp_unverified is NOT in HARD_BLOCK_REASONS", () => {
    expect(HARD_BLOCK_REASONS.has("lp_unverified")).toBe(false);
    expect(HARD_BLOCK_REASONS.has("lp")).toBe(true);
  });

  it("mature token with unburned LP gets lp_unverified flag instead of hard lp", () => {
    const result = layerRugCheck(rugData, null, "FakeMint123", "Fartcoin", matureContext);
    expect(result.safeBlocked).toBe(true);
    const hasUnverified = result.flags.some(f => /unverified LP/i.test(f.label));
    const hasHardLp = result.flags.some(f => /LP not burned or locked/i.test(f.label));
    expect(hasUnverified).toBe(true);
    expect(hasHardLp).toBe(false);
  });

  it("immature token with unburned LP gets hard lp flag", () => {
    const result = layerRugCheck(rugData, null, "FakeMint456", "ScamToken", immatureContext);
    expect(result.safeBlocked).toBe(true);
    const hasHardLp = result.flags.some(f => /LP not burned or locked/i.test(f.label));
    expect(hasHardLp).toBe(true);
  });

  it("lp_unverified classified as soft reason by scoring", () => {
    const result = layerRugCheck(rugData, null, "FakeMint123", "Fartcoin", matureContext);
    const reasons = classifySafeBlockedReasons([result]);
    expect(reasons).toContain("lp_unverified");
    expect(reasons).not.toContain("lp");
  });

  it("applySafeGateOverride can unlock lp_unverified with good signals", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      forceRug: false,
      holders: 100000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 2000,
      sourcesAvailableCount: 6,
    });
    // lp_unverified is soft, and the token is established (100k holders, 2000h age,
    // GoPlus clean, 6 sources) — Path 2 (established token override) unlocks it
    // even without LP burn. This is the correct behavior for blue chips like Fartcoin.
    expect(blocked).toBe(false);
  });

  it("determineVerdict gives CAUTION not DANGER for lp_unverified with high score", () => {
    const verdict = determineVerdict({
      score: 750,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      sourcesUsedCount: 6,
    });
    expect(verdict).toBe("CAUTION");
  });

  it("determineVerdict gives DANGER for hard lp with same score", () => {
    const verdict = determineVerdict({
      score: 750,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: ["lp"],
      sourcesUsedCount: 6,
    });
    expect(verdict).toBe("DANGER");
  });

  it("token with mint authority active does NOT get lp_unverified", () => {
    const ctxWithMint = { ...matureContext, mintAuthority: true };
    const result = layerRugCheck(rugData, null, "FakeMint789", "MintToken", ctxWithMint);
    const hasHardLp = result.flags.some(f => /LP not burned or locked/i.test(f.label));
    expect(hasHardLp).toBe(true);
  });


  // ═══ BLUE CHIP / ESTABLISHED TOKEN TESTS ═══════════════════════════════════
  // These tests verify that well-known established tokens get correct verdicts
  // after the safe gate established token override (Path 2).

  it("Fartcoin-like blue chip: 600k holders, 30d+, no LP burn → unlocks soft reasons", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"],
      forceRug: false,
      holders: 607841,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 1200, // ~50 days
      sourcesAvailableCount: 6,
    });
    // Fartcoin: 600k+ holders, 50 days old, GoPlus clean, 6 sources
    // Path 2 established override should unlock
    expect(blocked).toBe(false);
  });

  it("BONK-like blue chip: massive holder base, old, no LP burn → unlocks", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"],
      forceRug: false,
      holders: 800000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 5000, // ~208 days
      sourcesAvailableCount: 6,
    });
    expect(blocked).toBe(false);
  });

  it("WIF-like blue chip: 200k holders, 60d+, GoPlus clean → unlocks", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["age", "holders"],
      forceRug: false,
      holders: 200000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 1500,
      sourcesAvailableCount: 5,
    });
    expect(blocked).toBe(false);
  });

  it("established token with hard reason still blocked despite high holders", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp", "holders"], // lp is HARD
      forceRug: false,
      holders: 600000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 2000,
      sourcesAvailableCount: 6,
    });
    // Hard reason "lp" means ALWAYS blocked, even for blue chips
    expect(blocked).toBe(true);
  });

  it("established token with forceRug still blocked", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"],
      forceRug: true, // forceRug overrides everything
      holders: 600000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 2000,
      sourcesAvailableCount: 6,
    });
    expect(blocked).toBe(true);
  });

  it("token with 40k holders (below 50k threshold) stays blocked without LP burn", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      forceRug: false,
      holders: 40000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 2000,
      sourcesAvailableCount: 6,
    });
    // 40k < 50k threshold → Path 2 does NOT apply
    expect(blocked).toBe(true);
  });

  it("token with 100k holders but only 500h age stays blocked", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      forceRug: false,
      holders: 100000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 500, // < 720h threshold
      sourcesAvailableCount: 6,
    });
    // Age < 720h → Path 2 does NOT apply
    expect(blocked).toBe(true);
  });

  it("token with 100k holders but GoPlus NOT clean stays blocked", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      forceRug: false,
      holders: 100000,
      lpBurned: false,
      goPlusClean: false, // GoPlus flagged issues
      tokenAgeHours: 2000,
      sourcesAvailableCount: 6,
    });
    // GoPlus not clean → Path 2 does NOT apply
    expect(blocked).toBe(true);
  });

  it("token with 100k holders but only 4 sources stays blocked", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      forceRug: false,
      holders: 100000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 2000,
      sourcesAvailableCount: 4, // < 5 threshold
    });
    // Not enough sources → Path 2 does NOT apply
    expect(blocked).toBe(true);
  });

  it("established bonus applies to blue chip without LP burn", () => {
    const score = applyEstablishedBonus({
      score: 800,
      tokenAgeHours: 2500,
      holders: 600000,
      lpBurned: false,
      goPlusClean: true,
    });
    // 600k holders >= 50k → bonus applies even without LP burn
    expect(score).toBe(Math.min(1000, Math.round(800 * 1.05)));
  });

  it("established bonus does NOT apply to token with <50k holders and no LP burn", () => {
    const score = applyEstablishedBonus({
      score: 800,
      tokenAgeHours: 2500,
      holders: 30000,
      lpBurned: false,
      goPlusClean: true,
    });
    // 30k < 50k and no LP burn → no bonus
    expect(score).toBe(800);
  });
});
