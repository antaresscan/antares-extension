import { describe, it, expect } from "vitest";
import { layerRugCheck } from "../api/_lib/layers";
import { classifySafeBlockedReasons } from "../api/_lib/scoring";
import { HARD_BLOCK_PATTERNS } from "../api/_lib/upstream-text";
import { flagsWithCodes } from "./fixtures/flag-codes";
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
  it("LP <1% × 90 days or more → info, no safeBlock, near-zero penalty (under 90 days the first-three-months rule applies, see below)", () => {
    for (const ageHours of [100 * 24, 400 * 24]) {
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
  it("LP 3% × fresh (<14d) → CRITICAL + safeBlock whatever the share (first month, founder rule 2026-10-13; it was info in 7.7.9)", () => {
    // 80 % of the young tokens of the replay corpus whose LP is not burned or locked collapsed, and a young token has one market: the pool.
    const b = getLpRiskBucket(0.03, 10 * 24);
    expect(b.pctBucket).toBe("1-5%");
    expect(b.ageBucket).toBe("<14d");
    expect(b.severity).toBe("critical");
    expect(b.safeBlock).toBe(true);
    expect(b.forceRug).toBe(false);
    expect(b.flagLabel).toMatch(/^LP not burned or locked — token under 30 days old/);
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
      flags: flagsWithCodes("rugcheck", [{ label: "LP holds 45.0% of supply — high rug exposure", severity: "critical" as const, impact: 0 }]),
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
      flags: flagsWithCodes("rugcheck", [{ label: "LP holds 8.3% of supply — moderate rug capacity", severity: "warning" as const, impact: 0 }]),
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

// ─────────────────────────────────────────────────────────────────────────────
// The first three months (founder rule 2026-10-13)
//   under 30 days → CRITICAL whatever the LP share (DANGER, never CAUTION)
//   30-90 days    → at least a WARNING that blocks SAFE (CAUTION at best)
//   90 days +     → the matrix, unchanged (LP < 10 % of supply = information)
// ─────────────────────────────────────────────────────────────────────────────
describe("getLpRiskBucket — the first three months", () => {
  const DAY = 24;

  it("under 30 days, every LP share is critical + safeBlock + the hard reason 'lp', with the first-month wording, and never forces RUG by itself", () => {
    // 15-30 % on a token under 14 days is critical in the matrix already: it keeps its own wording (next test), so it is not in this loop.
    const cases: Array<[number, number]> = [];
    for (const pct of [0.004, 0.03, 0.07, 0.12]) for (const ageHours of [1, 5 * DAY, 20 * DAY, 30 * DAY - 1]) cases.push([pct, ageHours]);
    cases.push([0.2, 20 * DAY], [0.2, 30 * DAY - 1]); // 15-30 % between 14 and 30 days was a warning
    for (const [pct, ageHours] of cases) {
      {
        const b = getLpRiskBucket(pct, ageHours);
        const where = `${pct * 100}% × ${ageHours}h`;
        expect(b.severity, where).toBe("critical");
        expect(b.safeBlock, where).toBe(true);
        expect(b.forceRug, where).toBe(false);
        expect(b.flagReasons, where).toEqual(["lp"]);
        expect(b.flagLabel, where).toMatch(/^LP not burned or locked — token under 30 days old, dev can rug liquidity$/);
        expect(b.penalty, where).toBeLessThanOrEqual(0.75);
      }
    }
  });

  it("an LP share that is not known is critical too, and the wording does not invent a share", () => {
    const b = getLpRiskBucket(null, 5 * DAY);
    expect(b.pctBucket).toBe("unknown");
    expect(b.severity).toBe("critical");
    expect(b.safeBlock).toBe(true);
    expect(b.flagTooltip).not.toMatch(/of the supply is in the pool/);
    expect(getLpRiskBucket(0.039, 5 * DAY).flagTooltip).toMatch(/3\.9% of the supply is in the pool/);
  });

  it("a cell that is already critical keeps its own wording and its forced RUG (extreme exposure on a fresh launch)", () => {
    const high = getLpRiskBucket(0.45, 10 * DAY);
    expect(high.severity).toBe("critical");
    expect(high.flagLabel).toMatch(/high rug exposure/i);
    const extreme = getLpRiskBucket(0.95, 2 * DAY);
    expect(extreme.forceRug).toBe(true);
    expect(extreme.flagLabel).toMatch(/extreme rug exposure/i);
  });

  it("the edges: 29.9 days is critical, 30 days is a warning, 89.9 days is a warning, 90 days is the matrix again", () => {
    expect(getLpRiskBucket(0.03, 30 * DAY - 1).severity).toBe("critical");
    const month = getLpRiskBucket(0.03, 30 * DAY);
    expect(month.severity).toBe("warning");
    expect(month.safeBlock).toBe(true);
    const almost = getLpRiskBucket(0.03, 90 * DAY - 1);
    expect(almost.severity).toBe("warning");
    expect(almost.safeBlock).toBe(true);
    const three = getLpRiskBucket(0.03, 90 * DAY);
    expect(three.severity).toBe("info");
    expect(three.safeBlock).toBe(false);
  });

  it("from 30 to 90 days an unlocked LP is at least a warning that blocks SAFE, for every share the matrix called information", () => {
    for (const pct of [0.004, 0.03, 0.07, 0.12]) {
      const b = getLpRiskBucket(pct, 45 * DAY);
      expect(b.severity, `${pct * 100}%`).toBe("warning");
      expect(b.safeBlock, `${pct * 100}%`).toBe(true);
      expect(b.forceRug).toBe(false);
      expect(b.penalty).toBeLessThanOrEqual(0.92);
    }
  });

  it("from 30 to 90 days a cell that was already a warning or critical is untouched", () => {
    expect(getLpRiskBucket(0.2, 45 * DAY)).toMatchObject({ severity: "warning", safeBlock: true });
    expect(getLpRiskBucket(0.45, 45 * DAY)).toMatchObject({ severity: "critical", safeBlock: true });
  });

  it("90 days and more: the matrix, unchanged (the blue chips are there: LP < 10 % is information and SAFE is possible)", () => {
    for (const ageHours of [100 * DAY, 180 * DAY, 400 * DAY]) {
      expect(getLpRiskBucket(0.005, ageHours)).toMatchObject({ severity: "info", safeBlock: false });
      expect(getLpRiskBucket(0.03, ageHours)).toMatchObject({ severity: "info", safeBlock: false });
      expect(getLpRiskBucket(0.09, ageHours)).toMatchObject({ severity: "info", safeBlock: false });
    }
    expect(getLpRiskBucket(0.25, 180 * DAY)).toMatchObject({ severity: "warning", safeBlock: false });
  });

  it("an age that is not known is not 'young': the conservative warning of the unknown bucket, as before", () => {
    expect(getLpRiskBucket(0.03, null)).toMatchObject({ ageBucket: "unknown", severity: "warning", safeBlock: true });
  });

  it("the first-month wording is read as the hard reason 'lp' by the tables, whatever the share", () => {
    const b = getLpRiskBucket(0.03, 5 * DAY);
    expect(classifySafeBlockedReasons([{ source: "rugcheck", trust: 1, available: true, safeBlocked: true, forceRug: false, flags: [{ label: b.flagLabel, severity: "critical", impact: 0, reasons: b.flagReasons }] }])).toEqual(["lp"]);
    expect(HARD_BLOCK_REASONS.has("lp")).toBe(true);
  });
});

describe("layerRugCheck — the first three months reach the layer", () => {
  it("a 10-day-old token with an unlocked LP of 3 % (clean contract): critical flag, SAFE blocked", () => {
    const result = layerRugCheck(rugDataUnverified, null, "RARI", "RARI", ctx({ ageHours: 10 * 24, lpPctOfSupply: 0.03, ...cleanContract }));
    expect(result.safeBlocked).toBe(true);
    const lp = result.flags.find((f) => /^LP not burned or locked — token under 30 days old/.test(f.label));
    expect(lp?.severity).toBe("critical");
  });

  it("the same token at 45 days: a warning that blocks SAFE; at 120 days: information that does not", () => {
    const month = layerRugCheck(rugDataUnverified, null, "T", "T", ctx({ ageHours: 45 * 24, lpPctOfSupply: 0.03, ...cleanContract }));
    expect(month.safeBlocked).toBe(true);
    expect(month.flags.find((f) => /^LP holds 3\.0% of supply/.test(f.label))?.severity).toBe("warning");
    const later = layerRugCheck(rugDataUnverified, null, "T", "T", ctx({ ageHours: 120 * 24, lpPctOfSupply: 0.03, ...cleanContract }));
    expect(later.safeBlocked).toBe(false);
    expect(later.flags.find((f) => /^LP holds 3\.0% of supply/.test(f.label))?.severity).toBe("info");
  });

  it("a verdict from it: a young token, perfect otherwise, is DANGER (never CAUTION); at 45 days CAUTION; at 120 days SAFE is possible", () => {
    const verdictAt = (ageHours: number) => {
      const r = layerRugCheck(rugDataUnverified, null, "T", "T", ctx({ ageHours, lpPctOfSupply: 0.03, ...cleanContract }));
      const risky = r.flags.filter((f) => f.severity === "critical" || f.severity === "warning");
      return determineVerdict({
        score: 950, forceRug: r.forceRug, safeBlocked: r.safeBlocked, safeBlockedReasons: r.safeBlocked ? ["lp"] : [], sourcesUsedCount: 5,
        warningFlagsCount: risky.length, criticalFlagsCount: risky.filter((f) => f.severity === "critical").length, pumpPriceOnlyFlagsCount: 0,
      });
    };
    expect(verdictAt(10 * 24)).toBe("DANGER");
    expect(verdictAt(29 * 24)).toBe("DANGER");
    expect(["CAUTION", "DANGER"]).toContain(verdictAt(45 * 24)); // a warning: never SAFE
    expect(verdictAt(45 * 24)).not.toBe("SAFE");
    expect(verdictAt(120 * 24)).toBe("SAFE");
  });
});

