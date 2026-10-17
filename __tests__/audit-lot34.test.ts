// __tests__/audit-lot34.test.ts — Lot 34 of the file-by-file audit (2026-10-17): the token page's pure helpers. Fails on the previous code.
//
// The Full Analysis page has its own copy of the flag-description table (js/formatters.js), with the same lookup as the overlay had
// (lot 30): the first key the label starts with won, so "Transfer fee can be changed — an authority can raise it to 100%"
// (api/_lib/layers.ts) was explained as a plain fee.

import { describe, it, expect } from "vitest"
import { getFlagDescription } from "../js/formatters.js"
import { __testing__ } from "../contents/modules/critical-flags"

const ENGINE_LABEL = "Transfer fee can be changed — an authority can raise it to 100%"

describe("token page — the description of the flag the engine really emits", () => {
  it("\"Transfer fee can be changed — …\" is explained as a possible honeypot (it read as a plain fee)", () => {
    expect(getFlagDescription(ENGINE_LABEL)).toContain("honeypot")
  })

  it("the page and the overlay give the same description for it, and for a plain fee (non-regression)", () => {
    expect(getFlagDescription(ENGINE_LABEL)).toBe(__testing__.getFlagDescription(ENGINE_LABEL))
    expect(getFlagDescription("Transfer fee 5% on every transfer")).toBe(__testing__.getFlagDescription("Transfer fee 5% on every transfer"))
  })
})
