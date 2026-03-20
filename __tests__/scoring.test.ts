import { describe, it, expect } from "vitest";
import { computeFinalScore, classifySafeBlockedReasons } from "../api/scoring";
import type { LayerResult } from "../api/types";

function makeLayer(source: string, trust: number, available: boolean, flags: LayerResult["flags"] = [], forceRug = false, safeBlocked = false): LayerResult {
  return { source, trust, available, flags, forceRug, safeBlocked };
}

describe("computeFinalScore", () => {
  it("returns high score with all trust=1", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("identity", 1, true),
      makeLayer("crossvalidation", 1, true),
    ];
    expect(computeFinalScore(layers)).toBeGreaterThan(900);
  });

  it("returns very low score with one trust=0", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 0, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("identity", 1, true),
      makeLayer("crossvalidation", 1, true),
    ];
    // trust=0 gets clamped to 0.001 in scoring, so score is very low but not exactly 0
    expect(computeFinalScore(layers)).toBeLessThan(300);
  });

  it("returns 0 with none available", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, false),
      makeLayer("rugcheck", 1, false),
      makeLayer("goplus", 1, false),
      makeLayer("helius", 1, false),
      makeLayer("solscan", 1, false),
      makeLayer("chart", 1, false),
    ];
    expect(computeFinalScore(layers)).toBe(0);
  });
});

describe("classifySafeBlockedReasons", () => {
  it("detects bundle flag", () => {
    const layers: LayerResult[] = [
      makeLayer("rugcheck", 0.2, true, [
        { label: "Bundle activity detected (RugCheck)", severity: "critical", impact: 0 }
      ], false, true),
    ];
    expect(classifySafeBlockedReasons(layers)).toContain("bundle");
  });

  it("returns empty for no safeBlocked", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true, [], false, false),
    ];
    expect(classifySafeBlockedReasons(layers)).toEqual([]);
  });
});
