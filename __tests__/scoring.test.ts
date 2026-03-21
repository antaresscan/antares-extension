import { describe, it, expect } from "vitest";
import { computeFinalScore, classifySafeBlockedReasons } from "../api/_lib/scoring";
import { LAYER_WEIGHTS } from "../api/_lib/constants";
import type { LayerResult } from "../api/_lib/types";

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

  it("returns 0 with one trust=0 (hard kill)", () => {
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
    // HARD KILL: any available layer with trust=0 returns 0 immediately
    expect(computeFinalScore(layers)).toBe(0);
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

  it("LAYER_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(LAYER_WEIGHTS).reduce((a: number, b: number) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("XV penalties reduce score for LP burn conflict", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("identity", 1, true),
      makeLayer("crossvalidation", 1, true, [
        { label: "LP burn conflict: RugCheck vs on-chain data", severity: "warning", impact: 0 }
      ]),
    ];
    const score = computeFinalScore(layers);
    expect(score).toBeLessThan(1000);
    expect(score).toBe(850); // 1000 * 0.85
  });

  it("identity trust < 1 reduces final score (via weighted geometric mean)", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("identity", 0.5, true),
      makeLayer("crossvalidation", 1, true),
    ];
    const score = computeFinalScore(layers);
    // identity is now in LAYER_WEIGHTS (0.08), so 0.5 trust reduces via geometric mean
    expect(score).toBeLessThan(1000);
    expect(score).toBeGreaterThan(900);
  });

  it("score caps at 1000", () => {
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
    expect(computeFinalScore(layers)).toBeLessThanOrEqual(1000);
  });

  it("chart weight at 0.10 gives chart more influence than before", () => {
    const base: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("identity", 1, true),
      makeLayer("crossvalidation", 1, true),
    ];
    const withGoodChart = [...base, makeLayer("chart", 1, true)];
    const withBadChart = [...base, makeLayer("chart", 0.2, true)];
    const goodScore = computeFinalScore(withGoodChart);
    const badScore = computeFinalScore(withBadChart);
    expect(goodScore - badScore).toBeGreaterThan(100);
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
