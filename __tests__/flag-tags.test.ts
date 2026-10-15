import { describe, it, expect } from "vitest";
import { makeFlag } from "../api/_lib/helpers";
import { dedupeFlags, countVerdictFlags } from "../api/_lib/pipeline";
import { computeFinalScore } from "../api/_lib/scoring";
import { isRugEvidence } from "../api/_lib/rugdb";
import { XV_PENALTY_LP_BURN, XV_PENALTY_MINT_AUTH, XV_PENALTY_AGE, XV_PENALTY_HOLDER_CONCENTRATION } from "../api/_lib/constants";
import { tagsOfText, codesFromUpstreamText } from "../api/_lib/upstream-text";
import type { FlagTag, LayerResult, ScanFlag } from "../api/_lib/types";

// What a flag IS (a source's health, a price-only pump, a disagreement between two sources, evidence of a rug...) is said by the layer
// that creates it, with ScanFlag.tags and ScanFlag.pumpPct. The places that used to read the label to find out now read these, so
// rewording a label cannot change a count, a score or what the rug database lists. Each test below changes the label and keeps the tag,
// then changes the tag and keeps the label.

const tagged = (label: string, severity: ScanFlag["severity"], tags: FlagTag[] = [], pumpPct?: number): ScanFlag => makeFlag(label, severity, 0, { tags, pumpPct });

describe("countVerdictFlags reads the tags", () => {
  it("a flag tagged source_status is not a token risk, whatever its label says", () => {
    expect(countVerdictFlags([tagged("The upstream is having a bad day", "warning", ["source_status"])]).warning).toBe(0);
  });

  it("witness: a flag whose label LOOKS like a source status but carries no tag is counted", () => {
    expect(countVerdictFlags([tagged("Helius unavailable — holder concentration unverified", "warning")]).warning).toBe(1);
  });

  it("a flag tagged pump_price_only is counted apart, whatever its label says", () => {
    expect(countVerdictFlags([tagged("A pump of some size", "warning", ["pump_price_only"])])).toEqual({ warning: 0, critical: 0, pumpPriceOnly: 1 });
  });

  it("witness: a price-only-looking label without the tag counts as a warning", () => {
    expect(countVerdictFlags([tagged("Pumped +340% over 7 days — high retrace risk at current prices", "warning")])).toEqual({ warning: 1, critical: 0, pumpPriceOnly: 0 });
  });
});

describe("dedupeFlags reads the pump percentage", () => {
  it("two flags with the same pumpPct are one signal, the most severe kept, whatever their labels say", () => {
    const out = dedupeFlags([tagged("One layer's words", "warning", [], 553), tagged("Another layer's words", "critical", [], 553), tagged("Something else", "warning")]);
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.pumpPct === 553)?.severity).toBe("critical");
  });

  it("different percentages are kept apart", () => {
    expect(dedupeFlags([tagged("a", "warning", [], 120), tagged("b", "warning", [], 340)])).toHaveLength(2);
  });

  it("witness: the same pump in two labels, with no pumpPct, is not merged", () => {
    expect(dedupeFlags([tagged("Large 24h pump +553% on token <24h", "warning"), tagged("Pumped +553% in 24h — exit liquidity risk on thin LP", "critical")])).toHaveLength(2);
  });
});

describe("computeFinalScore reads the cross-validation tags", () => {
  const layer = (source: string, flags: ScanFlag[] = []): LayerResult => ({ source, trust: 1, available: true, flags, forceRug: false, safeBlocked: false });
  const base = ["dexscreener", "rugcheck", "goplus", "helius", "solscan", "chart"].map((s) => layer(s));
  const scoreWith = (flags: ScanFlag[]) => computeFinalScore([...base, layer("crossvalidation", flags)]);
  const clean = scoreWith([]);

  it.each([
    ["xv_lp_burn", XV_PENALTY_LP_BURN],
    ["xv_mint_authority", XV_PENALTY_MINT_AUTH],
    ["xv_age", XV_PENALTY_AGE],
    ["xv_holder_concentration", XV_PENALTY_HOLDER_CONCENTRATION],
  ] as Array<[FlagTag, number]>)("a flag tagged %s costs the score its penalty, whatever its label says", (tag, penalty) => {
    expect(scoreWith([tagged("Any words at all", "warning", [tag])])).toBe(Math.round(Math.min(1, clean / 1000 * penalty) * 1000));
  });

  it("witness: a label that says 'LP burn conflict' without the tag costs nothing", () => {
    expect(scoreWith([tagged("LP burn conflict: RugCheck vs on-chain data", "warning")])).toBe(clean);
  });

  it("a flag without a cross-validation tag costs nothing, and a freeze conflict is not one (it never cost anything)", () => {
    expect(scoreWith([tagged("Freeze authority conflict: on-chain vs GoPlus", "warning")])).toBe(clean);
  });
});

describe("isRugEvidence reads the rug_evidence tag", () => {
  it("a critical flag tagged rug_evidence is evidence, whatever its label says", () => {
    expect(isRugEvidence([tagged("Some new wording", "critical", ["rug_evidence"])])).toBe(true);
  });

  it("witness: a critical flag that says 'abandoned pool' without the tag is not", () => {
    expect(isRugEvidence([tagged("Volume with zero liquidity — abandoned pool", "critical")])).toBe(false);
  });

  it("the tag counts only on a critical flag", () => {
    expect(isRugEvidence([tagged("x", "warning", ["rug_evidence"])])).toBe(false);
  });
});

describe("the door for an upstream's own text", () => {
  it("tagsOfText gives the six tags an upstream's text can have, in a fixed order", () => {
    expect(tagsOfText("Large Amount of LP Unlocked (40%)")).toEqual(["lp"]);
    expect(tagsOfText("RugCheck unavailable")).toEqual(["source_status"]);
    expect(tagsOfText("Pumped +340% over 7 days")).toEqual(["pump_price_only"]);
    expect(tagsOfText("Volume with zero liquidity — abandoned pool")).toEqual(["rug_evidence", "market_health"]);
    expect(tagsOfText("Very low liquidity (<$1k)")).toEqual(["market_health", "pool_depth"]);
    expect(tagsOfText("Collapsed -97% from its high 2 days ago")).toEqual(["market_health"]);
    expect(tagsOfText("Mutable metadata")).toEqual([]);
  });

  it("a RugCheck risk name about the market gets market_health at the door, a structural one does not", () => {
    expect(codesFromUpstreamText("rugcheck", "Low Liquidity ($3k)").tags).toEqual(["market_health", "pool_depth"]);
    expect(codesFromUpstreamText("rugcheck", "Top 10 holders high ownership").tags).toEqual([]);
    expect(codesFromUpstreamText("rugcheck", "Large Amount of LP Unlocked (40%)").tags).toEqual(["lp"]);
  });

  it("codesFromUpstreamText returns the reasons, the fallback reasons and the tags of a label, once", () => {
    const c = codesFromUpstreamText("rugcheck", "Large Amount of LP Unlocked (40%)");
    expect(c).toEqual({ reasons: [], fallbackReasons: ["lp"], tags: ["lp"] });
  });
});
