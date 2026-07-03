import { describe, it, expect } from "vitest";
import { layerRugCheck } from "../api/_lib/layers";
import { classifySafeBlockedReasons, HARD_BLOCK_PATTERNS } from "../api/_lib/scoring";
import { applySafeGateOverride, determineVerdict, applyEstablishedBonus } from "../api/_lib/pipeline";
import { HARD_BLOCK_REASONS } from "../api/_lib/constants";
import { computeLpPctOfSupply, getLpRiskBucket } from "../api/_lib/lp-risk-matrix";

// ─── Test fixtures ───────────────────────────────────────────────────────────

const rugDataUnverified = {
  lpBurned: false,
  lpLocked: false,
  metaMutable: false,
  mintAuthorityEnabled: false,
  freezeAuthorityEnabled: false,
  topHolders: { top10Percentage: 25, top1Percentage: 5 },
};

const cleanContract = {
  mintAuthority: false,
  freezeAuthority: false,
  honeypot: false,
};

// Reusable maturity contexts — covering the 4 age buckets × representative
// LP-% values. The matrix lives in api/_lib/lp-risk-matrix.ts.
function ctx(opts: { ageHours: number; lpPctOfSupply: number | null; holders?: number; liquidity?: number; mintAuthority?: boolean; freezeAuthority?: boolean; honeypot?: boolean }) {
  return {
    holders: opts.holders ?? 10_000,
    liquidity: opts.liquidity ?? 500_000,
    tokenAgeHours: opts.ageHours,
    mintAuthority: opts.mintAuthority ?? false,
    freezeAuthority: opts.freezeAuthority ?? false,
    honeypot: opts.honeypot ?? false,
    lpPctOfSupply: opts.lpPctOfSupply,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeLpPctOfSupply — back-compute helper
// ─────────────────────────────────────────────────────────────────────────────
describe("computeLpPctOfSupply", () => {
  it("returns null for missing or zero inputs", () => {
    expect(computeLpPctOfSupply(null, 1, 1)).toBeNull();
    expect(computeLpPctOfSupply(1, null, 1)).toBeNull();
    expect(computeLpPctOfSupply(1, 1, null)).toBeNull();
    expect(computeLpPctOfSupply(0, 1, 1)).toBeNull();
    expect(computeLpPctOfSupply(1, 0, 1)).toBeNull();
    expect(computeLpPctOfSupply(1, 1, 0)).toBeNull();
    expect(computeLpPctOfSupply(-1, 1, 1)).toBeNull();
  });

  it("computes BONK-like blue chip at ~3% (rough match)", () => {
    // ~$5M liq, price $0.00002, totalSupply 58.5T
    // tokensInLp = (5_000_000 / 2) / 0.00002 = 125_000_000_000
    // pct = 125e9 / 58.5e12 ≈ 0.00214 (0.21%)
    const pct = computeLpPctOfSupply(5_000_000, 0.00002, 58_500_000_000_000);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(0.01); // <1%, sanity
  });

  it("computes fresh pump.fun token near 100% (high LP share)", () => {
    // $30k liq, price $0.00003, supply 1B (typical pump.fun bonding curve)
    // tokensInLp = 15000 / 0.00003 = 500M, pct = 500M / 1B = 0.5
    const pct = computeLpPctOfSupply(30_000, 0.00003, 1_000_000_000);
    expect(pct).toBeGreaterThan(0.3);
  });

  it("clamps computed pct to [0, 1] (prevents schema-error garbage)", () => {
    // priceUsd × 2 × totalSupply much smaller than liquidityUsd → pct > 1
    const pct = computeLpPctOfSupply(10_000_000, 0.01, 1000);
    expect(pct).toBe(1);
  });

  // ── Preferred path: reportedBaseReserve (DexScreener liquidity.base) ──────
  // Real on-chain reserve, accurate for concentrated-liquidity pools (Orca
  // CLMM, Meteora DLMM) where the 50/50-by-USD assumption below doesn't hold.
  describe("with reportedBaseReserve (real reserve, preferred over the 50/50 estimate)", () => {
    it("uses reportedBaseReserve directly: pct = reserve / totalSupply", () => {
      const pct = computeLpPctOfSupply(5_000_000, 0.00002, 58_500_000_000_000, 250_000_000_000);
      expect(pct).toBeCloseTo(250_000_000_000 / 58_500_000_000_000, 10);
    });

    it("ignores liquidityUsd/priceUsd entirely when a valid reserve is given (even if those are null)", () => {
      const pct = computeLpPctOfSupply(null, null, 1_000_000_000, 900_000_000);
      expect(pct).toBe(0.9);
    });

    it("fixes the concentrated-pool case: 50/50 estimate would be wrong, reserve is exact", () => {
      // A CLMM pool skewed 90/10 instead of 50/50: liquidityUsd=$100k,
      // priceUsd=$0.001 → naive 50/50 estimate = (100_000/2)/0.001 = 50M
      // tokens (5% of a 1B supply). The real reserve (reported by
      // DexScreener from actual pool state) is 90M tokens (9% of supply) —
      // nearly double the naive estimate, which matters for bucket selection
      // (5-10% vs 1-5% has different safeBlock behaviour at <14 days).
      const naive = computeLpPctOfSupply(100_000, 0.001, 1_000_000_000);
      const real = computeLpPctOfSupply(100_000, 0.001, 1_000_000_000, 90_000_000);
      expect(naive).toBeCloseTo(0.05, 10);
      expect(real).toBeCloseTo(0.09, 10);
      expect(real).not.toBeCloseTo(naive!, 3);
    });

    it("falls back to the 50/50 estimate when reportedBaseReserve is 0, negative, or omitted", () => {
      const fallbackZero = computeLpPctOfSupply(5_000_000, 0.00002, 58_500_000_000_000, 0);
      const fallbackNegative = computeLpPctOfSupply(5_000_000, 0.00002, 58_500_000_000_000, -100);
      const fallbackOmitted = computeLpPctOfSupply(5_000_000, 0.00002, 58_500_000_000_000);
      expect(fallbackZero).toBeCloseTo(fallbackOmitted!, 10);
      expect(fallbackNegative).toBeCloseTo(fallbackOmitted!, 10);
    });

    it("clamps reserve-derived pct to [0, 1]", () => {
      const pct = computeLpPctOfSupply(1, 1, 1000, 5000); // reserve > totalSupply
      expect(pct).toBe(1);
    });

    it("still requires a valid totalSupply even with a reported reserve", () => {
      expect(computeLpPctOfSupply(5_000_000, 0.00002, null, 900_000_000)).toBeNull();
      expect(computeLpPctOfSupply(5_000_000, 0.00002, 0, 900_000_000)).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLpRiskBucket — direct matrix cell coverage
// ─────────────────────────────────────────────────────────────────────────────
describe("getLpRiskBucket — matrix cells", () => {
  it("returns 'unknown' bucket when LP % is null (no totalSupply etc.)", () => {
    const b = getLpRiskBucket(null, 8000);
    expect(b.pctBucket).toBe("unknown");
    expect(b.severity).toBe("warning");
    expect(b.safeBlock).toBe(true);
    expect(b.flagLabel).toMatch(/could not be computed/i);
  });

  it("returns 'unknown' bucket when age is null", () => {
    const b = getLpRiskBucket(0.05, null);
    expect(b.ageBucket).toBe("unknown");
  });

  // ── TINY LP (<1%) — should always pass freely ─────────────────
  it("LP <1% × any age → info, no safeBlock, near-zero penalty", () => {
    for (const ageHours of [1, 14 * 24 + 1, 100 * 24, 400 * 24]) {
      const b = getLpRiskBucket(0.005, ageHours);
      expect(b.pctBucket).toBe("<1%");
      expect(b.severity).toBe("info");
      expect(b.safeBlock).toBe(false);
      expect(b.forceRug).toBe(false);
      expect(b.penalty).toBeGreaterThanOrEqual(0.95);
      expect(b.flagLabel).toMatch(/0\.50% of supply/);
      expect(b.flagLabel).toMatch(/negligible/i);
    }
  });

  // ── LOW LP (1-5%) — LP < 10% NEVER safeBlocks (7.7.7 rule) ────
  it("LP 3% × fresh (<14d) → info + safeBlock=false (LP<10% = info any age, 7.7.9)", () => {
    // 7.7.9: LP 1-5% is info on ALL ages including fresh <14d.
    // A 3% LP drain causes <15% price impact — not worth CAUTION on its own.
    const b = getLpRiskBucket(0.03, 10 * 24);
    expect(b.pctBucket).toBe("1-5%");
    expect(b.ageBucket).toBe("<14d");
    expect(b.severity).toBe("info");
    expect(b.safeBlock).toBe(false);
  });

  it("LP 3% × 1y+ → info + no safeBlock + label shows pct only (no risk suffix)", () => {
    // 7.7.7: labels for LP < 10% buckets show only the percentage — no
    // "limited rug impact" suffix (that text was confusing on SAFE tokens).
    const b = getLpRiskBucket(0.03, 400 * 24);
    expect(b.severity).toBe("info");
    expect(b.safeBlock).toBe(false);
    expect(b.flagLabel).toMatch(/3\.0% of supply/);
    // No risk-tier suffix on buckets <10%
    expect(b.flagLabel).not.toMatch(/limited rug impact/i);
  });

  // ── MODERATE LP (5-15%) — fresh blocks, mature passes ─────────
  it("LP 10% × fresh → safeBlock=true", () => {
    const b = getLpRiskBucket(0.10, 5 * 24);
    expect(b.safeBlock).toBe(true);
  });

  it("LP 10% × 90d-1y → info + safeBlock=false (USER'S 6mo×25% INSIGHT — adapted)", () => {
    // Pre-matrix: this token was hitting CAUTION because 'looksMature' set
    // safeBlock=true unconditionally. Post-matrix: a 6-month-old token with
    // a 10% LP gets an info flag and the verdict can land on SAFE.
    const b = getLpRiskBucket(0.10, 180 * 24);
    expect(b.severity).toBe("info");
    expect(b.safeBlock).toBe(false);
  });

  // ── SIGNIFICANT LP (15-30%) — the user's exact 6mo×25% case ───
  it("LP 25% × 90d-1y (THE USER'S CASE) → warning + safeBlock=false", () => {
    // "Pourquoi 6mois lp 25% tu le mets en caution!" — the answer: it's not
    // CAUTION anymore. The time-based trust signal dominates.
    const b = getLpRiskBucket(0.25, 180 * 24);
    expect(b.pctBucket).toBe("15-30%");
    expect(b.ageBucket).toBe("90d-1y");
    expect(b.severity).toBe("warning");
    expect(b.safeBlock).toBe(false);
    expect(b.flagLabel).toMatch(/significant rug capacity/i);
    expect(b.summaryLine).toMatch(/months/);
    expect(b.summaryLine).toMatch(/-50% to -80%/);
  });

  it("LP 25% × <14d → critical + safeBlock=true", () => {
    const b = getLpRiskBucket(0.25, 5 * 24);
    expect(b.severity).toBe("critical");
    expect(b.safeBlock).toBe(true);
  });

  // ── HIGH LP (30-60%) — always safeBlock, never SAFE ───────────
  it("LP 45% × 1y+ → still warning + safeBlock=true", () => {
    const b = getLpRiskBucket(0.45, 400 * 24);
    expect(b.safeBlock).toBe(true);
    expect(b.forceRug).toBe(false);
  });

  // ── EXTREME LP (>60%) — fresh forces RUG ──────────────────────
  it("LP 95% × <14d (pump.fun typical) → forceRug=true", () => {
    const b = getLpRiskBucket(0.95, 2 * 24);
    expect(b.severity).toBe("critical");
    expect(b.safeBlock).toBe(true);
    expect(b.forceRug).toBe(true);
    expect(b.flagLabel).toMatch(/extreme rug exposure/i);
    expect(b.flagLabel).toMatch(/95\.0% of supply/);
  });

  it("LP 95% × 1y+ → warning + safeBlock=true but NO forceRug (time signal partially redeems)", () => {
    const b = getLpRiskBucket(0.95, 400 * 24);
    expect(b.severity).toBe("warning");
    expect(b.safeBlock).toBe(true);
    expect(b.forceRug).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// layerRugCheck integration — matrix output flows into the layer result
// ─────────────────────────────────────────────────────────────────────────────
describe("layerRugCheck — matrix integration", () => {
  it("BONK-like (2y, LP 0.5%, clean) → no safeBlock, SAFE possible", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "BONK", "BONK",
      ctx({ ageHours: 18_000, lpPctOfSupply: 0.005, ...cleanContract }),
    );
    expect(result.safeBlocked).toBe(false);
    expect(result.flags.some(f => /negligible rug risk/i.test(f.label))).toBe(true);
  });

  it("6mo × 25% LP (THE USER'S CASE) → no safeBlock — was CAUTION before matrix", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "MIDCAP", "MidCap",
      ctx({ ageHours: 180 * 24, lpPctOfSupply: 0.25, ...cleanContract }),
    );
    expect(result.safeBlocked).toBe(false);
    expect(result.flags.some(f => /significant rug capacity/i.test(f.label))).toBe(true);
  });

  it("pump.fun fresh (LP 95%, <14d) → forceRug=true", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "PUMP123", "PumpFresh",
      ctx({ ageHours: 12, lpPctOfSupply: 0.95, ...cleanContract }),
    );
    expect(result.forceRug).toBe(true);
    expect(result.safeBlocked).toBe(true);
  });

  it("contract NOT clean (freeze auth on) → matrix relaxations bypassed, hard rug flag", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "FRZ", "FreezableToken",
      ctx({ ageHours: 18_000, lpPctOfSupply: 0.005, freezeAuthority: true }),
    );
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /contract not clean/i.test(f.label))).toBe(true);
  });

  it("missing LP % data → falls back to 'unknown' bucket (conservative CAUTION)", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "X", "X",
      ctx({ ageHours: 18_000, lpPctOfSupply: null, ...cleanContract }),
    );
    expect(result.safeBlocked).toBe(true);
    expect(result.flags.some(f => /could not be computed/i.test(f.label))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifySafeBlockedReasons — matrix labels are recognised
// ─────────────────────────────────────────────────────────────────────────────
describe("classifySafeBlockedReasons — matrix label recognition", () => {
  it("lp_unverified is still NOT in HARD_BLOCK_REASONS (back-compat)", () => {
    expect(HARD_BLOCK_REASONS.has("lp_unverified")).toBe(false);
    expect(HARD_BLOCK_REASONS.has("lp")).toBe(true);
  });

  it("matrix critical bucket label classifies as 'lp' (hard)", () => {
    const fakeLayer = {
      source: "rugcheck" as const,
      trust: 0.5,
      available: true,
      flags: [{ label: "LP holds 45.0% of supply — high rug exposure", severity: "critical" as const, score: 0, impact: 0 }],
      forceRug: false,
      safeBlocked: true,
    };
    const reasons = classifySafeBlockedReasons([fakeLayer]);
    expect(reasons).toContain("lp");
  });

  it("matrix info/warning bucket label classifies as 'lp_unverified' (soft)", () => {
    const fakeLayer = {
      source: "rugcheck" as const,
      trust: 0.9,
      available: true,
      flags: [{ label: "LP holds 8.3% of supply — moderate rug capacity", severity: "warning" as const, score: 0, impact: 0 }],
      forceRug: false,
      safeBlocked: true,
    };
    const reasons = classifySafeBlockedReasons([fakeLayer]);
    expect(reasons).toContain("lp_unverified");
    expect(reasons).not.toContain("lp");
  });

  it("regex patterns are correctly ordered (critical wins over generic)", () => {
    // Critical pattern must be earlier in HARD_BLOCK_PATTERNS so it matches
    // first; otherwise a "high rug exposure" label would get tagged as
    // soft lp_unverified and the safe-gate would let it through.
    const labels = HARD_BLOCK_PATTERNS.map(p => p[1]);
    const lpFirst = labels.indexOf("lp");
    const lpUnvFirst = labels.indexOf("lp_unverified");
    expect(lpFirst).toBeLessThan(lpUnvFirst);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applySafeGateOverride — soft lp_unverified can still be unlocked on
// established tokens (back-compat behaviour preserved)
// ─────────────────────────────────────────────────────────────────────────────
describe("applySafeGateOverride — soft unlock back-compat", () => {
  it("lp_unverified + established signals → unlocked (no safeBlock)", () => {
    const blocked = applySafeGateOverride({
      safeBlocked: true,
      safeBlockedReasons: ["lp_unverified"],
      forceRug: false,
      holders: 100_000,
      lpBurned: false,
      goPlusClean: true,
      tokenAgeHours: 2000,
      sourcesAvailableCount: 6,
    });
    expect(blocked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// determineVerdict — blue chip (matrix bucket safeBlock=false) → SAFE possible
// ─────────────────────────────────────────────────────────────────────────────
describe("determineVerdict — end-to-end on matrix output", () => {
  it("blue chip (matrix says safeBlock=false) with high score lands on SAFE", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "BONK", "BONK",
      ctx({ ageHours: 18_000, lpPctOfSupply: 0.005, ...cleanContract }),
    );
    expect(result.safeBlocked).toBe(false);
    const verdict = determineVerdict({
      score: 920,
      safeBlocked: false,
      safeBlockedReasons: [],
      forceRug: false,
      sourcesUsedCount: 6,
    });
    expect(verdict).toBe("SAFE");
  });

  it("pump fresh + LP 95% (matrix forceRug=true) → RUG", () => {
    const result = layerRugCheck(
      rugDataUnverified, null, "PUMP", "Pump",
      ctx({ ageHours: 12, lpPctOfSupply: 0.95, ...cleanContract }),
    );
    expect(result.forceRug).toBe(true);
    const verdict = determineVerdict({
      score: 300,
      safeBlocked: true,
      safeBlockedReasons: ["lp"],
      forceRug: true,
      sourcesUsedCount: 6,
    });
    expect(verdict).toBe("RUG");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyEstablishedBonus — keep existing back-compat tests
// ─────────────────────────────────────────────────────────────────────────────
describe("applyEstablishedBonus — back-compat", () => {
  it("established token + LP burned → +30 bonus", () => {
    const score = applyEstablishedBonus({
      score: 800,
      tokenAgeHours: 2500,
      holders: 75000,
      lpBurned: true,
      goPlusClean: true,
    });
    expect(score).toBeGreaterThan(800);
  });

  it("non-established token (low holders, no LP burn) → no bonus", () => {
    const score = applyEstablishedBonus({
      score: 800,
      tokenAgeHours: 2500,
      holders: 30000,
      lpBurned: false,
      goPlusClean: true,
    });
    expect(score).toBe(800);
  });
});
