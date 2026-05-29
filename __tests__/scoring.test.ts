import { describe, it, expect } from "vitest";
import { computeFinalScore, classifySafeBlockedReasons } from "../api/_lib/scoring";
import { LAYER_WEIGHTS, TRUST_FLOOR, XV_PENALTY_LP_BURN, XV_PENALTY_MINT_AUTH, XV_PENALTY_HOLDER_CONCENTRATION, HARD_BLOCK_REASONS, SOFT_REASONS } from "../api/_lib/constants";
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
      makeLayer("crossvalidation", 1, true),
    ];
    expect(computeFinalScore(layers)).toBeGreaterThan(900);
  });

  it("hard kill: returns 0 when any available layer has trust === 0", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 0, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("crossvalidation", 1, true),
    ];
    expect(computeFinalScore(layers)).toBe(0);
  });

  it("no hard kill for unavailable layer with trust 0", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 0, false),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("crossvalidation", 1, true),
    ];
    const score = computeFinalScore(layers);
    expect(score).toBeGreaterThan(0);
    expect(score).toBe(1000);
  });

  it("LAYER_WEIGHTS does NOT contain identity (removed)", () => {
    expect(LAYER_WEIGHTS).not.toHaveProperty("identity");
  });

  it("LAYER_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(LAYER_WEIGHTS).reduce((a: number, b: number) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("crossvalidation not in weighted mean (post-multiplier only)", () => {
    expect(LAYER_WEIGHTS).not.toHaveProperty("crossvalidation");
  });

  it("XV_PENALTY_HOLDER_CONCENTRATION applied", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("crossvalidation", 1, true, [
        { label: "holder concentration conflict", severity: "warning", impact: 0 }
      ]),
    ];
    const score = computeFinalScore(layers);
    expect(score).toBe(Math.round(1000 * XV_PENALTY_HOLDER_CONCENTRATION));
  });

  it("returns 0 when no sources available", () => {
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

  it("TRUST_FLOOR is 0.001 (not 0.10)", () => {
    expect(TRUST_FLOOR).toBe(0.001);
  });

  it("XV penalties reduce score for LP burn conflict", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("crossvalidation", 1, true, [
        { label: "LP burn conflict: RugCheck vs on-chain data", severity: "warning", impact: 0 }
      ]),
    ];
    const score = computeFinalScore(layers);
    expect(score).toBeLessThan(1000);
    expect(score).toBe(Math.round(1000 * XV_PENALTY_LP_BURN));
  });

  it("XV penalties reduce score for mint authority conflict", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("crossvalidation", 1, true, [
        { label: "Mint authority conflict: GoPlus vs RugCheck", severity: "warning", impact: 0 }
      ]),
    ];
    const score = computeFinalScore(layers);
    expect(score).toBe(Math.round(1000 * XV_PENALTY_MINT_AUTH));
  });

  it("score caps at 1000", () => {
    const layers: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
      makeLayer("chart", 1, true),
      makeLayer("crossvalidation", 1, true),
    ];
    expect(computeFinalScore(layers)).toBeLessThanOrEqual(1000);
  });

  it("chart weight at 0.10 gives chart influence on final score", () => {
    const base: LayerResult[] = [
      makeLayer("dexscreener", 1, true),
      makeLayer("rugcheck", 1, true),
      makeLayer("goplus", 1, true),
      makeLayer("helius", 1, true),
      makeLayer("solscan", 1, true),
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

  it("detects honeypot reason", () => {
    const layers: LayerResult[] = [
      makeLayer("goplus", 0, true, [
        { label: "Honeypot detected — cannot sell", severity: "critical", impact: 0 }
      ], true, true),
    ];
    expect(classifySafeBlockedReasons(layers)).toContain("honeypot");
  });

  it("detects age reason from solscan", () => {
    const layers: LayerResult[] = [
      makeLayer("solscan", 0.5, true, [
        { label: "Newborn token on-chain (<30min)", severity: "critical", impact: 0 }
      ], false, true),
    ];
    expect(classifySafeBlockedReasons(layers)).toContain("age");
  });

  it("detects concentration (hard) reason from top-10 high/extreme flag (7.7.4+)", () => {
    // top-10 ≥ 75%: "high" or "extreme" concentration → hard "concentration" reason.
    // The safe-gate stays closed — 75%+ top-10 means coordinated sell risk
    // regardless of how established the token looks.
    const layers: LayerResult[] = [
      makeLayer("helius", 0.25, true, [
        { label: "Top 10 hold 82% — extreme concentration", severity: "critical", impact: 0 }
      ], false, true),
    ];
    expect(classifySafeBlockedReasons(layers)).toContain("concentration");
  });

  it("classifies top-10 elevated (60-74%) flags as SOFT concentration_light (7.7.4)", () => {
    // top-10 60-74%: "elevated concentration" → soft "concentration_light".
    // Max CAUTION — verdict can land CAUTION with clean other layers, never SAFE.
    const layers: LayerResult[] = [
      makeLayer("helius", 0.5, true, [
        { label: "Top 10 hold 65% — elevated concentration", severity: "warning", impact: 0 }
      ], false, true),
    ];
    const reasons = classifySafeBlockedReasons(layers);
    expect(reasons).toContain("concentration_light");
    expect(reasons).not.toContain("concentration"); // hard only for 75%+
    expect(reasons).not.toContain("concentration_warning");
  });
});

function makeMockLayer(source: string, trust: number, available = true): LayerResult {
  return { source, trust, available, flags: [], forceRug: false, safeBlocked: false };
}

describe("computeFinalScore normalization", () => {
  it("should give equal scores regardless of source count when trusts are equal", () => {
    const allSources = [
      makeMockLayer("dexscreener", 0.8),
      makeMockLayer("rugcheck", 0.8),
      makeMockLayer("goplus", 0.8),
      makeMockLayer("helius", 0.8),
      makeMockLayer("solscan", 0.8),
      makeMockLayer("chart", 0.8),
      makeMockLayer("crossvalidation", 1.0),
    ];
    const scoreAll = computeFinalScore(allSources);

    const fewerSources = [
      makeMockLayer("dexscreener", 0.8),
      makeMockLayer("rugcheck", 0.8),
      makeMockLayer("goplus", 0.8),
      makeMockLayer("helius", 0.8, false),
      makeMockLayer("solscan", 0.8, false),
      makeMockLayer("chart", 0.8, false),
      makeMockLayer("crossvalidation", 1.0),
    ];
    const scoreFewer = computeFinalScore(fewerSources);

    expect(scoreAll).toBe(scoreFewer);
    expect(scoreAll).toBe(800);
  });

  it("should return 0 if any available layer has trust 0 (hard kill)", () => {
    const layers = [
      makeMockLayer("dexscreener", 0),
      makeMockLayer("rugcheck", 0.9),
      makeMockLayer("goplus", 0.9),
      makeMockLayer("crossvalidation", 1.0),
    ];
    expect(computeFinalScore(layers)).toBe(0);
  });
});


describe("classifySafeBlockedReasons — low_holders HARD reason", () => {
  it("classifies 'Very few holders (<15)' as low_holders HARD reason", () => {
    const layers = [
      makeLayer("solscan", 0.2, true, [{ label: "Very few holders (<15)", severity: "critical", impact: 0 }], false, true),
    ];
    const reasons = classifySafeBlockedReasons(layers);
    expect(reasons).toContain("low_holders");
  });

  it("classifies 'Low holders (<50)' as low_holders HARD reason", () => {
    const layers = [
      makeLayer("solscan", 0.35, true, [{ label: "Low holders (<50)", severity: "warning", impact: 0 }], false, true),
    ];
    const reasons = classifySafeBlockedReasons(layers);
    expect(reasons).toContain("low_holders");
  });

  it("does NOT classify 'Strong holder base (5K+)' as low_holders", () => {
    const layers = [
      makeLayer("solscan", 1.0, true, [{ label: "Strong holder base (5K+) \u2713", severity: "bonus", impact: 0 }], false, false),
    ];
    const reasons = classifySafeBlockedReasons(layers);
    expect(reasons).not.toContain("low_holders");
  });
});

describe("classifySafeBlockedReasons \u2014 pump_imbalance SOFT reason", () => {
  it("classifies 'Buy/sell imbalance (coordinated pump)' as pump_imbalance", () => {
    const layers = [
      makeLayer("dexscreener", 0.8, true, [
        { label: "Buy/sell imbalance (coordinated pump)", severity: "warning", impact: 0 },
      ], false, true),
    ];
    expect(classifySafeBlockedReasons(layers)).toContain("pump_imbalance");
  });

  it("pump_imbalance is NOT a hard block reason", () => {
    expect(HARD_BLOCK_REASONS.has("pump_imbalance")).toBe(false);
  });

  it("pump_imbalance IS a soft reason", () => {
    expect(SOFT_REASONS["pump_imbalance"]).toBe(true);
  });
});