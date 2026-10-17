// __tests__/audit-lot57.test.ts — Lot 57 of the file-by-file audit (2026-10-17): the decision tests.
//
// determineVerdict's second line, "no source answered → DANGER", was checked by no test: a mutation removing it survived the whole suite
// AND the full replay. Without it a scan with no data at all reads CAUTION (a soft block with a good score) or DANGER only by accident of
// the score; SAFE stays impossible (it needs 3 or 5 sources), but "we know nothing" must never look milder than DANGER. This pins it; it
// fails on a pipeline.ts without the line (checked with audit-lots/mutate.cjs, then restored).

import { describe, it, expect } from "vitest"
import { determineVerdict } from "../api/_lib/pipeline"

const base = { score: 1000, forceRug: false, safeBlocked: false, safeBlockedReasons: [] as string[], warningFlagsCount: 0, criticalFlagsCount: 0 }

describe("determineVerdict — no source answered: DANGER, whatever the score", () => {
  it("0 sources, a perfect score, nothing flagged: DANGER", () => {
    expect(determineVerdict({ ...base, sourcesUsedCount: 0 })).toBe("DANGER")
  })

  it("0 sources with a soft block (a source down) and a good score: DANGER, not CAUTION", () => {
    expect(determineVerdict({ ...base, sourcesUsedCount: 0, safeBlocked: true, safeBlockedReasons: ["helius"], score: 800 })).toBe("DANGER")
  })

  it("the count missing (an old caller): DANGER", () => {
    expect(determineVerdict({ ...base, sourcesUsedCount: undefined as unknown as number })).toBe("DANGER")
  })

  it("the same perfect token with 5 sources is SAFE (the test sees the difference)", () => {
    expect(determineVerdict({ ...base, sourcesUsedCount: 5 })).toBe("SAFE")
  })
})
