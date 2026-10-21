/* @vitest-environment happy-dom */

import { describe, it, expect } from "vitest"
import { buildResult, flagSummaryLine } from "../contents/modules/components"
import type { ScanResponseData } from "../shared/types"

// The line under the score bar. "4 flags detected" under a CAUTION read as an alarm when none of the four was critical (the owner's remark, 2026-10-21, on DOOD:
// a CAUTION with four warnings): with no critical flag the line now says what the flags are, "4 warnings — no critical". A critical flag is still counted out loud.

describe("flagSummaryLine", () => {
  it.each([
    // [risk, flags counted (warning + critical), of which critical, the line]
    ["CAUTION", 4, 0, "4 warnings — no critical"],
    ["CAUTION", 1, 0, "1 warning — no critical"],
    ["DANGER", 3, 0, "3 warnings — no critical"], // three warnings are a DANGER on their own (the 3-warning floor): still no critical flag
    ["DANGER", 4, 1, "4 flags — 1 critical"], // a mix: the total, then how many are critical
    ["DANGER", 3, 1, "3 flags — 1 critical"],
    ["DANGER", 3, 2, "3 flags — 2 critical"],
    ["RUG", 5, 3, "5 flags — 3 critical"],
    ["CAUTION", 2, 1, "2 flags — 1 critical"],
    ["DANGER", 1, 1, "1 critical flag"], // only critical flags: "flag" behind, a bare "1 critical" is not understood
    ["DANGER", 3, 3, "3 critical flags"],
    ["RUG", 1, 1, "1 critical flag"],
    ["SAFE", 0, 0, "No issues found"],
    ["CAUTION", 0, 0, "Limited data"],
    ["DANGER", 0, 0, "Risk detected"],
  ])("%s with %i flag(s), %i critical: %s", (risk, flags, crit, line) => {
    expect(flagSummaryLine(risk, flags, crit)).toBe(line)
  })

  it("SAFE always reads 'No issues found', whatever the counts (the verdict is the single source of truth)", () => {
    expect(flagSummaryLine("SAFE", 3, 1)).toBe("No issues found")
  })

  it("only critical flags: 'flag' or 'flags' follows the word critical, never a bare 'N critical'", () => {
    for (const n of [1, 2, 3, 5]) expect(flagSummaryLine("DANGER", n, n)).toMatch(new RegExp("^" + n + " critical flags?$"))
  })

  it("never says 'detected' any more: that word under a CAUTION was the alarm", () => {
    for (const risk of ["SAFE", "CAUTION", "DANGER", "RUG"]) for (const n of [0, 1, 4]) for (const c of [0, 1]) {
      if (c <= n) expect(flagSummaryLine(risk, n, c)).not.toMatch(/detected\b.*flag|flags? detected/)
    }
  })
})

const MINT = "So11111111111111111111111111111111111111112"
const flag = (label: string, severity: string) => ({ label, severity, impact: 5 })
function scan(over: Partial<ScanResponseData> = {}): ScanResponseData {
  return {
    score: 750, risk: "CAUTION", flags: [], pair: null, resolvedMint: MINT, confidence: 80, sources_used: ["dexscreener"],
    holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 864_100, tokenSymbol: "DOOD", tokenName: "Doodles",
    lpBurned: false, lpLocked: false, safeBlocked: true, mintAuthority: false, freezeAuthority: false, honeypot: false,
    freshForSec: 300, staleLeftSec: 1200, fetchedAt: Date.now(),
    ...over,
  } as ScanResponseData
}

describe("the card, through buildResult", () => {
  it("the DOOD case: a CAUTION with four warnings reads '4 warnings — no critical', not '4 flags detected'", () => {
    const html = buildResult(scan({ flags: [
      flag("High vol/liquidity ratio (>5×)", "warning"),
      flag("Top 10 hold 74% — high · established token, exchanges, treasuries and vaults may be included", "warning"),
      flag("Metadata mutable", "warning"),
      flag("Transfer fee", "warning"),
      flag("LP Burned ✓", "bonus"), flag("Liquidity < $900k", "info"), // notes are not counted
    ] as ScanResponseData["flags"] }), MINT)
    expect(html).toContain("4 warnings — no critical")
    expect(html).not.toContain("flags detected")
  })

  it("a critical flag with warnings: '3 flags — 1 critical' (the total, then the critical ones)", () => {
    const html = buildResult(scan({ risk: "DANGER", flags: [flag("Mint Authority enabled", "critical"), flag("Metadata mutable", "warning"), flag("Transfer fee", "warning")] as ScanResponseData["flags"] }), MINT)
    expect(html).toContain("3 flags — 1 critical")
    expect(html).not.toContain("no critical")
  })

  it("a lone critical flag reads '1 critical flag'", () => {
    const html = buildResult(scan({ risk: "DANGER", flags: [flag("Mint Authority enabled", "critical")] as ScanResponseData["flags"] }), MINT)
    expect(html).toContain("1 critical flag")
    expect(html).not.toContain("1 flag —")
  })

  // The whole matrix, through the real card: every number of critical flags (0 to 4) with every number of warnings (0 to 5), the notes (info, bonus) and a status flag
  // thrown in, which are not counted. The expected line is written here from the rules of the owner (2026-10-21), not read from the code.
  const expected = (risk: string, crit: number, warn: number): string => {
    if (risk === "SAFE") return "No issues found"
    const n = crit + warn
    if (n === 0) return risk === "CAUTION" ? "Limited data" : "Risk detected"
    if (crit === 0) return warn + (warn === 1 ? " warning" : " warnings") + " — no critical"
    if (warn === 0) return crit + (crit === 1 ? " critical flag" : " critical flags") // only critical: "flag" behind
    return n + " flags — " + crit + " critical" // a mix: the total, then the critical ones
  }
  const W = ["Metadata mutable", "Top 10 hold 52% — elevated", "Pump +480% in 24h", "Transfer fee", "High vol/liquidity ratio (>5×)"]
  const C = ["Mint Authority enabled", "Freeze Authority enabled", "Sniper activity detected", "Wash trading detected", "Bundle activity detected"]
  const cases: Array<[number, number]> = []
  for (let c = 0; c <= 4; c++) for (let w = 0; w <= 5; w++) cases.push([c, w])

  it.each(cases)("%i critical, %i warning(s): the card reads what the rules say, whatever the verdict", (crit, warn) => {
    for (const risk of crit > 0 ? ["DANGER", "RUG"] : warn === 0 ? ["SAFE", "CAUTION", "DANGER"] : ["CAUTION", "DANGER"]) {
      const flags = [
        ...C.slice(0, crit).map((l) => flag(l, "critical")),
        ...W.slice(0, warn).map((l) => flag(l, "warning")),
        flag("Top 10 hold 38%", "info"), flag("LP Burned ✓", "bonus"), flag("GoPlus unavailable", "warning"), // none of these is counted
      ]
      const html = buildResult(scan({ risk, flags: flags as ScanResponseData["flags"] }), MINT)
      expect(html, `${risk}, ${crit} critical, ${warn} warnings`).toContain(">" + expected(risk, crit, warn) + "<")
    }
  })

  it("a SAFE card reads 'No issues found'", () => {
    expect(buildResult(scan({ risk: "SAFE", score: 1000, flags: [] }), MINT)).toContain("No issues found")
  })
})
