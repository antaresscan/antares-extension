/* @vitest-environment happy-dom */
import { describe, it, expect, beforeEach } from "vitest"
import { SHADOW_CSS, injectFonts } from "../contents/modules/styles"
import { state } from "../contents/modules/state"
import { toggleAiSummary } from "../contents/modules/ai-summary"
import { toggleCriticalFlags } from "../contents/modules/critical-flags"
import { DIGITS, DIGIT_HEIGHT, drawCount, drawMark, type MarkKey } from "../contents/modules/round-marks"

// The two panels under the card (Critical Flags, AI Summary) read in the card's own voice: Bebas Neue for the titles (the section headers and the name of each flag), like the verdict,
// the pills and the buttons that open them. They were set in IBM Plex Mono (bold labels, italic descriptions), which is the one place of the card that looked like another product.
// Bebas Neue has capitals only, a single weight and no italic: asking for 600/700 or `italic` would make the browser fake them, which smears the letters, and a sentence in it has no
// lower-case letters. The SENTENCES (what a flag means, the AI summary, the empty states) are set in Oswald, its closest cousin that has them (the owner's choice, 2026-10-21): the
// weights 300 and 400 are the two that are bundled, anything else would be faked as well.

const rule = (selector: string): string => {
  const start = SHADOW_CSS.indexOf(`\n${selector} {`)
  expect(start, `${selector} is styled`).toBeGreaterThan(-1)
  return SHADOW_CSS.slice(start, SHADOW_CSS.indexOf("}", start))
}

const TITLES = [".cf-section-header", ".cf-section-count", ".cf-section-title", ".cf-flag-label"]
const SENTENCES = [".cf-flag-desc", ".cf-panel-empty", ".ai-panel-verdict", ".ai-panel-line", ".ai-panel-loading", ".ai-panel-empty"]
const CRITICAL_FLAGS_TEXT = [".cf-section-header", ".cf-section-count", ".cf-section-title", ".cf-flag-label", ".cf-flag-desc", ".cf-panel-empty"]
const AI_SUMMARY_TEXT = [".ai-panel-verdict", ".ai-panel-line", ".ai-panel-loading", ".ai-panel-empty"]
// A rule that sets no font of its own inherits the one of the rule it sits in: the count and the title live in the section header.
const INHERITS_FONT = new Set([".cf-section-count", ".cf-section-title"])

describe("the Critical Flags and AI Summary panels: titles in Bebas Neue, sentences in Oswald", () => {
  it.each(TITLES)("title %s: Bebas Neue, weight 400, no italic", (selector) => {
    const css = rule(selector)
    if (!INHERITS_FONT.has(selector)) expect(css).toMatch(/font-family:\s*'Bebas Neue'/)
    expect(css).not.toContain("IBM Plex Mono")
    expect(css).not.toContain("Oswald")
    expect(css).not.toMatch(/font-style:\s*italic/)
    expect(css).not.toMatch(/font-weight:\s*(?:[5-9]\d\d|bold)/)
  })

  it.each(SENTENCES)("sentence %s: Oswald, weight 300 or 400, no italic, lower case kept", (selector) => {
    const css = rule(selector)
    expect(css).toMatch(/font-family:\s*'Oswald',\s*'Arial Narrow',\s*sans-serif/)
    expect(css).not.toContain("Bebas Neue")
    expect(css).not.toContain("IBM Plex Mono")
    expect(css).not.toMatch(/font-style:\s*italic/)
    expect(css).not.toMatch(/text-transform/) // an uppercase rule would give back the capitals the sentences are in Oswald to avoid
    const weight = css.match(/font-weight:\s*(\d+)/)?.[1]
    expect(["300", "400"], `${selector} has a weight that is bundled`).toContain(weight)
  })

  it("the description of a flag and the lines of the summary are the light weight (300), the first sentence of the summary is 400", () => {
    expect(rule(".cf-flag-desc")).toMatch(/font-weight:\s*300/)
    expect(rule(".ai-panel-line")).toMatch(/font-weight:\s*300/)
    expect(rule(".ai-panel-verdict")).toMatch(/font-weight:\s*400/)
  })

  it("Oswald 300 and 400 are bundled as woff2 data in the shadow CSS and in the page (a shadow root does not register its own @font-face), next to Bebas Neue", () => {
    document.getElementById("antares-fonts")?.remove()
    injectFonts()
    const page = document.getElementById("antares-fonts")?.textContent ?? ""
    for (const [where, css] of [["shadow CSS", SHADOW_CSS], ["page", page]] as const) {
      const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1])
      const oswald = faces.filter((f) => /font-family:\s*'Oswald'/.test(f))
      expect(oswald.map((f) => f.match(/font-weight:\s*(\d+)/)?.[1]).sort(), `${where}: the Oswald weights`).toEqual(["300", "400"])
      for (const f of oswald) {
        expect(f, where).toMatch(/src:\s*url\(data:font\/woff2;base64,d09GMg/) // "wOF2": a real woff2 file, not a link (an extension page may not load a remote font)
        expect(f, where).toMatch(/font-style:\s*normal/)
      }
      expect(faces.some((f) => /font-family:\s*'Bebas Neue'/.test(f)), `${where}: Bebas Neue`).toBe(true)
    }
  })

  it("the section count and title inherit Bebas Neue from the header they sit in", () => {
    expect(rule(".cf-section-header")).toMatch(/font-family:\s*'Bebas Neue'/)
    for (const part of INHERITS_FONT) expect(rule(part), part).not.toMatch(/font-family/)
  })
})

// The round marks of the flags (cross, !, i, tick) and the number of each section are small drawings (contents/modules/round-marks.ts): a 16px circle with the symbol drawn in it
// from the same origin. They were a CSS circle of 14px with a font character or two pseudo-elements on it, and on a screen scaled to 125 % or 150 % a 14px circle is 17.5 or 21 device
// pixels that the browser rounds to a different size from one row to the next, and the symbol and the circle were snapped on their own (a cross was 21 x 22, a symbol off centre by up to
// 0.75 device pixel). The real browser measures them at every screen scaling (npm run overlay:check, "panels"); these tests keep the drawing itself right: the size, the symmetry of every
// symbol around the middle of the circle, the digits.
const SVG = "http://www.w3.org/2000/svg"
const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
/** The ink of everything drawn on top of the circle: the box that holds every stroke (with its half width) and every dot. */
function inkBox(svg: Element): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  const grow = (x: number, y: number, r: number) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r) }
  for (const dot of svg.querySelectorAll("circle.cf-mark-dot")) grow(Number(dot.getAttribute("cx")), Number(dot.getAttribute("cy")), Number(dot.getAttribute("r")))
  for (const path of svg.querySelectorAll("path.cf-mark-ink")) {
    const n = numbers(path.getAttribute("d") ?? "")
    for (let i = 0; i + 1 < n.length; i += 2) grow(n[i], n[i + 1], 0.75) // (the stroke is 1.5 wide, with round ends: half of it on each side of the line)
  }
  return { x0, x1, y0, y1 }
}

describe("the round marks of the Critical Flags panel are small drawings on exact circles", () => {
  const draw = (key: MarkKey): SVGElement => {
    const host = document.createElement("div")
    drawMark(host, key)
    return host.querySelector("svg") as unknown as SVGElement
  }

  it("the mark is a 16px box (a whole number of device pixels at 100, 125, 150, 175 and 200 %) with its character hidden: it stays in the page for screen readers", () => {
    const css = rule(".cf-flag-icon")
    expect(css).toMatch(/width:\s*16px;\s*height:\s*16px/)
    expect(css).toMatch(/font-size:\s*0/)
    // no circle drawn by the box itself: the circle is in the drawing, so that it and the symbol cannot be snapped to the pixel grid separately
    expect(css).not.toMatch(/border-radius/)
    expect(SHADOW_CSS).not.toMatch(/\.cf-flag-icon-[rybg]::(?:before|after)/)
  })

  it.each(["r", "y", "b", "g"] as const)("the %s mark is a 16 x 16 drawing, a circle of radius 8 at the centre and the symbol on it", (key) => {
    const svg = draw(key)
    expect(svg.namespaceURI).toBe(SVG)
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16")
    expect(svg.getAttribute("width")).toBe("16")
    expect(svg.getAttribute("height")).toBe("16")
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    const bg = svg.querySelector("circle.cf-mark-bg")!
    expect([bg.getAttribute("cx"), bg.getAttribute("cy"), bg.getAttribute("r")]).toEqual(["8", "8", "8"])
    expect(svg.querySelectorAll("path.cf-mark-ink, circle.cf-mark-dot").length).toBeGreaterThan(0)
  })

  it.each(["r", "y", "b", "g"] as const)("the symbol of the %s mark is centred on the circle: as much room on the left as on the right, as above as below", (key) => {
    const { x0, x1, y0, y1 } = inkBox(draw(key))
    expect((x0 + x1) / 2).toBeCloseTo(8, 1) // within 0.05 of a pixel
    expect((y0 + y1) / 2).toBeCloseTo(8, 1)
    expect(x0, "the symbol stays inside the circle").toBeGreaterThan(2)
    expect(x1).toBeLessThan(14)
    expect(y0).toBeGreaterThan(2)
    expect(y1).toBeLessThan(14)
  })

  it("the colours: the circle fill of each severity, the symbol in the colour of the mark", () => {
    for (const [key, fill] of [["r", "rgba(255,60,80,.15)"], ["y", "rgba(245,208,0,.12)"], ["b", "rgba(80,150,250,.12)"], ["g", "rgba(0,229,176,.12)"]] as const) {
      expect(rule(`.cf-flag-icon-${key} .cf-mark-bg`)).toContain(fill)
    }
    expect(rule(".cf-mark-ink")).toMatch(/stroke:\s*currentColor/)
    expect(rule(".cf-mark-dot")).toMatch(/fill:\s*currentColor/)
  })

  it("a flag draws its mark in the panel, and keeps the character in the element", () => {
    document.body.innerHTML = ""
    const root = document.createElement("div")
    const panel = document.createElement("div")
    panel.id = "ant-critical-flags"
    root.appendChild(panel)
    document.body.appendChild(root)
    state.shadow = root as unknown as ShadowRoot
    toggleCriticalFlags([
      { label: "Mint Authority enabled", severity: "critical", impact: 40 },
      { label: "Liquidity < $50k", severity: "warning", impact: 10 },
      { label: "Top 10 hold 38%", severity: "info", impact: 0 },
      { label: "LP Burned ✓", severity: "bonus", impact: 0 },
    ] as never, "CAUTION")
    const icons = [...panel.querySelectorAll(".cf-flag-icon")]
    expect(icons.map((i) => i.textContent)).toEqual(["✕", "!", "i", "✓"])
    for (const icon of icons) expect(icon.querySelector("svg circle.cf-mark-bg")).not.toBeNull()
  })
})

describe("the number of a section is a drawing: a circle for one digit, a pill from two", () => {
  const count = (n: number): HTMLElement => {
    const host = document.createElement("span")
    drawCount(host, n)
    return host
  }

  it.each([[1, 16], [7, 16], [9, 16], [10, 24], [12, 24], [99, 24], [100, 32]])("%i is drawn on a %ipx wide, 16px high shape", (n, width) => {
    const svg = count(n).querySelector("svg")!
    expect(svg.getAttribute("width")).toBe(String(width))
    expect(svg.getAttribute("height")).toBe("16")
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${width} 16`)
    const bg = svg.querySelector("rect.cf-count-bg")!
    expect([bg.getAttribute("width"), bg.getAttribute("height"), bg.getAttribute("rx")]).toEqual([String(width), "16", "8"]) // (a one-digit number: rx is half the width, so a circle)
  })

  it("the number stays in the element as text (hidden by the CSS) for screen readers, and every digit is drawn", () => {
    const host = count(12)
    expect(host.firstChild?.nodeType).toBe(3)
    expect(host.textContent).toBe("12")
    expect(host.querySelectorAll("path.cf-count-num")).toHaveLength(2)
    expect(rule(".cf-section-count")).toMatch(/font-size:\s*0/)
    expect(rule(".cf-section-count")).toMatch(/height:\s*16px/)
  })

  it("the ink of the digits is centred in the shape: the left edge of the first and the right edge of the last are the same distance from the sides", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 25, 100]) {
      const svg = count(n).querySelector("svg")!
      const width = Number(svg.getAttribute("width"))
      const digits = String(n)
      const placed = [...svg.querySelectorAll("path.cf-count-num")].map((p, i) => {
        const [, tx, ty] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(p.getAttribute("transform") ?? "") ?? []
        return { tx: Number(tx), ty: Number(ty), glyph: DIGITS[digits[i]] }
      })
      const left = placed[0].tx + placed[0].glyph[1]
      const right = placed[placed.length - 1].tx + placed[placed.length - 1].glyph[2]
      expect(left, `${n}: room on the left`).toBeCloseTo(width - right, 1)
      // and vertically: the flat top of the digits (8.4 high) sits as far from the top of the shape as the baseline is from the bottom
      expect(placed[0].ty - DIGIT_HEIGHT, `${n}: room above`).toBeCloseTo(16 - placed[0].ty, 1)
    }
  })

  it("the table of digits is what its paths draw: the declared edges of the ink are the edges of the outline, and the digits are as high as they say", () => {
    for (const ch of "0123456789") {
      const [advance, inkLeft, inkRight, d] = DIGITS[ch]
      expect(advance, ch).toBe(4.8) // (Bebas Neue digits are all the same width: the number is laid out by this advance)
      // every command of the outlines is absolute and uses M L H V Q Z: read the x of each point and the y of each point
      let x = 0, y = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      const seen = (px: number, py: number) => { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py) }
      for (const [, cmd, args] of d.matchAll(/([MLHVQZ])([^MLHVQZ]*)/g)) {
        const n = numbers(args)
        if (cmd === "H") x = n[0]
        else if (cmd === "V") y = n[0]
        else if (cmd === "M" || cmd === "L") [x, y] = n
        else if (cmd === "Q") { seen(n[0], n[1]); [x, y] = [n[2], n[3]] }
        if (cmd !== "Z") seen(x, y)
      }
      expect(minX, `${ch}: left edge`).toBeCloseTo(inkLeft, 1)
      expect(maxX, `${ch}: right edge`).toBeCloseTo(inkRight, 1)
      expect(-minY, `${ch}: top`).toBeGreaterThanOrEqual(DIGIT_HEIGHT - 0.05) // the flat digits are 8.4 high, the round ones overshoot by 0.12
      expect(-minY, `${ch}: top`).toBeLessThanOrEqual(DIGIT_HEIGHT + 0.2)
    }
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
