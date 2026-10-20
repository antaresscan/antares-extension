/* @vitest-environment happy-dom */
import { describe, it, expect, beforeEach } from "vitest"
import { SHADOW_CSS } from "../contents/modules/styles"
import { state } from "../contents/modules/state"
import { toggleAiSummary } from "../contents/modules/ai-summary"
import { toggleCriticalFlags } from "../contents/modules/critical-flags"

// The two panels under the card (Critical Flags, AI Summary) read in the card's own voice: Bebas Neue, like the verdict, the pills and the buttons that open them.
// They were set in IBM Plex Mono (bold labels, italic descriptions), which is the one place of the card that looked like another product. Bebas Neue has a single
// weight and no italic: asking for 600/700 or `italic` would make the browser fake them, which smears the letters.

const rule = (selector: string): string => {
  const start = SHADOW_CSS.indexOf(`\n${selector} {`)
  expect(start, `${selector} is styled`).toBeGreaterThan(-1)
  return SHADOW_CSS.slice(start, SHADOW_CSS.indexOf("}", start))
}

const CRITICAL_FLAGS_TEXT = [".cf-section-header", ".cf-section-count", ".cf-section-title", ".cf-flag-label", ".cf-flag-desc", ".cf-panel-empty"]
const AI_SUMMARY_TEXT = [".ai-panel-verdict", ".ai-panel-line", ".ai-panel-loading", ".ai-panel-empty"]
// A rule that sets no font of its own inherits the one of the rule it sits in: the count and the title live in the section header.
const INHERITS_FONT = new Set([".cf-section-count", ".cf-section-title"])

describe("the Critical Flags and AI Summary panels are set in Bebas Neue", () => {
  it.each([...CRITICAL_FLAGS_TEXT, ...AI_SUMMARY_TEXT])("%s", (selector) => {
    const css = rule(selector)
    if (!INHERITS_FONT.has(selector)) expect(css).toMatch(/font-family:\s*'Bebas Neue'/)
    expect(css).not.toContain("IBM Plex Mono")
    expect(css).not.toMatch(/font-style:\s*italic/)
    expect(css).not.toMatch(/font-weight:\s*(?:[5-9]\d\d|bold)/)
  })

  it("the section count and title inherit Bebas Neue from the header they sit in", () => {
    expect(rule(".cf-section-header")).toMatch(/font-family:\s*'Bebas Neue'/)
    for (const part of INHERITS_FONT) expect(rule(part), part).not.toMatch(/font-family/)
  })
})

// The round marks of the flags (cross, !, i, tick) and the number of each section are shapes of the card, not characters: a character comes out of whichever font the page falls
// back to (a thin tick, an "i" with serifs, a "!" that sits low) and a number in a padded pill is an oval. The real browser measures them (npm run overlay:check, panels); this
// keeps the CSS that makes them round and drawn from being edited away.
describe("the round marks of the Critical Flags panel are drawn on exact circles", () => {
  it("the mark is a 14px circle with its character hidden (it stays in the page for screen readers) and the shape drawn on it", () => {
    const css = rule(".cf-flag-icon")
    expect(css).toMatch(/width:\s*14px;\s*height:\s*14px/)
    expect(css).toMatch(/border-radius:\s*50%/)
    expect(css).toMatch(/font-size:\s*0/)
    expect(css).toMatch(/position:\s*relative/)
  })

  it.each(["r", "y", "b", "g"])("the %s mark has its shape drawn (a ::before rule with its own geometry)", (variant) => {
    expect(SHADOW_CSS).toMatch(new RegExp(`\\.cf-flag-icon-${variant}::before[^{]*\\{[^}]*(?:width|border-left)`))
  })

  it("the number of a section is a 16px circle for one digit (padding of 4px or less on the sides) and a pill from two", () => {
    const css = rule(".cf-section-count")
    expect(css).toMatch(/min-width:\s*16px;\s*height:\s*16px/)
    expect(css).toMatch(/border-radius:\s*8px/)
    const padding = /padding:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/.exec(css)
    expect(padding, "the padding of the number").not.toBeNull()
    expect(Number(padding![2])).toBeLessThanOrEqual(4) // (a digit is about 5px wide: 5 + 2 x 4 = 13 < 16, so min-width makes the circle)
  })
})

describe("no text of the two panels is left without one of those rules", () => {
  const covered = new Set([...CRITICAL_FLAGS_TEXT, ...AI_SUMMARY_TEXT].map((s) => s.slice(1)))
  // The round marks (✕ ! i ✓) are shapes, not text to read.
  const isMark = (cls: string) => /^cf-flag-icon/.test(cls)

  /** The classes of every element of the panel that holds text of its own. */
  const textClasses = (panel: HTMLElement): string[] =>
    [...panel.querySelectorAll("*")]
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== ""))
      .map((el) => (el as HTMLElement).className)

  const mount = (id: string) => {
    document.body.innerHTML = ""
    const root = document.createElement("div")
    const panel = document.createElement("div")
    panel.id = id
    root.appendChild(panel)
    document.body.appendChild(root)
    state.shadow = root as unknown as ShadowRoot
    return panel
  }

  const unstyled = (classes: string[]) =>
    classes.filter((c) => !c.split(/\s+/).some((one) => covered.has(one) || isMark(one)))

  beforeEach(() => { document.body.innerHTML = "" })

  it("Critical Flags: every severity, with and without a description", () => {
    const panel = mount("ant-critical-flags")
    toggleCriticalFlags(
      [
        { label: "Mint Authority enabled", severity: "critical", impact: 40 },
        { label: "Liquidity < $50k", severity: "warning", impact: 10 },
        { label: "Top 10 hold 38%", severity: "info", impact: 0 },
        { label: "LP Burned ✓", severity: "bonus", impact: 0 },
        { label: "A flag the table has no description for", severity: "warning", impact: 5 },
      ] as never,
      "CAUTION",
    )
    const classes = textClasses(panel)
    expect(classes.length).toBeGreaterThan(8) // headers, counts, titles, labels, descriptions: the guard is not blind
    expect(unstyled(classes)).toEqual([])
  })

  it("Critical Flags: the empty state", () => {
    const panel = mount("ant-critical-flags")
    toggleCriticalFlags([], "SAFE")
    expect(textClasses(panel)).toEqual(["cf-panel-empty"])
    expect(unstyled(textClasses(panel))).toEqual([])
  })

  it("AI Summary: the first sentence and the others", () => {
    const panel = mount("ant-ai-summary")
    toggleAiSummary("First sentence. Second one. Third one.")
    expect(textClasses(panel)).toEqual(["ai-panel-verdict", "ai-panel-line", "ai-panel-line"])
    expect(unstyled(textClasses(panel))).toEqual([])
  })

  it("AI Summary: the empty state", () => {
    const panel = mount("ant-ai-summary")
    toggleAiSummary(null)
    expect(textClasses(panel)).toEqual(["ai-panel-empty"])
    expect(unstyled(textClasses(panel))).toEqual([])
  })
})
