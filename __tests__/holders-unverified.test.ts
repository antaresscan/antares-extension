// __tests__/holders-unverified.test.ts
//
// End-to-end check of the chain that decides what happens when holder data
// is missing: layerHelius -> classifySafeBlockedReasons -> applySafeGateOverride
// -> determineVerdict, using the real functions rather than hand-built inputs.
//
// Why a chain test: the rule "without verified concentration, never SAFE" was
// implemented (layerHelius sets safeBlocked, 7.7.0 keeps "holders" out of the
// soft reasons) and then silently bypassed by a later override in
// determineVerdict. Each piece passed its own unit tests; only the chain was
// wrong. HAWK, a rug, scanned SAFE 893 in production because of it.
import { describe, it, expect } from "vitest";
import { layerHelius } from "../api/_lib/layers";
import { classifySafeBlockedReasons } from "../api/_lib/scoring";
import { applySafeGateOverride, determineVerdict } from "../api/_lib/pipeline";
import type { HeliusHolder } from "../api/_lib/types";

const MINT = "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump";

/** Run the post-layer chain the way api/scan.ts does for a given Helius layer. */
function verdictFor(
  helius: ReturnType<typeof layerHelius>,
  score: number,
  opts: { holders?: number; ageHours?: number } = {},
) {
  const reasons = classifySafeBlockedReasons([helius]);
  const stillBlocked = applySafeGateOverride({
    safeBlocked: helius.safeBlocked,
    safeBlockedReasons: reasons,
    forceRug: false,
    holders: opts.holders ?? 600_000,
    lpBurned: true,
    goPlusClean: true,
    tokenAgeHours: opts.ageHours ?? 24 * 400,
    sourcesAvailableCount: 6,
    mint: MINT,
  });
  return {
    reasons,
    stillBlocked,
    verdict: determineVerdict({
      score,
      forceRug: false,
      safeBlocked: stillBlocked,
      safeBlockedReasons: reasons,
      sourcesUsedCount: 6,
      // The "Helius unavailable" flag is excluded from these counts by scan.ts
      // (_PIPELINE_STATUS), so a token with no other issue has zero.
      warningFlagsCount: 0,
      criticalFlagsCount: 0,
    }),
  };
}

describe("holders unverified (Helius has no holder data)", () => {
  it("the Helius layer closes the gate and records the 'holders' reason", () => {
    const helius = layerHelius([], 0);
    expect(helius.available).toBe(false);
    expect(helius.safeBlocked).toBe(true);
    expect(classifySafeBlockedReasons([helius])).toContain("holders");
  });

  it("an otherwise clean, established token is CAUTION, never SAFE (the HAWK scan)", () => {
    const { reasons, stillBlocked, verdict } = verdictFor(layerHelius([], 0), 893);
    expect(reasons).toContain("holders");
    expect(stillBlocked).toBe(true);
    expect(verdict).toBe("CAUTION");
  });

  it("stays CAUTION however mature the token looks (50k+ holders, 400 days, LP burned)", () => {
    const { verdict } = verdictFor(layerHelius([], 0), 950, { holders: 900_000, ageHours: 24 * 800 });
    expect(verdict).toBe("CAUTION");
  });

  it("a low score is still DANGER (the CAUTION floor is untouched)", () => {
    const { verdict } = verdictFor(layerHelius([], 0), 650);
    expect(verdict).toBe("DANGER");
  });

  it("positive control: with verified, well-distributed holders the same token can reach SAFE", () => {
    const holders: HeliusHolder[] = Array.from({ length: 20 }, (_, i) => ({
      address: `wallet${i}abc`,
      owner: `wallet${i}abc`,
      uiAmount: 50,
    }));
    const helius = layerHelius(holders, 10_000);
    expect(helius.available).toBe(true);
    expect(helius.safeBlocked).toBe(false);

    const { reasons, verdict } = verdictFor(helius, 920);
    expect(reasons).not.toContain("holders");
    expect(verdict).toBe("SAFE");
  });
});
