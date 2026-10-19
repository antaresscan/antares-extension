import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// The row of the overlay card (Sell / Mint / Freeze / LP lock / Liq) is aligned by fractions of a pixel, drawn with three different techniques (a rotated border, two crossed
// bars, a font), and every other test of it reads CSS text. scripts/overlay-alignment.mjs renders the REAL overlay in Chromium and measures the ink of every mark. This file
// keeps that guard from being switched off, narrowed or loosened without anyone noticing: it checks that CI runs it, that it covers what the owner sees (every verdict, plan,
// liquidity colour and state), and that its tolerance is the one that catches the bug (2 px) it was written for.

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8")
const script = read("scripts/overlay-alignment.mjs")
const ci = read(".github/workflows/ci.yml")

describe("the overlay alignment guard stays on", () => {
  it("is an npm script", () => {
    expect((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["overlay:check"]).toBe("node scripts/overlay-alignment.mjs")
  })

  it("runs in the `build` job of CI (the required one), after the extension is built, with a Chromium installed", () => {
    const build = ci.slice(ci.indexOf("\n  build:"), ci.indexOf("\n  replay:"))
    expect(build.length).toBeGreaterThan(500)
    expect(build).toMatch(/run:\s*npm run overlay:check/)
    expect(build).toMatch(/npx playwright install --with-deps chromium/)
    expect(build.indexOf("npm run overlay:check")).toBeGreaterThan(build.indexOf("npx plasmo build"))
    expect(build.indexOf("npx playwright install")).toBeLessThan(build.indexOf("npm run overlay:check"))
  })

  it("renders the REAL overlay (scanner + state), not a copy of its markup", () => {
    expect(script).toContain('./contents/modules/scanner')
    expect(script).toContain('./contents/modules/state')
    expect(script).toContain("chromium")
  })

  it("covers every verdict, both plans, every colour of the figure and every state of the checks", () => {
    for (const v of ['"SAFE"', '"CAUTION"', '"DANGER"', '"RUG"']) expect(script, v).toContain(v)
    for (const t of ['"free"', '"pro"']) expect(script, t).toContain(t)
    // liquidity: none (dash), under $1K, red (< $5K), white ($5K-$50K), green (> $50K), millions, billions
    const liquidities = /const LIQUIDITIES = \[([^\]]+)\]/.exec(script)?.[1] ?? ""
    expect(liquidities).toContain("null")
    const values = liquidities.split(",").map((x) => x.trim().replace(/_/g, ""))
    expect(values.some((x) => x !== "null" && Number(x) < 1000)).toBe(true)
    expect(values.some((x) => Number(x) >= 1000 && Number(x) < 5000)).toBe(true)
    expect(values.some((x) => Number(x) >= 5000 && Number(x) <= 50000)).toBe(true)
    expect(values.some((x) => Number(x) > 50000 && Number(x) < 1_000_000)).toBe(true)
    expect(values.some((x) => Number(x) >= 1_000_000)).toBe(true)
    for (const state of ['"all clear"', '"LP open"', '"LP locked"', '"mint active"', '"freeze + honeypot"', '"unknown checks"', '"issuer asset"', '"limited data"']) expect(script, state).toContain(state)
  })

  it("measures at the usual screen scalings, at 8x, and next to a hostile host page", () => {
    const dsfs = /\[1, 1\.25, 1\.5, 1\.75, 2, 2\.25, 2\.5, 2\.625, 3, 8\]/
    expect(script).toMatch(dsfs)
    expect(script).toContain("hostile host page")
  })

  it("asserts the font (Bebas Neue, loaded, 11px figure) and the class of the figure, not only the position", () => {
    expect(script).toMatch(/Bebas Neue/)
    expect(script).toContain('status === "loaded"')
    expect(script).toContain('figure.size !== "11px"')
    expect(script).toContain("colourClass")
  })

  it("keeps the tolerance that catches the bug: 0.75px where the measure is clean, 1.1px on fractional scalings (the bug was 2px)", () => {
    expect(script).toMatch(/OVERLAY_TOL \?\? 0\.75/)
    expect(script).toMatch(/OVERLAY_TOL_FRACTIONAL \?\? 1\.1/)
  })
})
