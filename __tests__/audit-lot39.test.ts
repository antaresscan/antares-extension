// __tests__/audit-lot39.test.ts — Lot 39 of the file-by-file audit (2026-10-17): the public pages. Fails on the previous code.
//
// The support page answered "The overlay disappeared" with "turn Stealth off in the extension popup". There is no popup (no popup.tsx;
// the toolbar button is the on/off switch, background.ts chrome.action.onClicked), and the Stealth setting is read by nothing (lot 33).
// A user whose overlay is off was sent looking for a menu that does not exist.

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8")

describe("support page — the overlay-disappeared answer matches the extension", () => {
  const answer = (() => {
    const html = read("support.html")
    const q = html.indexOf("The overlay disappeared")
    return html.slice(q, html.indexOf("faq-q", q + 30))
  })()

  it("no popup, no Stealth toggle: the toolbar icon switches the overlay on and off (it sent users to a popup that does not exist)", () => {
    expect(existsSync(resolve(process.cwd(), "popup.tsx"))).toBe(false)
    expect(answer).not.toMatch(/popup/i)
    expect(answer).not.toMatch(/stealth/i)
    expect(answer).toMatch(/green dot/)
    expect(answer).toMatch(/red dot/)
  })

  it("what the answer says is what background.ts does: the toolbar click toggles, the dot is green when on, red when off", () => {
    const bg = read("background.ts")
    expect(bg).toContain("chrome.action.onClicked.addListener")
    expect(bg).toMatch(/setBadgeTextColor\(\{ color: extensionEnabled \? "#00e5b0" : "#ff5f5f" \}\)/)
  })
})
