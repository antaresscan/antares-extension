import { describe, it, expect } from "vitest";
import { determineVerdict, hasRugEvidence, rugKindOf } from "../api/_lib/pipeline";
import type { LayerResult, VerdictInput } from "../api/_lib/types";

// RUG is an event, not a suspicion. A structure that looks like a rug (who holds the token, how it is built) is DANGER, however extreme;
// RUG needs a layer to have recorded that something happened to the token (LayerResult.rugEvidence: a pool drained while it still traded,
// a sale that is blocked). On the 365 recorded tokens that is 101 RUG verdicts becoming 1; the golden files show every one that moves.

const base: VerdictInput = { score: 100, forceRug: true, safeBlocked: true, safeBlockedReasons: ["concentration"], sourcesUsedCount: 5 };
const layer = (over: Partial<LayerResult> = {}): LayerResult => ({ source: "goplus", trust: 1, available: true, flags: [], forceRug: false, safeBlocked: false, ...over });

describe("determineVerdict with rugConfirmed", () => {
  it("a forced RUG that is not confirmed is DANGER", () => {
    expect(determineVerdict({ ...base, rugConfirmed: false })).toBe("DANGER");
  });

  it("a forced RUG that is confirmed is RUG", () => {
    expect(determineVerdict({ ...base, rugConfirmed: true })).toBe("RUG");
  });

  it("witness: a caller that says nothing keeps getting RUG (the old behaviour)", () => {
    expect(determineVerdict(base)).toBe("RUG");
  });

  it("a hard reason with a low score, and a plain very low score, are DANGER when nothing is confirmed", () => {
    expect(determineVerdict({ score: 300, forceRug: false, safeBlocked: true, safeBlockedReasons: ["lp"], sourcesUsedCount: 5, rugConfirmed: false })).toBe("DANGER");
    expect(determineVerdict({ score: 100, forceRug: false, safeBlocked: false, sourcesUsedCount: 5, warningFlagsCount: 0, criticalFlagsCount: 0, rugConfirmed: false })).toBe("DANGER");
  });

  it("witness: the same two are RUG when it is confirmed (or when nothing is said)", () => {
    expect(determineVerdict({ score: 300, forceRug: false, safeBlocked: true, safeBlockedReasons: ["lp"], sourcesUsedCount: 5, rugConfirmed: true })).toBe("RUG");
    expect(determineVerdict({ score: 100, forceRug: false, safeBlocked: false, sourcesUsedCount: 5, warningFlagsCount: 0, criticalFlagsCount: 0 })).toBe("RUG");
  });

  it("never touches a verdict that was not RUG", () => {
    for (const rugConfirmed of [true, false]) {
      expect(determineVerdict({ score: 950, forceRug: false, safeBlocked: false, sourcesUsedCount: 5, warningFlagsCount: 0, rugConfirmed })).toBe("SAFE");
      expect(determineVerdict({ score: 500, forceRug: false, safeBlocked: false, sourcesUsedCount: 5, warningFlagsCount: 1, rugConfirmed })).toBe("DANGER");
    }
  });
});

describe("hasRugEvidence", () => {
  it("is true when an available layer recorded evidence", () => {
    expect(hasRugEvidence([layer(), layer({ rugEvidence: ["sells_blocked"] })])).toBe(true);
  });

  it("ignores a layer that was not available, an empty list and no layer", () => {
    expect(hasRugEvidence([layer({ available: false, rugEvidence: ["pool_abandoned"] })])).toBe(false);
    expect(hasRugEvidence([layer({ rugEvidence: [] })])).toBe(false);
    expect(hasRugEvidence([])).toBe(false);
  });

  it("and so a RUG verdict is always a confirmed one: that is what makes rugKind 'confirmed' for every RUG", () => {
    const evidence = [layer({ rugEvidence: ["pool_abandoned"] })];
    expect(rugKindOf(determineVerdict({ ...base, rugConfirmed: hasRugEvidence(evidence) }), evidence)).toBe("confirmed");
    expect(rugKindOf(determineVerdict({ ...base, rugConfirmed: hasRugEvidence([]) }), [])).toBeNull();
  });
});
