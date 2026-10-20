/* @vitest-environment happy-dom */
// The token page in the card's own voice. The flags, the AI verdict and the Insider Watch tab (wallet addresses and figures included) were set in IBM Plex Mono, with synthesized
// bold and italic; the overlay card and its panels are Bebas Neue, which has one weight and no italic. The round marks of the flags were a 16px circle with a font character
// on it, placed on the pixel grid on its own: they are now one drawing each (js/round-marks.js), twin of the extension's contents/modules/round-marks.ts.
//
// The marketing demo (antaresscan.com/demo -> "Full Analysis" -> token.html?...&demo=1) is drawn by this same page: its DATA is locked (DEMO_DATA, see token-demo-untouched.test.ts),
// its look is the page's. It had kept the old look (every new rule was for `html:not(.is-demo)`); on the owner's word it has the new one too.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markSvg } from "../js/round-marks.js";

const html = readFileSync(resolve(process.cwd(), "token.html"), "utf8").replace(/\r\n/g, "\n");
const BLOCK_START = html.indexOf("THE TOKEN PAGE IN THE CARD'S OWN VOICE");
const block = html.slice(BLOCK_START, html.indexOf("</style>", BLOCK_START));
/** The rules of the block, without the comments (the header comment says what the fonts were). */
const code = block.slice(block.indexOf("*/") + 2).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule `selector{...}` inside the new block (a rule starts its line). */
const rule = (selector: string): string => {
  const needle = `\n${selector}{`;
  const at = block.indexOf(needle);
  expect(at, `${selector} has a rule for the real page`).toBeGreaterThan(-1);
  return block.slice(at + needle.length, block.indexOf("}", at));
};

const TEXT = [
  ".flags-head .lbl", ".flags-head .count", ".flag-label", ".flag-desc", ".ai-head h3", ".ai-body", ".ai-loading",
  ".iw-tile", ".iw-row", ".iw-flow", ".iw-holder-row",
];
const WEIGHT_ONLY = [".iw-feed-title", ".iw-name", ".iw-action", ".iw-tile.dev::after", ".iw-row-rank", ".iw-row-action", ".iw-row-usd", ".iw-holder-rank", ".iw-holder-wallet", ".iw-holder-pct", ".iw-holder-state", ".iw-flow-label", ".iw-flow-val", ".iw-flow-state", ".ai-body b"];

describe("the flags, the AI verdict and the Insider Watch tab are set in Bebas Neue", () => {
  it("finds the block (the guard is not blind)", () => {
    expect(BLOCK_START).toBeGreaterThan(-1)
    expect(block.length).toBeGreaterThan(2000)
  })

  it.each(TEXT)("%s: Bebas Neue, no italic, no bold", (selector) => {
    const css = rule(selector)
    expect(css).toMatch(/font-family:'Bebas Neue',sans-serif/)
    expect(css).not.toContain("IBM Plex Mono")
    expect(css).not.toMatch(/font-style:italic/)
    expect(css).not.toMatch(/font-weight:(?:[5-9]00|bold)/)
  })

  it.each(WEIGHT_ONLY)("%s: weight 400 (Bebas Neue has no bold: the browser would fake it)", (selector) => {
    const css = rule(selector)
    expect(css).not.toMatch(/font-weight:(?:[5-9]00|bold)/)
    expect(css).not.toContain("IBM Plex Mono")
  })

  it("the wallet addresses and every figure of the feed are covered: the row, its parts and the net flow", () => {
    for (const part of [".iw-row", ".iw-row-rank", ".iw-row-wallet", ".iw-row-action", ".iw-row-usd", ".iw-row-age", ".iw-holder-row", ".iw-flow", ".iw-flow-label", ".iw-flow-val", ".iw-flow-state"]) {
      expect(code, part).toMatch(new RegExp("(?:^|[\\n ,])" + part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[{,]"))
    }
  })

  it("no rule of the block is IBM Plex Mono", () => {
    expect(code).not.toContain("IBM Plex Mono")
  })
})

describe("the marketing demo has the same look as the page", () => {
  it("no rule of the block is scoped to a kind of page: they apply to the demo as they do to a real token", () => {
    expect(code).not.toContain("is-demo")
    expect(code).not.toContain(":not(")
    const selectors = [...code.matchAll(/(?:^|[}\n{])\s*([^{}\n@][^{}]*?)\{/g)].map((m) => m[1].trim()).filter(Boolean)
    expect(selectors.length).toBeGreaterThan(30)
  })

  it("the old rules are the base (layout, colours) under the block, and the block comes last, so that it wins at equal weight", () => {
    expect(html.indexOf(".flag-label{font-size:12px")).toBeGreaterThan(-1)
    expect(html.indexOf(".flag-label{font-size:12px")).toBeLessThan(BLOCK_START)
    expect(html.indexOf("</style>", BLOCK_START)).toBeGreaterThan(BLOCK_START)
    expect(html.indexOf("<style", BLOCK_START)).toBe(-1) // (the block is the end of the last style element)
  })
})

describe("the round marks of the flags are one 16 x 16 drawing", () => {
  const draw = (key: string): Element => {
    const holder = document.createElement("div")
    holder.innerHTML = markSvg(key)
    return holder.firstElementChild as Element
  }
  const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

  it.each(["r", "y", "g"])("%s: a circle of radius 8 at the centre of a 16 x 16 box, aria-hidden", (key) => {
    const svg = draw(key)
    expect(svg.tagName.toLowerCase()).toBe("svg")
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16")
    expect(svg.getAttribute("width")).toBe("16")
    expect(svg.getAttribute("height")).toBe("16")
    expect(svg.getAttribute("aria-hidden")).toBe("true")
    const bg = svg.querySelector("circle.mark-bg")!
    expect([bg.getAttribute("cx"), bg.getAttribute("cy"), bg.getAttribute("r")]).toEqual(["8", "8", "8"])
  })

  it.each(["r", "y", "g"])("the symbol of %s is centred on the circle", (key) => {
    const svg = draw(key)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const grow = (x: number, y: number, r: number) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r) }
    for (const dot of svg.querySelectorAll("circle.mark-dot")) grow(Number(dot.getAttribute("cx")), Number(dot.getAttribute("cy")), Number(dot.getAttribute("r")))
    for (const path of svg.querySelectorAll("path.mark-ink")) {
      const n = numbers(path.getAttribute("d") ?? "")
      for (let i = 0; i + 1 < n.length; i += 2) grow(n[i], n[i + 1], 0.75) // (the stroke is 1.5 wide, round ends)
    }
    expect((x0 + x1) / 2).toBeCloseTo(8, 1)
    expect((y0 + y1) / 2).toBeCloseTo(8, 1)
  })

  it("anything else draws nothing, and nothing from outside can get into the markup", () => {
    for (const key of ["", "x", "__proto__", "constructor", "<img src=x onerror=alert(1)>"]) expect(markSvg(key), key).toBe("")
  })

  it("the CSS draws them: the circle fills, the strokes, and the character hidden for screen readers", () => {
    expect(rule(".flag-icon")).toMatch(/width:16px;height:16px/)
    expect(rule(".flag-icon")).toMatch(/font-size:0/)
    for (const key of ["r", "y", "g"]) expect(rule(`.flag-icon.${key} .mark-bg`)).toMatch(/fill:rgba\(/)
    expect(rule(".mark-ink")).toMatch(/stroke:currentColor/)
    expect(rule(".mark-dot")).toMatch(/fill:currentColor/)
  })
})

// The page itself: the demo and a real token both draw the mark.
const DEMO_DANGER = "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump";
const REAL_CA = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
const body = (() => {
  const inner = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"))
  return inner.replace(/^<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/g, "")
})();
function openPage(query: string) {
  document.documentElement.className = ""
  document.body.className = ""
  document.body.innerHTML = body
  ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(`https://antares-extension.vercel.app/token.html?${query}`)
}
const settle = () => new Promise((r) => setTimeout(r, 200))

describe("the page draws the marks, in the marketing demo as on a real token", () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals() })

  it("the marketing demo: every flag has its mark drawn (and no call to the API)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the demo must never call the API") }))
    openPage(`ca=${DEMO_DANGER}&demo=1`)
    await import("../js/token-app.js")
    await settle()
    const icons = [...document.querySelectorAll(".flag-icon")]
    expect(document.documentElement.classList.contains("is-demo")).toBe(true)
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon.querySelector("svg circle.mark-bg"), "the demo draws the mark").not.toBeNull()
      expect(["✕", "!", "✓"]).toContain((icon.textContent ?? "").trim()) // (the character stays, hidden by the CSS, for screen readers)
    }
  })

  it("a real token: every flag has its mark drawn, and keeps its character for screen readers", async () => {
    const scan = {
      risk: "CAUTION", score: 720, tokenSymbol: "CARDS", tokenName: "CARDS", resolvedMint: REAL_CA, confidence: 90, sources_used: ["helius"], holders: 100, marketCap: 1_000_000, priceUsd: 0.01,
      liquidity: 500_000, lpBurned: true, lpLocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false, safeBlocked: false, fetchedAt: Date.now(), freshForSec: 300, staleLeftSec: 1200,
      flags: [{ label: "Mint Authority enabled", severity: "critical", impact: 40 }, { label: "Metadata mutable", severity: "warning", impact: 5 }], aiSummary: "A summary.",
    }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => scan })))
    openPage(`ca=${REAL_CA}`)
    await import("../js/token-app.js")
    await settle()
    const icons = [...document.querySelectorAll(".flag-icon")]
    expect(document.documentElement.classList.contains("is-demo")).toBe(false)
    expect(icons.map((i) => (i.textContent ?? "").trim())).toEqual(["✕", "!"])
    for (const icon of icons) expect(icon.querySelector("svg circle.mark-bg"), "the real page draws the mark").not.toBeNull()
  })
})
