/* @vitest-environment happy-dom */
// __tests__/audit-lot32.test.ts — Lot 32 of the file-by-file audit (2026-10-17): the overlay's styles and fonts. Fails on the previous code.
//
// Measured in Chrome 152 (built-in browser, example.com, 2026-10-17): a stylesheet linked INSIDE a shadow root is downloaded, but the
// @font-face it declares is ignored. A span in a closed root, styled 'Bebas Neue', kept the fallback's width (153.95 px) with the Google
// Fonts link in the root, and took the font (107.48 px) only once the same link was added to the document. So the Google Fonts link the
// overlay put in its root changed nothing on screen, and sent every visitor of a supported page to Google. The fonts the card shows are
// the ones injectFonts() declares in the document: embedded, hinted (audit-lots/woff2-hint-probe.cjs).

import { describe, it, expect, beforeEach } from "vitest"

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { createHost } = await import("../contents/modules/components")
const { state } = await import("../contents/modules/state")

describe("overlay fonts — nothing is fetched from Google", () => {
  beforeEach(() => {
    document.getElementById("antares-host")?.remove()
    document.getElementById("antares-fonts")?.remove()
  })

  it("the overlay's root links no stylesheet from fonts.googleapis.com (it did, with no effect on screen)", () => {
    createHost()
    expect(state.shadow!.querySelector('link[href*="fonts.googleapis.com"]')).toBeNull()
    expect(state.shadow!.querySelector("link")).toBeNull()
  })

  it("the fonts the card shows are still declared in the document, embedded (non-regression)", () => {
    createHost()
    const css = document.getElementById("antares-fonts")?.textContent ?? ""
    for (const family of ["Bebas Neue", "IBM Plex Mono"]) expect(css).toContain(`font-family: '${family}'`)
    expect(css).toContain("data:font/woff2;base64,")
    expect(css).not.toContain("googleapis")
  })
})
