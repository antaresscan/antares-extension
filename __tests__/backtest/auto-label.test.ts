import { describe, it, expect } from "vitest"
import {
  detectLiquidityCollapse,
  detectMintAuthorityRisk,
  detectHoneypot,
  detectStableSafeToken,
  deriveGroundTruth,
  compareToGroundTruth,
  summariseCorpus,
} from "../../scripts/backtest/auto-label"
import type {
  TokenSnapshot,
  CorpusEntry,
  EngineVerdict,
} from "../../scripts/backtest/types"

// Convenience builder for snapshots — every field defaults to null so each
// test can fill in only what's relevant to the rule it's exercising. This
// is critical: the rules treat null as "no signal", not "no", so giving
// each test the empty-baseline guarantees an accidental default does not
// silently make a rule fire.
function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    ca: "TestMint11111111111111111111111111111111111",
    capturedAt: 0,
    liquidityUsd: null,
    holderCount: null,
    top1HolderPct: null,
    tokenAgeHours: null,
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    honeypot: null,
    lpBurned: null,
    lpLocked: null,
    volume24hUsd: null,
    rugcheckClassification: null,
    solscanScamFlag: null,
    ...over,
  }
}

const engine = (verdict: EngineVerdict["verdict"], score = 500): EngineVerdict => ({
  verdict,
  score,
  scoringVersion: "test-1.0",
})

// ════════════════════════════════════════════════════════════════════
// detectLiquidityCollapse
// ════════════════════════════════════════════════════════════════════
describe("detectLiquidityCollapse", () => {
  it("flags a >95% drop on a previously liquid token", () => {
    const initial = snap({ liquidityUsd: 50_000 })
    const current = snap({ liquidityUsd: 200 })
    const r = detectLiquidityCollapse(initial, current)
    expect(r?.collapsed).toBe(true)
    expect(r?.pctDrop).toBeGreaterThan(0.99)
  })

  it("does NOT flag a 50% drop", () => {
    const initial = snap({ liquidityUsd: 50_000 })
    const current = snap({ liquidityUsd: 25_000 })
    const r = detectLiquidityCollapse(initial, current)
    expect(r?.collapsed).toBe(false)
  })

  it("returns null when initial liquidity was below the meaningful threshold", () => {
    // A token that launched with $500 and now has $5 is not "rugged" —
    // it just died organically. We must abstain.
    const initial = snap({ liquidityUsd: 500 })
    const current = snap({ liquidityUsd: 5 })
    expect(detectLiquidityCollapse(initial, current)).toBeNull()
  })

  it("returns null when either snapshot is missing liquidity data", () => {
    expect(detectLiquidityCollapse(snap({ liquidityUsd: null }), snap({ liquidityUsd: 100 }))).toBeNull()
    expect(detectLiquidityCollapse(snap({ liquidityUsd: 100 }), snap({ liquidityUsd: null }))).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════
// detectMintAuthorityRisk
// ════════════════════════════════════════════════════════════════════
describe("detectMintAuthorityRisk", () => {
  it("flags a token >7 days old that still has mint authority active", () => {
    expect(detectMintAuthorityRisk(snap({
      mintAuthorityActive: true,
      tokenAgeHours: 24 * 30,
    }))).toBe(true)
  })

  it("does NOT flag a brand new token (dev hasn't had time to renounce)", () => {
    expect(detectMintAuthorityRisk(snap({
      mintAuthorityActive: true,
      tokenAgeHours: 12,
    }))).toBe(false)
  })

  it("does NOT flag when mint authority has been renounced", () => {
    expect(detectMintAuthorityRisk(snap({
      mintAuthorityActive: false,
      tokenAgeHours: 24 * 365,
    }))).toBe(false)
  })

  it("does NOT flag when authority status is unknown", () => {
    expect(detectMintAuthorityRisk(snap({
      mintAuthorityActive: null,
      tokenAgeHours: 24 * 30,
    }))).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// detectHoneypot
// ════════════════════════════════════════════════════════════════════
describe("detectHoneypot", () => {
  it("flags a confirmed honeypot", () => {
    expect(detectHoneypot(snap({ honeypot: true }))).toBe(true)
  })
  it("does NOT flag when honeypot is false or unknown", () => {
    expect(detectHoneypot(snap({ honeypot: false }))).toBe(false)
    expect(detectHoneypot(snap({ honeypot: null }))).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// detectStableSafeToken
// ════════════════════════════════════════════════════════════════════
describe("detectStableSafeToken", () => {
  const goodToken = snap({
    tokenAgeHours: 24 * 100,
    liquidityUsd: 50_000,
    holderCount: 1500,
    honeypot: false,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
  })

  it("flags a 100-day-old, well-funded, distributed, authority-renounced token", () => {
    expect(detectStableSafeToken(goodToken)).toBe(true)
  })

  it("rejects when too young", () => {
    expect(detectStableSafeToken({ ...goodToken, tokenAgeHours: 24 * 30 })).toBe(false)
  })

  it("rejects when liquidity is too thin", () => {
    expect(detectStableSafeToken({ ...goodToken, liquidityUsd: 5_000 })).toBe(false)
  })

  it("rejects when mint authority is still active (even if everything else is fine)", () => {
    expect(detectStableSafeToken({ ...goodToken, mintAuthorityActive: true })).toBe(false)
  })

  it("rejects when honeypot is true", () => {
    expect(detectStableSafeToken({ ...goodToken, honeypot: true })).toBe(false)
  })

  it("rejects on missing data — must affirmatively pass every gate", () => {
    expect(detectStableSafeToken({ ...goodToken, holderCount: null })).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════
// deriveGroundTruth — multi-oracle aggregation
// ════════════════════════════════════════════════════════════════════
describe("deriveGroundTruth", () => {
  it("HIGH confidence RUG when liquidity collapsed AND RugCheck agrees", () => {
    const r = deriveGroundTruth(
      snap({ liquidityUsd: 50_000 }),
      snap({ liquidityUsd: 100, rugcheckClassification: "rug" }),
    )
    expect(r.verdict).toBe("RUG")
    expect(r.confidence).toBe("HIGH")
    expect(r.oraclesAgreed).toBe(2)
  })

  it("HIGH confidence on liquidity collapse alone — single signal but unfakeable", () => {
    const r = deriveGroundTruth(
      snap({ liquidityUsd: 50_000 }),
      snap({ liquidityUsd: 100 }),
    )
    expect(r.verdict).toBe("RUG")
    expect(r.confidence).toBe("HIGH")
    expect(r.oraclesAgreed).toBe(1)
  })

  it("HIGH confidence on confirmed honeypot alone", () => {
    const r = deriveGroundTruth(
      snap({}),
      snap({ honeypot: true }),
    )
    expect(r.verdict).toBe("DANGER")
    expect(r.confidence).toBe("HIGH")
  })

  it("MEDIUM confidence when only RugCheck agrees, with no on-chain signal", () => {
    const r = deriveGroundTruth(
      snap({ liquidityUsd: 50_000 }),
      snap({ liquidityUsd: 50_000, rugcheckClassification: "danger" }),
    )
    expect(r.verdict).toBe("DANGER")
    expect(r.confidence).toBe("MEDIUM")
    expect(r.oraclesAgreed).toBe(1)
  })

  it("HIGH confidence SAFE when all signals align (stability + RugCheck)", () => {
    const r = deriveGroundTruth(
      snap({}),
      snap({
        tokenAgeHours: 24 * 200,
        liquidityUsd: 100_000,
        holderCount: 5_000,
        honeypot: false,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        rugcheckClassification: "safe",
      }),
    )
    expect(r.verdict).toBe("SAFE")
    expect(r.confidence).toBe("HIGH")
  })

  it("UNKNOWN with LOW confidence when no signal reaches any threshold", () => {
    const r = deriveGroundTruth(snap({}), snap({}))
    expect(r.verdict).toBe("UNKNOWN")
    expect(r.confidence).toBe("LOW")
    expect(r.oraclesAgreed).toBe(0)
  })

  it("RUG wins over SAFE when both have signals (severity tie-break)", () => {
    // Conflicting case: liquidity collapsed AND RugCheck says safe.
    // Liquidity-collapse is the harder evidence, so RUG must win.
    const r = deriveGroundTruth(
      snap({ liquidityUsd: 50_000 }),
      snap({ liquidityUsd: 100, rugcheckClassification: "safe" }),
    )
    expect(r.verdict).toBe("RUG")
  })
})

// ════════════════════════════════════════════════════════════════════
// compareToGroundTruth
// ════════════════════════════════════════════════════════════════════
describe("compareToGroundTruth", () => {
  it("TRUE_POSITIVE: engine flags DANGER, ground truth is RUG", () => {
    expect(compareToGroundTruth(engine("DANGER"), {
      verdict: "RUG", confidence: "HIGH", reasons: [], oraclesAgreed: 2,
    })).toBe("TRUE_POSITIVE")
  })

  it("TRUE_NEGATIVE: engine SAFE, ground truth SAFE", () => {
    expect(compareToGroundTruth(engine("SAFE"), {
      verdict: "SAFE", confidence: "HIGH", reasons: [], oraclesAgreed: 2,
    })).toBe("TRUE_NEGATIVE")
  })

  it("FALSE_POSITIVE: engine flags RUG on a confirmed-SAFE token", () => {
    expect(compareToGroundTruth(engine("RUG"), {
      verdict: "SAFE", confidence: "HIGH", reasons: [], oraclesAgreed: 2,
    })).toBe("FALSE_POSITIVE")
  })

  it("FALSE_NEGATIVE: engine SAFE on a confirmed RUG", () => {
    expect(compareToGroundTruth(engine("SAFE"), {
      verdict: "RUG", confidence: "HIGH", reasons: [], oraclesAgreed: 2,
    })).toBe("FALSE_NEGATIVE")
  })

  it("AMBIGUOUS when engine is CAUTION", () => {
    expect(compareToGroundTruth(engine("CAUTION"), {
      verdict: "RUG", confidence: "HIGH", reasons: [], oraclesAgreed: 2,
    })).toBe("AMBIGUOUS")
  })

  it("AMBIGUOUS when ground truth is UNKNOWN", () => {
    expect(compareToGroundTruth(engine("DANGER"), {
      verdict: "UNKNOWN", confidence: "LOW", reasons: [], oraclesAgreed: 0,
    })).toBe("AMBIGUOUS")
  })
})

// ════════════════════════════════════════════════════════════════════
// summariseCorpus — end-to-end aggregation
// ════════════════════════════════════════════════════════════════════
describe("summariseCorpus", () => {
  it("computes detection rate over HIGH-confidence cohort only", () => {
    const entries: CorpusEntry[] = [
      // HIGH-confidence RUG that engine caught — TP
      {
        initial: snap({ liquidityUsd: 50_000 }),
        current: snap({ liquidityUsd: 100, rugcheckClassification: "rug" }),
        engineVerdict: engine("DANGER"),
      },
      // HIGH-confidence RUG that engine missed — FN
      {
        initial: snap({ liquidityUsd: 50_000 }),
        current: snap({ liquidityUsd: 50, rugcheckClassification: "rug" }),
        engineVerdict: engine("SAFE"),
      },
      // HIGH-confidence SAFE that engine called SAFE — TN
      {
        initial: snap({}),
        current: snap({
          tokenAgeHours: 24 * 200,
          liquidityUsd: 100_000,
          holderCount: 5_000,
          honeypot: false,
          mintAuthorityActive: false,
          freezeAuthorityActive: false,
          rugcheckClassification: "safe",
        }),
        engineVerdict: engine("SAFE"),
      },
      // UNKNOWN ground truth — should be excluded from headline metrics
      {
        initial: snap({}),
        current: snap({}),
        engineVerdict: engine("DANGER"),
      },
    ]

    const summary = summariseCorpus(entries)

    expect(summary.totalEntries).toBe(4)
    expect(summary.highConfidenceEntries).toBe(3)
    expect(summary.outcomeCounts.TRUE_POSITIVE).toBe(1)
    expect(summary.outcomeCounts.FALSE_NEGATIVE).toBe(1)
    expect(summary.outcomeCounts.TRUE_NEGATIVE).toBe(1)
    expect(summary.outcomeCounts.AMBIGUOUS).toBe(1)

    // detectionRate = TP / (TP + FN) = 1 / 2 = 0.5
    expect(summary.detectionRate).toBe(0.5)
    // falsePositiveRate = FP / (FP + TN) = 0 / 1 = 0
    expect(summary.falsePositiveRate).toBe(0)
    // falseNegativeRate = FN / (TP + FN) = 1 / 2 = 0.5
    expect(summary.falseNegativeRate).toBe(0.5)
  })

  it("returns 0 rates without crashing on an empty corpus", () => {
    const summary = summariseCorpus([])
    expect(summary.totalEntries).toBe(0)
    expect(summary.highConfidenceEntries).toBe(0)
    expect(summary.detectionRate).toBe(0)
    expect(summary.falsePositiveRate).toBe(0)
    expect(summary.falseNegativeRate).toBe(0)
  })

  it("captures the engine version for the headline", () => {
    const summary = summariseCorpus([
      {
        initial: snap({}),
        current: snap({}),
        engineVerdict: { verdict: "SAFE", score: 800, scoringVersion: "7.1.0" },
      },
    ])
    expect(summary.scoringVersion).toBe("7.1.0")
  })
})
