import { describe, it, expect } from "vitest"
import { SHADOW_CSS } from "../contents/modules/styles"

// The small messages the overlay adds under its card (the loading hint, "Scanned 6 min ago") speak in the card's own voice: Bebas Neue, like
// the labels of the pills and the wordmark, not the IBM Plex Mono of the old "Still loading" hint.

const rule = (selector: string): string => {
  const start = SHADOW_CSS.indexOf(`\n${selector} {`)
  expect(start, `${selector} is styled`).toBeGreaterThan(-1)
  return SHADOW_CSS.slice(start, SHADOW_CSS.indexOf("}", start))
}

describe("the overlay's small messages use the card's font", () => {
  it.each([".skel-slow-hint", ".scanned-ago"])("%s is Bebas Neue, uppercase, centred, in the grey of the other small labels", (selector) => {
    const css = rule(selector)
    expect(css).toContain("'Bebas Neue'")
    expect(css).not.toContain("IBM Plex Mono")
    expect(css).toContain("text-align: center")
    expect(css).toContain("#777")
  })

  it("both messages have the same size and spacing, so that they read as one voice", () => {
    const size = (css: string) => css.match(/font(?:-size)?:\s*(?:400\s+)?(\d+(?:\.\d+)?)px/)?.[1]
    const spacing = (css: string) => css.match(/letter-spacing:\s*([.\d]+em)/)?.[1]
    expect(size(rule(".skel-slow-hint"))).toBe(size(rule(".scanned-ago")))
    expect(spacing(rule(".skel-slow-hint"))).toBe(spacing(rule(".scanned-ago")))
  })
})
