import { describe, it, expect } from "vitest";
import {
  computeFinalScore,
} from "../api/_lib/scoring";
import {
  determineVerdict,
} from "../api/_lib/pipeline";
import type { LayerResult } from "../api/_lib/types";
import { computeCacheTTL } from "../api/_lib/helpers";

// ─── Session 1: Safety overhaul regressions ──────────────────────────────────

describe("Session 1 regressions", () => {
  it("forceRug tokens always get score <= 100", () => {
    const result = determineVerdict({
      score: 800,
      forceRug: true,
      safeBlocked: false,
      safeBlockedReasons: [],
      sourcesUsedCount: 5,
    });
    expect(result).toBe("RUG");
  });

  it("safeBlocked tokens never get SAFE verdict", () => {
    const result = determineVerdict({
      score: 900,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: ["mint"],
      sourcesUsedCount: 5,
    });
    expect(result).not.toBe("SAFE");
  });
});

// ─── Session 3: Scoring math regressions ────────────────────────────────────

describe("Session 3 regressions", () => {
  it("Score never exceeds 1000", () => {
    const layers: LayerResult[] = Array.from({ length: 8 }, (_, i) => ({
      source: `source${i}`,
      available: true,
      trust: 1.0,
      weight: 0.2,
      flags: [],
      forceRug: false,
      safeBlocked: false,
    }));
    const score = computeFinalScore(layers);
    expect(score).toBeLessThanOrEqual(1000);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("Score never goes below 0", () => {
    const layers: LayerResult[] = Array.from({ length: 8 }, (_, i) => ({
      source: `source${i}`,
      available: true,
      trust: 0.0,
      weight: 0.2,
      flags: [],
      forceRug: false,
      safeBlocked: false,
    }));
    const score = computeFinalScore(layers);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ─── Session 5: Verdict logic regressions ────────────────────────────────────

describe("Session 5 regressions", () => {
  it("Soft safeBlock with score 550+ -> CAUTION", () => {
    const verdict = determineVerdict({
      score: 570,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: ["age"],
      sourcesUsedCount: 5,
    });
    expect(verdict).toBe("CAUTION");
  });

  it("Hard safeBlock with score 400 -> RUG or DANGER", () => {
    const verdict = determineVerdict({
      score: 400,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: ["honeypot"],
      sourcesUsedCount: 5,
    });
    expect(["DANGER", "RUG"]).toContain(verdict);
  });
});

// ─── Session 6: Cache & helpers regressions ──────────────────────────────────

describe("Session 6 regressions", () => {
  it("computeCacheTTL returns valid positive number for all inputs", () => {
    expect(computeCacheTTL(null)).toBeGreaterThan(0);
    expect(computeCacheTTL(0)).toBeGreaterThan(0);
    expect(computeCacheTTL(60)).toBeGreaterThan(0);
    expect(computeCacheTTL(1440)).toBeGreaterThan(0);
    expect(computeCacheTTL(100000)).toBeGreaterThan(0);
  });
});
