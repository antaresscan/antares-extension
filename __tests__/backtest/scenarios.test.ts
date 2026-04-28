// __tests__/backtest/scenarios.test.ts
//
// Synthetic scenario tests for scoring regressions. The corpus tests
// in accuracy.test.ts validate against real-world fixtures; this file
// validates against hand-crafted minimal inputs that pin down the
// exact behaviour of each scoring decision.
//
// Why both: a real fixture exercises the full pipeline but mixes many
// signals. When the verdict drifts, you can't tell which signal moved.
// Synthetic scenarios isolate one variable per test, so when one
// fails you know exactly which rule of the engine is broken.
//
// Every regression bug we fix should land here as a permanent guard.

import { describe, it, expect } from "vitest"
import type { LayerResult, ScanFlag, SafeBlockedReason, Verdict, VerdictInput } from "../../api/_lib/types"
import { computeFinalScore, classifySafeBlockedReasons } from "../../api/_lib/scoring"
import { applySafeGateOverride, determineVerdict } from "../../api/_lib/pipeline"
import { HARD_BLOCK_REASONS } from "../../api/_lib/constants"

// ─── Minimal builders ────────────────────────────────────────────────
// These keep each test focused on the signal it's validating instead
// of drowning in 30 lines of boilerplate per case.

function flag(label: string, severity: "critical" | "warning" | "info" | "bonus" = "warning"): ScanFlag {
  return { label, severity, impact: 0 }
}

function layer(
  source: string,
  trust: number,
  flags: ScanFlag[] = [],
  opts: { available?: boolean; safeBlocked?: boolean; forceRug?: boolean } = {},
): LayerResult {
  return {
    source,
    trust,
    available: opts.available ?? true,
    flags,
    forceRug: opts.forceRug ?? false,
    safeBlocked: opts.safeBlocked ?? false,
  }
}

function defaultLayers(overrides: Partial<Record<string, LayerResult>> = {}): LayerResult[] {
  return [
    overrides.dexscreener ?? layer("dexscreener", 1.0),
    overrides.rugcheck ?? layer("rugcheck", 1.0),
    overrides.goplus ?? layer("goplus", 1.0),
    overrides.helius ?? layer("helius", 1.0),
    overrides.solscan ?? layer("solscan", 1.0),
    overrides.chart ?? layer("chart", 1.0),
    overrides.crossvalidation ?? layer("crossvalidation", 1.0),
  ]
}

function verdictWith(input: Partial<VerdictInput>): Verdict {
  return determineVerdict({
    score: 1000,
    safeBlocked: false,
    forceRug: false,
    safeBlockedReasons: [],
    sourcesUsedCount: 6,
    ...input,
  })
}

// ─── Score computation ──────────────────────────────────────────────
// Sanity checks on the geometric mean. Kept narrow because the math
// is well-tested elsewhere; we just confirm the wiring.

describe("score computation", () => {
  it("all layers at trust=1 → score 1000", () => {
    expect(computeFinalScore(defaultLayers())).toBe(1000)
  })

  it("any layer at trust=0 nukes the score to 0", () => {
    const layers = defaultLayers({ goplus: layer("goplus", 0) })
    expect(computeFinalScore(layers)).toBe(0)
  })

  it("a single 0.5 layer drops geometric mean meaningfully", () => {
    const layers = defaultLayers({ rugcheck: layer("rugcheck", 0.5) })
    const score = computeFinalScore(layers)
    expect(score).toBeLessThan(900)
    expect(score).toBeGreaterThan(700)
  })
})

// ─── Verdict band edges ──────────────────────────────────────────────

describe("verdict bands (no safe block)", () => {
  it("score 900 + 5 sources → SAFE", () => {
    expect(verdictWith({ score: 900 })).toBe("SAFE")
  })

  it("score 899 → CAUTION (just under SAFE threshold)", () => {
    expect(verdictWith({ score: 899 })).toBe("CAUTION")
  })

  it("score 600 → CAUTION (lower CAUTION edge)", () => {
    expect(verdictWith({ score: 600 })).toBe("CAUTION")
  })

  it("score 599 → DANGER", () => {
    expect(verdictWith({ score: 599 })).toBe("DANGER")
  })

  it("score 350 → DANGER (lower DANGER edge)", () => {
    expect(verdictWith({ score: 350 })).toBe("DANGER")
  })

  it("score 349 → RUG", () => {
    expect(verdictWith({ score: 349 })).toBe("RUG")
  })

  it("SAFE requires ≥5 sources even with score 1000", () => {
    expect(verdictWith({ score: 1000, sourcesUsedCount: 4 })).toBe("CAUTION")
  })
})

// ─── Safe-block routing (hard vs soft) ───────────────────────────────

describe("safeBlocked routing", () => {
  it("forceRug → RUG regardless of score", () => {
    expect(verdictWith({ forceRug: true, score: 1000 })).toBe("RUG")
  })

  it("safeBlocked + hard reason + score 500 → DANGER", () => {
    expect(verdictWith({
      safeBlocked: true,
      safeBlockedReasons: ["lp"],
      score: 500,
    })).toBe("DANGER")
  })

  it("safeBlocked + hard reason + score 399 → RUG", () => {
    expect(verdictWith({
      safeBlocked: true,
      safeBlockedReasons: ["honeypot"],
      score: 399,
    })).toBe("RUG")
  })

  it("safeBlocked + soft only + score ≥700 → CAUTION", () => {
    // Regression: this used to drop to DANGER because score was
    // clipped to 500 before reaching the verdict.
    expect(verdictWith({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      score: 750,
    })).toBe("CAUTION")
  })

  it("safeBlocked + soft only + score <700 → DANGER", () => {
    expect(verdictWith({
      safeBlocked: true,
      safeBlockedReasons: ["holders"],
      score: 699,
    })).toBe("DANGER")
  })

  it("hard reason wins over mixed reasons", () => {
    // If both hard and soft are present, hard determines the band.
    expect(verdictWith({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified", "lp"],
      score: 800,
    })).toBe("DANGER")
  })
})

// ─── Reason classification ───────────────────────────────────────────
// The bugs we hit recently were here. Pinning them down explicitly.

describe("reason classification", () => {
  it("LP-not-burned flag is classified as 'lp', NOT 'rug_pattern'", () => {
    // Regression: /rug|dump|exit trap/ was greedy and matched
    // "dev can rug liquidity" inside the LP flag, double-classifying
    // every LP-warning token. Verified live on NEET (DANGER 500
    // with reasons ["lp", "rug_pattern"] before the regex tighten).
    const flagLabel = "LP not burned or locked — dev can rug liquidity"
    const layers = defaultLayers({
      rugcheck: layer("rugcheck", 0.7, [flag(flagLabel, "warning")], { safeBlocked: true }),
    })
    const reasons = classifySafeBlockedReasons(layers)
    expect(reasons).toContain("lp")
    expect(reasons).not.toContain("rug_pattern")
  })

  it("Pump.fun launch flag is NOT classified as hard 'pump'", () => {
    // Regression: bare /pump/ matched the informational
    // "Pump.fun launch — verify holders & dev history" warning.
    // Hard 'pump' reason is reserved for genuine pump-pattern
    // detection (parabolic, exit-trap), not pump.fun launches.
    const flagLabel = "Pump.fun launch — verify holders & dev history"
    const layers = defaultLayers({
      dexscreener: layer("dexscreener", 0.8, [flag(flagLabel, "warning")], { safeBlocked: true }),
    })
    const reasons = classifySafeBlockedReasons(layers)
    expect(reasons).not.toContain("pump")
  })

  it("a single mature LP flag adds 'lp_unverified' (soft), not 'lp' (hard)", () => {
    const flagLabel = "LP not burned but token is mature and liquid (unverified LP)"
    const layers = defaultLayers({
      rugcheck: layer("rugcheck", 0.85, [flag(flagLabel, "warning")], { safeBlocked: true }),
    })
    const reasons = classifySafeBlockedReasons(layers)
    expect(reasons).toContain("lp_unverified")
    expect(reasons).not.toContain("lp")
  })

  it("single wallet ≥15% routes to hard 'concentration'", () => {
    const flagLabel = "Single wallet holds 27% of supply"
    const layers = defaultLayers({
      helius: layer("helius", 0.4, [flag(flagLabel, "critical")], { safeBlocked: true }),
    })
    const reasons = classifySafeBlockedReasons(layers)
    expect(reasons).toContain("concentration")
  })

  it("single wallet 10-14% stays soft (holders)", () => {
    // Sub-15% concentration is a CAUTION ceiling, not a DANGER hard block.
    const flagLabel = "Single wallet holds 11% of supply"
    const layers = defaultLayers({
      helius: layer("helius", 0.6, [flag(flagLabel, "warning")], { safeBlocked: true }),
    })
    const reasons = classifySafeBlockedReasons(layers)
    expect(reasons).not.toContain("concentration")
    expect(reasons).toContain("holders")
  })
})

// ─── Safe-gate unlock ────────────────────────────────────────────────

describe("safe gate unlock paths", () => {
  it("hard reason can NEVER be soft-unlocked, no matter how mature", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp", "honeypot"] as SafeBlockedReason[],
      forceRug: false,
      holders: 1_000_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 365 * 24,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(true)
  })

  it("soft-only unlocks via Path 1: age>48h + holders>1k + lpBurned + goPlusClean", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["age", "holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 5_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 100,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(false)
  })

  it("soft-only stays blocked under 48h of age", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["age"] as SafeBlockedReason[],
      forceRug: false,
      holders: 5_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 24,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(true)
  })

  it("soft-only with NO LP burn unlocks ONLY via Path 2 blue-chip override", () => {
    const blockedWithBigHolders = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 100_000, // way past the 50k blue-chip threshold
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 31 * 24, // > 30 days
      sourcesAvailableCount: 6,
    })
    expect(blockedWithBigHolders).toBe(false)

    const blockedWithoutBigHolders = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 10_000, // not enough for blue-chip override
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 31 * 24,
      sourcesAvailableCount: 6,
    })
    expect(blockedWithoutBigHolders).toBe(true)
  })
})

// ─── HARD_BLOCK_REASONS contract ─────────────────────────────────────

describe("HARD_BLOCK_REASONS contract", () => {
  it("the canonical hard-reason list contains the dangerous ones", () => {
    // If anyone removes one of these, it should at least be deliberate.
    for (const r of [
      "lp", "honeypot", "mint", "freeze",
      "wash_trading", "bundle", "sniper",
      "deceptive_name", "rug_pattern", "chart",
      "low_holders", "concentration",
    ]) {
      expect(HARD_BLOCK_REASONS.has(r), `${r} must be a hard reason`).toBe(true)
    }
  })

  it("'age', 'holders' and 'lp_unverified' are NOT hard reasons", () => {
    // These three are the only valid soft-unlock paths.
    expect(HARD_BLOCK_REASONS.has("age")).toBe(false)
    expect(HARD_BLOCK_REASONS.has("holders")).toBe(false)
    expect(HARD_BLOCK_REASONS.has("lp_unverified")).toBe(false)
  })
})
