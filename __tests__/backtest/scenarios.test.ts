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

  it("2 warning flags blocks SAFE — max CAUTION (VIRL-class)", () => {
    // VIRL: vol/liq warning + LP unverified = 2 flags, score 1000.
    // Two flags means something is wrong even if each is minor individually.
    expect(verdictWith({ score: 1000, warningFlagsCount: 2 })).toBe("CAUTION")
  })

  it("2 warning flags + score 899 → CAUTION (below SAFE floor anyway)", () => {
    expect(verdictWith({ score: 899, warningFlagsCount: 2 })).toBe("CAUTION")
  })

  it("1 warning flag + score 900 → CAUTION (any flag = no SAFE)", () => {
    // 7.7.8: ANY detected warning/critical flag caps verdict at CAUTION.
    // "SAFE + 1 flag detected" is contradictory — if we flagged a problem,
    // SAFE is not credible regardless of the score.
    expect(verdictWith({ score: 900, warningFlagsCount: 1 })).toBe("CAUTION")
  })

  it("0 flags + score 900 → SAFE", () => {
    expect(verdictWith({ score: 900, warningFlagsCount: 0 })).toBe("SAFE")
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

  it("top-10 high/extreme → hard 'concentration' (7.7.5 — fresh & established labels)", () => {
    for (const lbl of [
      "Top 10 hold 82% — extreme concentration",
      "Top 10 hold 65% — high concentration · control risk",
      "Top 10 hold 70% — high concentration",
    ]) {
      const layers = defaultLayers({
        helius: layer("helius", 0.2, [flag(lbl, "critical")], { safeBlocked: true }),
      })
      expect(classifySafeBlockedReasons(layers)).toContain("concentration")
    }
  })

  it("top-10 elevated → soft 'concentration_light' (7.7.5 — fresh & established labels)", () => {
    for (const lbl of [
      "Top 10 hold 42% — elevated concentration · cluster risk",
      "Top 10 hold 52% — elevated · exchanges may be included",
    ]) {
      const layers = defaultLayers({
        helius: layer("helius", 0.6, [flag(lbl, "warning")], { safeBlocked: true }),
      })
      const reasons = classifySafeBlockedReasons(layers)
      expect(reasons).toContain("concentration_light")
      expect(reasons).not.toContain("concentration")
      expect(reasons).not.toContain("concentration_warning")
    }
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
    // 7.7.0 (RIV case): "holders" reclassified hard, so this Path-1
    // unlock test now uses ONLY ["age"] as the soft reason. Mixing
    // "holders" into the list would (correctly) keep the gate closed.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["age"] as SafeBlockedReason[],
      forceRug: false,
      holders: 5_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 100,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(false)
  })

  // ─── REGRESSION ─────────────────────────────────────────────────────
  // RIV case (user-reported 2026-05-28). Token had:
  //   - 5,136 holder ADDRESSES (count looked solid)
  //   - 40% top-1 holder (catastrophic concentration)
  //   - Helius unavailable → engine couldn't see distribution
  // Old SOFT_REASONS classed "holders" as unlockable, so the count-based
  // established check (Path 2) flipped the verdict to SAFE 1000. Visible
  // user bug: "le token est safe alors qu'il y a un wallet qui détient
  // 40% de la supply".
  //
  // 7.7.0 fix: "holders" is no longer SOFT. Without verified distribution
  // data, the gate stays closed regardless of holder COUNT.
  it("REGRESSION (RIV): reasons=['holders'] stays blocked under every established-token combo", () => {
    // Path 1 attempt: LP burned, big holder count, mature, GoPlus clean
    const blockedPath1 = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 5_136, // RIV's actual holder address count
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 60 * 24, // 2 months old
      sourcesAvailableCount: 6,
    })
    expect(blockedPath1, "RIV-style holders-only must stay blocked under Path 1").toBe(true)

    // Path 2 attempt: 100k holders, LP NOT burned, very mature
    // (matches the prior blue-chip-without-LP-burn unlock that broke
    // the safe-gate for RIV-class false positives)
    const blockedPath2 = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 100_000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 31 * 24,
      sourcesAvailableCount: 6,
    })
    expect(blockedPath2, "RIV-style holders-only must stay blocked under Path 2 even with 100k holders").toBe(true)

    // Mixed with another soft reason: still blocked because "holders" is hard
    const blockedMixed = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["age", "holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 5_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 100,
      sourcesAvailableCount: 6,
    })
    expect(blockedMixed, "any 'holders' reason in the list keeps the gate closed").toBe(true)
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

  // Path 3 — Blue-chip concentration exemption.
  // Lets DAO tokens with team multi-sigs at 15-25% land on SAFE/CAUTION
  // instead of DANGER, but only under strict blue-chip conditions.
  it("Path 3 (RETIRED 7.7.1): metric-based blue-chip unlock no longer fires regardless of holder count", () => {
    // Pre-7.7.1: 90k holders + LP burned + concentration → blue-chip
    // exemption unlocks → SAFE/CAUTION.
    // 7.7.1: founder rule "si un wallet du top 10 dépasse 10% c'est
    // danger automatiquement" — metric-based exemption retired.
    // Only the hardcoded isKnownDaoTreasury allowlist can bypass.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration"] as SafeBlockedReason[],
      forceRug: false,
      holders: 90_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: null,
      sourcesAvailableCount: 6,
      mint: "NOT_A_KNOWN_DAO_XYZ",
    })
    expect(blocked).toBe(true)
  })

  it("Path 3: still blocked when holders < 50k even with LP burned + clean", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration"] as SafeBlockedReason[],
      forceRug: false,
      holders: 30_000, // below blue-chip threshold
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 365 * 24,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(true)
  })

  it("Path 3: still blocked when LP NOT burned, even with massive holders", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration"] as SafeBlockedReason[],
      forceRug: false,
      holders: 200_000,
      lpBurned: false, // LP burn is non-negotiable for blue-chip exemption
      goPlusClean: true,
      tokenAgeHours: 365 * 24,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(true)
  })

  it("Path 3: does NOT unlock when other hard reasons are present alongside concentration", () => {
    // Multiple hard reasons → not eligible for blue-chip exemption.
    // Concentration alone is the only hard reason this path forgives.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration", "honeypot"] as SafeBlockedReason[],
      forceRug: false,
      holders: 100_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 365 * 24,
      sourcesAvailableCount: 6,
    })
    expect(blocked).toBe(true)
  })

  it("Path 3: blue-chip metric exemption RETIRED (7.7.1) — concentration → DANGER regardless of holder count", () => {
    // 7.7.1 (founder rule): "si un wallet du top 10 dépasse 10% c'est
    // danger automatiquement". The previous metric-based blue-chip
    // exemption (50k+ holders + LP burned + 30d+ → unlock) is RETIRED.
    // Only the hardcoded isKnownDaoTreasury allowlist can bypass
    // concentration — every other token, regardless of holder count
    // or LP status, stays blocked and routes to DANGER.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration"] as SafeBlockedReason[],
      forceRug: false,
      holders: 150_000, // PENGU-tier holder count
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 365 * 24, // years old
      sourcesAvailableCount: 6,
      mint: "NOT_A_KNOWN_DAO_MINT_XYZ",
    })
    expect(blocked).toBe(true)
  })

  it("Path 3 allowlist: known DAO mint unlocks even when holders < 50k (data quality fallback)", () => {
    // JTO is the canonical case — holders count collapses to the
    // Helius top-20 view (=20) when Solscan/RugCheck/GoPlus are
    // simultaneously degraded. The metric-based heuristic misses,
    // but the allowlist catches it based on mint identity.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration"] as SafeBlockedReason[],
      forceRug: false,
      holders: 20, // collapsed due to data quality
      lpBurned: false, // also unknown / failed to confirm
      goPlusClean: false,
      tokenAgeHours: null,
      sourcesAvailableCount: 6,
      mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    })
    expect(blocked).toBe(false)
  })

  it("Path 3 allowlist: unknown mint with bad signals stays blocked", () => {
    // Same bad signals as JTO test, but the mint is NOT on the
    // allowlist. Stays DANGER. Allowlist must NOT generalise.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration"] as SafeBlockedReason[],
      forceRug: false,
      holders: 20,
      lpBurned: false,
      goPlusClean: false,
      tokenAgeHours: null,
      sourcesAvailableCount: 6,
      mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", // FARTCOIN — not allowlisted
    })
    expect(blocked).toBe(true)
  })

  it("Path 3 allowlist: even known DAOs stay blocked if other hard reason present", () => {
    // Allowlist only forgives concentration. If JTO somehow gets
    // a honeypot flag, it must NOT be auto-unlocked.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration", "honeypot"] as SafeBlockedReason[],
      forceRug: false,
      holders: 50_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 365 * 24,
      sourcesAvailableCount: 6,
      mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    })
    expect(blocked).toBe(true)
  })

  it("Path 3 (RETIRED 7.7.1): concentration + soft reasons no longer unlocks via metric-based blue-chip path", () => {
    // Pre-7.7.1 this test asserted that concentration + lp_unverified
    // on a blue-chip metric-passing token unlocked the gate. After the
    // metric-based exemption was retired, the gate stays closed for
    // every token not on the isKnownDaoTreasury allowlist.
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["concentration", "lp_unverified"] as SafeBlockedReason[],
      forceRug: false,
      holders: 90_000,
      lpBurned: true,
      goPlusClean: true,
      tokenAgeHours: 365 * 24,
      sourcesAvailableCount: 6,
      mint: "NOT_A_KNOWN_DAO_XYZ",
    })
    expect(blocked).toBe(true)
  })

  // Pre-7.7.0 this test asserted Path 2 unlocked when reasons=["holders"]
  // + 100k holders + LP not burned. After the RIV reclassification,
  // "holders" no longer participates in any soft-unlock path: the gate
  // stays blocked regardless of holder count when distribution is
  // unverified. Test reframed accordingly.
  it("reasons=['holders'] (alone or with others) NEVER unlocks via any path", () => {
    // Even with 100k holders + 30d+ age + GoPlus clean, the gate
    // stays closed because we have no verified DISTRIBUTION.
    const stillBlocked100k = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 100_000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 31 * 24,
      sourcesAvailableCount: 6,
    })
    expect(stillBlocked100k).toBe(true)

    // Same with insufficient holders — still blocked.
    const stillBlocked10k = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["holders"] as SafeBlockedReason[],
      forceRug: false,
      holders: 10_000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 31 * 24,
      sourcesAvailableCount: 6,
    })
    expect(stillBlocked10k).toBe(true)
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

  it("'age' and 'lp_unverified' are NOT hard reasons (still soft-unlockable)", () => {
    // Soft-unlockable: can flip from blocked to unlocked when the
    // token shows enough established-token signals.
    expect(HARD_BLOCK_REASONS.has("age")).toBe(false)
    expect(HARD_BLOCK_REASONS.has("lp_unverified")).toBe(false)
  })

  it("'holders' is NOT in HARD_BLOCK_REASONS but is also NOT soft-unlockable (7.7.0)", () => {
    // After RIV (2026-05-28): "holders" sits in a third bucket — neither
    // explicit-hard (HARD_BLOCK_REASONS) nor soft-unlockable
    // (SOFT_REASONS). The default-block fall-through in
    // applySafeGateOverride keeps the gate closed. Listing it as
    // explicit-hard would force DANGER on every Helius-unavailable
    // scan; the current placement caps the verdict at CAUTION while
    // still refusing to grant SAFE.
    expect(HARD_BLOCK_REASONS.has("holders")).toBe(false)
  })
})
