import { describe, it, expect } from "vitest"
import { SHADOW_CSS } from "../contents/modules/styles"

// The small messages the overlay adds under its card (the loading hint, "Scanned 6 min ago", "Source unavailable, rescanning in 24s") speak in the card's own voice: Bebas Neue, like
// the labels of the pills and the wordmark, not the IBM Plex Mono of the old "Still loading" hint.

const rule = (selector: string): string => {
  const start = SHADOW_CSS.indexOf(`\n${selector} {`)
  expect(start, `${selector} is styled`).toBeGreaterThan(-1)
  return SHADOW_CSS.slice(start, SHADOW_CSS.indexOf("}", start))
}

// The Limited data card (a scan made while a source did not answer: no verdict) is drawn in the design of the verdict cards. Every part of the card that
// takes a verdict's colour must have its Limited data counterpart (the four colours mixed, or a neutral grey): a part added to the verdict cards
// tomorrow without one would show the colours of whatever it inherits.
describe("the Limited data card styles every part that takes a verdict colour", () => {
  const suffixes = (verdict: string): string[] =>
    [...SHADOW_CSS.matchAll(new RegExp("^\\.box\\." + verdict + "\\s+([^{,]+?)\\s*\\{", "gm"))].map((m) => m[1].trim()).filter(Boolean); // (the background rule ".box.safe {" has no part after it)

  it("finds the parts of the verdict cards (the guard is not blind)", () => {
    expect(suffixes("safe")).toEqual(expect.arrayContaining([".topbar", ".vb h1", ".sum"]));
  });

  it("each of them has a .box.limited rule, and the four verdicts style the same parts", () => {
    const safe = suffixes("safe");
    for (const v of ["caution", "danger", "rug"]) expect(suffixes(v), v).toEqual(safe);
    // The score bar fill has no Limited data twin: the Limited data bar is four coloured segments (.sbar.lim i), tested below.
    const missing = safe.filter((part) => part !== ".sbar-fill" && !suffixes("limited").includes(part));
    expect(missing, "parts of the verdict cards with no .box.limited rule").toEqual([]);
  });

  it("the Limited data card uses the four verdict colours, not one: the word, the top bar, the dots, the bar", () => {
    const colours = ["#00e5b0", "#f5d000", "#ff5f5f", "#ff2244"];
    const rule = (selector: string): string => {
      const start = SHADOW_CSS.indexOf(selector);
      expect(start, selector + " is styled").toBeGreaterThan(-1);
      return SHADOW_CSS.slice(start, SHADOW_CSS.indexOf("}", start));
    };
    for (const selector of [".box.limited .vb h1 {", ".box.limited .topbar {"]) for (const c of colours) expect(rule(selector), selector).toContain(c);
    for (const [i, c] of colours.entries()) expect(rule(".dt.lim-" + i + " {"), "dot " + i).toContain(c);
    // A gradient, in which each of the four colours holds a plateau (the exact colour is there to see, not only passed through), in the order of the verdicts.
    for (const selector of [".box.limited .vb h1 {", ".box.limited .topbar {", ".box.limited::before {"]) {
      const css = rule(selector);
      for (const c of colours) expect(css, selector + " " + c).toMatch(new RegExp(c + " \\d+%," + c + " \\d+%"));
      const order = colours.map((c) => css.indexOf(c));
      expect([...order].sort((a, b) => a - b), selector + " order").toEqual(order);
      const gradient = css.match(/linear-gradient\([^)]*\)/)?.[0] ?? ""; // (the word itself is `color: transparent`, to show the gradient through the letters)
      expect(gradient, selector).not.toMatch(/transparent/);
    }
  });
});

describe("the overlay's small messages use the card's font", () => {
  it.each([".skel-slow-hint", ".scanned-ago", ".source-gap", ".last-full"])("%s is Bebas Neue, uppercase, centred, in the grey of the other small labels", (selector) => {
    const css = rule(selector)
    expect(css).toContain("'Bebas Neue'")
    expect(css).not.toContain("IBM Plex Mono")
    expect(css).toContain("text-align: center")
    expect(css).toContain("#777")
  })

  it("the messages have the same size and spacing, so that they read as one voice", () => {
    const size = (css: string) => css.match(/font(?:-size)?:\s*(?:400\s+)?(\d+(?:\.\d+)?)px/)?.[1]
    const spacing = (css: string) => css.match(/letter-spacing:\s*([.\d]+em)/)?.[1]
    expect(size(rule(".skel-slow-hint"))).toBe(size(rule(".scanned-ago")))
    expect(spacing(rule(".skel-slow-hint"))).toBe(spacing(rule(".scanned-ago")))
    expect(size(rule(".source-gap"))).toBe(size(rule(".scanned-ago")))
    expect(spacing(rule(".source-gap"))).toBe(spacing(rule(".scanned-ago")))
    expect(size(rule(".last-full"))).toBe(size(rule(".scanned-ago")))
    expect(spacing(rule(".last-full"))).toBe(spacing(rule(".scanned-ago")))
  })
})
