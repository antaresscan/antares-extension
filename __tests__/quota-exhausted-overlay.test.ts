/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach } from "vitest"
import { buildQuotaExhaustedNode } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import type { QuotaStatus } from "../shared/types"

// Regression suite + design-3 ("Premium / calm") layout coverage.
// The card replaces the silent box-hide on quota-exhaustion, and the
// shape is the user-picked Demo 3 from /quota-overlay-demos.html (#91).

beforeEach(() => {
  document.body.innerHTML = ""
  const box = document.createElement("div")
  box.className = "box"
  document.body.appendChild(box)
  state.boxEl = box
})

function makeQuota(over: Partial<QuotaStatus> = {}): QuotaStatus {
  return {
    tier: "free",
    used: 25,
    limit: 25,
    remaining: 0,
    resetAt: Date.now() + 6 * 60 * 60 * 1000, // 6h from now
    ...over,
  }
}

describe("buildQuotaExhaustedNode (Demo 3 — premium/calm)", () => {
  it("renders the 'Daily limit reached' headline (not all-caps OUT OF SCANS)", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("Daily limit reached")
    expect(node.textContent).not.toContain("OUT OF SCANS")
  })

  it("shows the live reset countdown right under the headline", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("resets in")
    // 6h ahead → "5h Xm" or "6h Xm" depending on rounding
    expect(node.textContent).toMatch(/\d+h \d+m|\d+m|midnight/)
  })

  it("counter line shows used/limit in friendly prose", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("You've used today's")
    expect(node.textContent).toContain("25 / 25")
    expect(node.textContent).toContain("scans")
  })

  it("caps the counter at the limit (don't show 117/25)", () => {
    // Server INCRs first then denies, so used can exceed limit. Display
    // must clamp — "117/25" reads like a UI bug.
    const node = buildQuotaExhaustedNode(makeQuota({ used: 117 }))
    expect(node.textContent).toContain("25 / 25")
    expect(node.textContent).not.toContain("117")
  })

  it("flips the box to caution colour scheme", () => {
    buildQuotaExhaustedNode(makeQuota())
    expect(state.boxEl?.className).toBe("box caution")
  })

  it("CTA href contains /pricing and bakes install_id when provided", () => {
    const node = buildQuotaExhaustedNode(makeQuota(), "install-test-aaaaaaaaaaaa")
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement | null
    expect(cta).not.toBeNull()
    expect(cta?.getAttribute("href")).toContain("/pricing")
    expect(cta?.getAttribute("href")).toContain("install=install-test-aaaaaaaaaaaa")
  })

  it("CTA href falls back to bare /pricing without install_id", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement
    expect(cta.getAttribute("href")).toContain("/pricing")
    expect(cta.getAttribute("href")).not.toContain("install=")
  })

  it("CTA opens in a new tab (target=_blank, rel=noopener)", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement
    expect(cta.getAttribute("target")).toBe("_blank")
    expect(cta.getAttribute("rel")).toContain("noopener")
  })

  it("CTA label is short ('Unlock unlimited')", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement
    expect(cta.textContent).toBe("Unlock unlimited")
  })

  it("price footer shows $24.99 / 30 days / USDC or SOL", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const price = node.querySelector(".qx-price")
    expect(price?.textContent).toContain("$24.99")
    expect(price?.textContent).toContain("30 days")
    expect(price?.textContent).toContain("USDC or SOL")
  })

  it("handles already-past reset gracefully", () => {
    const node = buildQuotaExhaustedNode(makeQuota({ resetAt: Date.now() - 1000 }))
    expect(node.textContent).toContain("any moment")
  })

  it("falls back to 'midnight UTC' when resetAt is missing", () => {
    const node = buildQuotaExhaustedNode(makeQuota({ resetAt: 0 }))
    expect(node.textContent).toContain("midnight UTC")
  })

  it("does NOT render the redundant quota-badge in the header", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const badge = node.querySelector(".quota-badge")
    expect(badge).toBeNull()
  })
})
