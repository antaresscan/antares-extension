/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach } from "vitest"
import { buildQuotaExhaustedNode } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import type { QuotaStatus } from "../shared/types"

// Regression suite for the user-reported "extension stops working when
// I hit 25 scans". The previous behaviour was: 429 from /api/scan
// throws → catch hides the box silently → looks broken to the user.
// New behaviour: 429-with-quota-headers builds a dedicated overlay that
// shows "OUT OF SCANS", the reset clock, and a primary upgrade CTA.

beforeEach(() => {
  document.body.innerHTML = ""
  // Stub the box element since some build paths set its className.
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

describe("buildQuotaExhaustedNode", () => {
  it("renders the cap headline and current usage", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("OUT OF SCANS")
    expect(node.textContent).toContain("25 / 25")
    expect(node.textContent).toContain("today")
  })

  it("includes a reset countdown line", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("Resets")
    // 6h ahead → "in 5h Xm" or "in 6h Xm" depending on rounding
    expect(node.textContent).toMatch(/in \d+h \d+m|in \d+m|midnight/)
  })

  it("flips the box to caution colour scheme", () => {
    buildQuotaExhaustedNode(makeQuota())
    expect(state.boxEl?.className).toBe("box caution")
  })

  it("renders a primary upgrade CTA pointing at /pricing", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement | null
    expect(cta).not.toBeNull()
    expect(cta?.getAttribute("href")).toContain("/pricing")
    expect(cta?.textContent).toContain("Get Pro")
  })

  it("CTA opens in a new tab (target=_blank, rel=noopener)", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement
    expect(cta.getAttribute("target")).toBe("_blank")
    expect(cta.getAttribute("rel")).toContain("noopener")
  })

  it("explains what Pro unlocks (so the CTA isn't a leap of faith)", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toMatch(/AI Summary|Critical Flags|Full Analysis|unlimited scans/i)
  })

  it("handles already-past reset gracefully", () => {
    // resetAt in the past — could happen if a tab was open across
    // midnight UTC and we render after the cron should have cleared.
    const node = buildQuotaExhaustedNode(makeQuota({ resetAt: Date.now() - 1000 }))
    expect(node.textContent).toContain("any moment")
  })

  it("falls back to 'midnight UTC' when resetAt is missing", () => {
    const node = buildQuotaExhaustedNode(makeQuota({ resetAt: 0 }))
    expect(node.textContent).toContain("midnight UTC")
  })

  it("shows the quota badge in the header (used/limit visible up top too)", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    // The header's quota-badge component renders the limit-reached
    // variant (clickable PRO link) when remaining=0.
    const badge = node.querySelector(".quota-badge")
    expect(badge).not.toBeNull()
  })
})
