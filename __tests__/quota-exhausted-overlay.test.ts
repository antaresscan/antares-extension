/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach } from "vitest"
import { buildQuotaExhaustedNode } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import type { QuotaStatus } from "../shared/types"

// Regression suite for the user-reported "extension stops working when
// I hit 25 scans". Plus the design cleanup (cap counter at limit, no
// redundant header badge, single-line CTA, install_id baked into href
// synchronously so the native <a> nav works without async window.open).

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

describe("buildQuotaExhaustedNode", () => {
  it("renders the cap headline", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("OUT OF SCANS")
  })

  it("shows used/limit and a reset countdown on one line", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toContain("25/25")
    expect(node.textContent).toContain("today")
    expect(node.textContent).toContain("resets in")
  })

  it("caps the displayed counter at the limit (don't show 117/25)", () => {
    // The server INCRs first then denies, so quota.used can exceed
    // the cap. Display should clamp — showing "117/25" looks broken.
    const node = buildQuotaExhaustedNode(makeQuota({ used: 117 }))
    expect(node.textContent).toContain("25/25")
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

  it("CTA text fits on one line (no wrapping arrow)", () => {
    // The previous "Get Pro — unlimited scans →" was too long for
    // 290px width minus padding; the arrow wrapped. Compact label
    // avoids that.
    const node = buildQuotaExhaustedNode(makeQuota())
    const cta = node.querySelector(".qx-cta") as HTMLAnchorElement
    expect(cta.textContent?.length ?? 0).toBeLessThanOrEqual(28)
  })

  it("explains what Pro unlocks (so the CTA isn't a leap of faith)", () => {
    const node = buildQuotaExhaustedNode(makeQuota())
    expect(node.textContent).toMatch(/AI Summary|Critical Flags|Full Analysis|Unlimited/i)
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
    // The big OUT OF SCANS message says it already; the duplicate
    // "117/25 → PRO" badge in the top corner was visual noise.
    const node = buildQuotaExhaustedNode(makeQuota())
    const badge = node.querySelector(".quota-badge")
    expect(badge).toBeNull()
  })
})
