import { describe, it, expect } from "vitest";
import { computeFinalScore, classifySafeBlockedReasons } from "../api/_lib/scoring";
import { HARD_BLOCK_REASONS, SOFT_REASONS } from "../api/_lib/constants";
import type { LayerResult, ScanFlag } from "../api/_lib/types";

function makeLayer(source: string, trust: number, available: boolean, flags: LayerResult["flags"] = [], forceRug = false, safeBlocked = false): LayerResult {
  return { source, trust, available, flags, forceRug, safeBlocked };
}

function flag(impact: number, severity: ScanFlag["severity"] = "critical", label = "test flag"): ScanFlag {
  return { label, severity, impact, flagClass: "structural" };
}

// ═══ computeFinalScore — additive model ════════════════════════════════════
// Score = 1000 - sum(dampened deductions) + sum(bonuses), floored at 0,
// capped at 1000. Deductions are flags with impact > 0, sorted worst-first,
// weighted 100% / 75% / 50% / 25% (plateau from the 4th flag on). Bonuses
// are flags with impact < 0, added back flat (undamped).
describe("computeFinalScore (additive model)", () => {
  it("returns 1000 for no flags", () => {
    expect(computeFinalScore([])).toBe(1000);
  });

  it("info/bonus-free flags with impact=0 don't affect score", () => {
    expect(computeFinalScore([flag(0, "info")])).toBe(1000);
  });

  it("single flag deducts its full impact (100% weight)", () => {
    expect(computeFinalScore([flag(300)])).toBe(700);
  });

  it("two flags: 1st at 100%, 2nd at 75%", () => {
    // 1000 - (500*1.00) - (300*0.75) = 1000 - 500 - 225 = 275
    expect(computeFinalScore([flag(300), flag(500)])).toBe(275);
  });

  it("three flags: 100% / 75% / 50%, sorted worst-first regardless of input order", () => {
    // worst-first: 400, 300, 200 → 400*1 + 300*.75 + 200*.5 = 400+225+100 = 725
    expect(computeFinalScore([flag(200), flag(400), flag(300)])).toBe(1000 - 725);
  });

  it("4th flag and beyond plateau at 25% (not a return to 0%)", () => {
    // four 250-point flags: 250*1 + 250*.75 + 250*.5 + 250*.25 = 250*2.5 = 625
    const flags = [flag(250), flag(250), flag(250), flag(250)];
    expect(computeFinalScore(flags)).toBe(1000 - 625);
  });

  it("6 flags at 25 all plateau after the 3rd — more real flags still make it worse", () => {
    const four = [flag(250), flag(250), flag(250), flag(250)];
    const six = [...four, flag(250), flag(250)];
    const scoreFour = computeFinalScore(four);
    const scoreSix = computeFinalScore(six);
    expect(scoreSix).toBeLessThan(scoreFour);
    // matches the ledger-validated example: 6×-250 → 250, 4×-250 → 375
    expect(scoreFour).toBe(375);
    expect(scoreSix).toBe(250);
  });

  it("score never goes negative — floors at 0", () => {
    expect(computeFinalScore([flag(650), flag(650)])).toBe(0);
  });

  it("bonus flags (negative impact) add back undamped", () => {
    // -50 impact = a +50 bonus
    expect(computeFinalScore([flag(-50)])).toBe(1000); // capped at 1000
    expect(computeFinalScore([flag(300), flag(-50)])).toBe(750);
  });

  it("score caps at 1000 even with only bonuses", () => {
    expect(computeFinalScore([flag(-50), flag(-50), flag(-50)])).toBe(1000);
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

  it("detects concentration (hard) reason from top-10 high/extreme flag (7.7.5+)", () => {
    // top-10 high or extreme: hard "concentration" regardless of tier.
    // Tests both fresh ("control risk" suffix) and established (no suffix) formats.
    const freshLayer: LayerResult[] = [
      makeLayer("helius", 0.25, true, [
        { label: "Top 10 hold 65% — high concentration · control risk", severity: "critical", impact: 0 }
      ], false, true),
    ];
    expect(classifySafeBlockedReasons(freshLayer)).toContain("concentration");

    const estLayer: LayerResult[] = [
      makeLayer("helius", 0.25, true, [
        { label: "Top 10 hold 82% — extreme concentration", severity: "critical", impact: 0 }
      ], false, true),
    ];
    expect(classifySafeBlockedReasons(estLayer)).toContain("concentration");
  });

  it("classifies top-10 elevated flags as SOFT concentration_light (7.7.5 — both tiers)", () => {
    // Fresh tier: "elevated concentration · cluster risk" → concentration_light
    const freshLayer: LayerResult[] = [
      makeLayer("helius", 0.5, true, [
        { label: "Top 10 hold 42% — elevated concentration · cluster risk", severity: "warning", impact: 0 }
      ], false, true),
    ];
    const freshReasons = classifySafeBlockedReasons(freshLayer);
    expect(freshReasons).toContain("concentration_light");
    expect(freshReasons).not.toContain("concentration");

    // Established tier: "elevated · exchanges may be included" → concentration_light
    const estLayer: LayerResult[] = [
      makeLayer("helius", 0.5, true, [
        { label: "Top 10 hold 52% — elevated · exchanges may be included", severity: "warning", impact: 0 }
      ], false, true),
    ];
    const estReasons = classifySafeBlockedReasons(estLayer);
    expect(estReasons).toContain("concentration_light");
    expect(estReasons).not.toContain("concentration");
    expect(estReasons).not.toContain("concentration_warning");
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