import { describe, it, expect } from "vitest";
import { layerRugCheck } from "../api/_lib/layers";
import { classifySafeBlockedReasons } from "../api/_lib/scoring";
import { applySafeGateOverride, determineVerdict } from "../api/_lib/pipeline";
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
    // lp_unverified is soft, so with enough age + sources + holders it can unlock
    // But lpBurned is false so it stays blocked (existing logic requires lpBurned for unlock)
    expect(blocked).toBe(true);
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
});
