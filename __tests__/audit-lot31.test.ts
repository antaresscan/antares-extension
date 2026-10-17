/* @vitest-environment happy-dom */
// __tests__/audit-lot31.test.ts — Lot 31 of the file-by-file audit (2026-10-17): the overlay's renderer. Fails on the previous code.
//
// The renderer draws the card element by element (textContent): nothing the server sends is parsed as HTML. Four exports were dead (no
// caller anywhere: contents/, background, options, tests), one of them the only string-of-HTML builder left in the content script
// (buildSparkline, with the colour table it alone used). They are gone; what stays is pinned below.

import { describe, it, expect } from "vitest"

const components = await import("../contents/modules/components")
const constants = await import("../contents/modules/constants")

describe("overlay renderer — no dead HTML-string builders", () => {
  it("showCachedBadge, buildSparkline, formatTimeAgo, buildHeader and VERDICT_COLORS no longer exist", () => {
    for (const name of ["showCachedBadge", "buildSparkline", "formatTimeAgo", "buildHeader"]) expect(name in components, name).toBe(false)
    expect("VERDICT_COLORS" in constants).toBe(false)
  })

  it("a token name made of markup is drawn as text, never parsed (non-regression)", () => {
    const node = components.buildResultNode({
      score: 900, risk: "SAFE", flags: [], tokenSymbol: "<img src=x onerror=alert(1)>", tokenName: "<b>bold</b>",
    } as never, "So1anaTokenAddressForTests11111111111111111", null)
    expect(node.querySelector("img")).toBeNull()
    expect(node.querySelector(".tk b")?.textContent).toBe("<img src=x onerror=alert(1)>")
    expect(node.textContent).toContain("<b>bold</b>")
  })
})
