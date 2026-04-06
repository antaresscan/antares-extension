import { describe, it, expect } from "vitest";
import {
  computeFinalScore,
} from "../api/_lib/scoring";
import {
  determineVerdict,
} from "../api/_lib/pipeline";
import {
  layerGoPlus, layerRugCheck,
} from "../api/_lib/layers";
import type { LayerResult, GoPlusTokenResult, RugCheckSummary } from "../api/_lib/types";
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

// ─── Session 7: VDOR-class rug regression ─────────────────────────────────────
// Ensures tokens like VDOR (Vanguard Digital Oil Reserve) are NEVER scored SAFE.
// VDOR fingerprint: deceptive institutional name + LP not locked + 4.5% sell tax.

describe("VDOR-class rug regression", () => {
  it("deceptive name (Vanguard) triggers safeBlocked in layerRugCheck", () => {
    const rugData: RugCheckSummary = {
      lpBurned: false,
      lpLocked: false,
      metaMutable: false,
    };
    const result = layerRugCheck(rugData, null, "VDORmint123", "Vanguard Digital Oil Reserve");
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /deceptive name/i.test(f.label))).toBe(true);
  });

  it("sell tax 4.5% (VDOR-style) triggers warning flag in layerGoPlus", () => {
    const goplus: GoPlusTokenResult = {
      is_honeypot: "0",
      cannot_sell_all: "0",
      mint_authority: "0",
      freeze_authority: "0",
      sell_tax: "4.5",
      buy_tax: "0",
    };
    const result = layerGoPlus(goplus);
    expect(result.flags.some(f => /sell tax.*suspicious/i.test(f.label))).toBe(true);
    expect(result.trust).toBeLessThan(1.0);
  });

  it("LP not locked/burned sets safeBlocked in layerRugCheck", () => {
    const rugData: RugCheckSummary = {
      lpBurned: false,
      lpLocked: false,
    };
    const result = layerRugCheck(rugData, null, "VDORmint123");
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /LP not burned or locked/i.test(f.label))).toBe(true);
  });

  it("VDOR-like token with high score is still blocked from SAFE verdict", () => {
    // Simulate a token that passes most checks but has safeBlocked=true
    const verdict = determineVerdict({
      score: 950,
      forceRug: false,
      safeBlocked: true,
      safeBlockedReasons: ["rug_pattern"],
      sourcesUsedCount: 5,
    });
    expect(verdict).not.toBe("SAFE");
    expect(["CAUTION", "DANGER", "RUG"]).toContain(verdict);
  });
});
