/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach } from "vitest"
import { buildResult } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import { toggleAiSummary } from "../contents/modules/ai-summary"
import { toggleCriticalFlags } from "../contents/modules/critical-flags"
import type { ScanResponseData } from "../shared/types"

// XSS regression suite. Every test here corresponds to a real surface
// the audit flagged or to a code path we just rewrote, so a failure means
// XSS is genuinely reachable in the extension overlay — not just a stylistic
// regression. Use happy-dom so we exercise the actual DOM APIs the
// extension uses at runtime.

function makeScanData(over: Partial<ScanResponseData> = {}): ScanResponseData {
  return {
    score: 500,
    risk: "CAUTION",
    flags: [],
    pair: null,
    resolvedMint: "So11111111111111111111111111111111111111112",
    confidence: 80,
    sources_used: ["dexscreener"],
    holders: 1000,
    marketCap: 1_000_000,
    priceUsd: 1.0,
    liquidity: 50_000,
    tokenSymbol: "SAFE",
    tokenName: "Safe Token",
    mintAuthority: false,
    freezeAuthority: false,
    lpBurned: true,
    lpLocked: false,
    honeypot: false,
    safeBlocked: false,
    ...over,
  } as ScanResponseData
}

describe("buildResult — XSS regression", () => {
  it("escapes a malicious risk label and never emits a raw <script>", () => {
    // The label was rendered as `<h1>${label}</h1>` without escaping until
    // PR #11. If data.risk falls outside RISK_CLASS the raw value reaches
    // the DOM string. Reaching that branch with HTML used to fire script.
    const data = makeScanData({ risk: "<script>alert(1)</script>" as ScanResponseData["risk"] })

    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).not.toContain("<script>alert(1)")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("escapes HTML in tokenName and tokenSymbol", () => {
    const data = makeScanData({
      tokenName: "<img src=x onerror=alert(1)>",
      tokenSymbol: "<b>BAD</b>",
    })

    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    // The raw HTML tag form must not survive — it would parse as a live
    // element. escapeHtml only neutralises the angle brackets and quotes,
    // not the `onerror=` substring (which is harmless once the surrounding
    // < > are escaped — the browser will never see it as an attribute).
    expect(html).not.toContain("<img src=x")
    expect(html).not.toContain("<b>BAD</b>")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("&lt;b&gt;BAD&lt;/b&gt;")
  })

  it("never renders data.pair.url in the overlay (cannot become an XSS sink)", () => {
    // The DexScreener external link was removed from the overlay; pair.url
    // is no longer read by buildResultNode. This test guards against a
    // future regression that re-adds the link without the scheme check.
    const data = makeScanData({
      pair: { url: "javascript:alert(1)" } as ScanResponseData["pair"],
    })

    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).not.toContain("javascript:alert")
    expect(html).not.toContain('href="javascript')
    // The remaining footer buttons must still be present.
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-ai-summary-btn"')
  })
})

describe("buildResult — Free-tier gating", () => {
  // The Pro v1 monetisation lever: AI Summary, Critical Flags, and Full
  // Analysis are paid features. Free users see the verdict + score + .ss
  // stats grid (the core rug-detection signal — free forever) but the
  // deep-dive panels live behind /pricing.

  it("Free users see the upgrade CTA, not the 3 deep-dive buttons", () => {
    const data = makeScanData({
      _quota: { tier: "free", used: 3, limit: 25, remaining: 22, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('class="fo-upgrade"')
    expect(html).toContain("Unlock Pro features")
    expect(html).not.toContain('id="ant-critical-flags-btn"')
    expect(html).not.toContain('id="ant-full-analysis"')
    expect(html).not.toContain('id="ant-ai-summary-btn"')
  })

  it("Free users get no cf-panel / ai-panel containers", () => {
    // Empty containers without their toggle buttons would just be dead
    // DOM. Skip them so the overlay shadow tree stays minimal for free
    // users.
    const data = makeScanData({
      _quota: { tier: "free", used: 0, limit: 25, remaining: 25, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).not.toContain('id="ant-critical-flags"')
    expect(html).not.toContain('id="ant-ai-summary"')
  })

  it("Free upgrade CTA points at the pricing page", () => {
    const data = makeScanData({
      _quota: { tier: "free", used: 25, limit: 25, remaining: 0, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    // Static href is the pricing URL so the link works without JS
    // (right-click "Open in new tab", crawlers, etc.). Click handler
    // augments with install_id at runtime, but the base contract is
    // a working link.
    expect(html).toContain("antares-website.vercel.app/pricing")
  })

  it("Pro users keep the 3-button footer", () => {
    const data = makeScanData({
      _quota: { tier: "pro", used: 100, limit: -1, remaining: -1, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
    expect(html).not.toContain('class="fo-upgrade"')
  })

  it("Lifetime users keep the 3-button footer", () => {
    const data = makeScanData({
      _quota: { tier: "lifetime", used: 9999, limit: -1, remaining: -1, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
    expect(html).not.toContain('class="fo-upgrade"')
  })

  it("Missing _quota (pre-quota cached responses) defaults to unlocked", () => {
    // Old localStorage-cached responses from before the quota feature
    // shipped don't carry _quota. Treating them as free would punish
    // existing Pro users whose response just happens to be missing the
    // headers (anonymous traffic, upstream CORS quirks, etc.).
    const data = makeScanData() // no _quota
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
    expect(html).not.toContain('class="fo-upgrade"')
  })
})

describe("toggleAiSummary — DOM-API rewrite", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    // Stub the shadow root the extension normally builds. The function
    // looks up #ant-ai-summary inside state.shadow, so we wire that up
    // pointing to a regular DOM subtree.
    const root = document.createElement("div")
    const panel = document.createElement("div")
    panel.id = "ant-ai-summary"
    root.appendChild(panel)
    document.body.appendChild(root)
    state.shadow = root as unknown as ShadowRoot
  })

  it("renders sentences as text nodes — never as live HTML", () => {
    const malicious = "First sentence. <img src=x onerror=alert(1)>. Third one."

    toggleAiSummary(malicious)

    const panel = document.getElementById("ant-ai-summary")!
    // The malicious payload must appear as text, not as a live <img>
    // element — querying by tag must return nothing.
    expect(panel.querySelectorAll("img")).toHaveLength(0)
    expect(panel.querySelectorAll("script")).toHaveLength(0)
    // But the text content of one of the sentence divs must contain the
    // raw payload as plain text — proving it was rendered, just inertly.
    const inner = panel.querySelector(".ai-panel-inner")!
    expect(inner.textContent).toContain("<img src=x onerror=alert(1)>")
  })

  it("renders the empty-state message inertly when summary is null", () => {
    toggleAiSummary(null)

    const panel = document.getElementById("ant-ai-summary")!
    const empty = panel.querySelector(".ai-panel-empty")
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toBe("No AI summary available for this token.")
    expect(panel.innerHTML).not.toContain("<script>")
  })

  it("does not re-render on subsequent open/close cycles", () => {
    toggleAiSummary("Initial sentence.")
    const panel = document.getElementById("ant-ai-summary")!
    const firstChild = panel.firstChild

    // Toggle off, then back on
    toggleAiSummary("Initial sentence.")
    toggleAiSummary("This payload would be ignored.")

    expect(panel.firstChild).toBe(firstChild)
    expect(panel.textContent).toContain("Initial sentence.")
    expect(panel.textContent).not.toContain("This payload")
  })
})

describe("toggleCriticalFlags — DOM-API rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    const root = document.createElement("div")
    const panel = document.createElement("div")
    panel.id = "ant-critical-flags"
    root.appendChild(panel)
    document.body.appendChild(root)
    state.shadow = root as unknown as ShadowRoot
  })

  it("renders flag labels as text — never as live HTML", () => {
    const flags = [
      { label: "<img src=x onerror=alert(1)>", severity: "critical", impact: 200 },
    ]
    toggleCriticalFlags(flags)
    const panel = document.getElementById("ant-critical-flags")!
    expect(panel.querySelectorAll("img")).toHaveLength(0)
    expect(panel.querySelectorAll("script")).toHaveLength(0)
    // Payload must appear as text inside the label cell — proving it was
    // rendered, just inertly.
    const label = panel.querySelector(".cf-flag-label")!
    expect(label.textContent).toBe("<img src=x onerror=alert(1)>")
  })

  it("renders the empty-state message when flags array is empty", () => {
    toggleCriticalFlags([])
    const panel = document.getElementById("ant-critical-flags")!
    const empty = panel.querySelector(".cf-panel-empty")
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toBe("No issues found.")
  })

  it("renders the empty-state message when flags is null", () => {
    toggleCriticalFlags(null)
    const panel = document.getElementById("ant-critical-flags")!
    expect(panel.querySelector(".cf-panel-empty")).not.toBeNull()
  })

  it("excludes bonus flags from the panel", () => {
    const flags = [
      { label: "LP Burned", severity: "bonus", impact: 50 },
      { label: "Honeypot detected — cannot sell", severity: "critical", impact: 200 },
    ]
    toggleCriticalFlags(flags)
    const panel = document.getElementById("ant-critical-flags")!
    expect(panel.querySelectorAll(".cf-flag")).toHaveLength(1)
    expect(panel.textContent).toContain("Honeypot")
    expect(panel.textContent).not.toContain("LP Burned")
  })

  it("sorts critical flags before warning flags", () => {
    const flags = [
      { label: "Low holders", severity: "warning", impact: 80 },
      { label: "Honeypot detected — cannot sell", severity: "critical", impact: 200 },
    ]
    toggleCriticalFlags(flags)
    const panel = document.getElementById("ant-critical-flags")!
    const labels = Array.from(panel.querySelectorAll(".cf-flag-label"))
    expect(labels[0]?.textContent).toContain("Honeypot")
    expect(labels[1]?.textContent).toContain("Low holders")
  })

  it("renders descriptions for known flag labels", () => {
    const flags = [
      { label: "Honeypot detected — cannot sell", severity: "critical", impact: 200 },
    ]
    toggleCriticalFlags(flags)
    const panel = document.getElementById("ant-critical-flags")!
    const desc = panel.querySelector(".cf-flag-desc")
    expect(desc).not.toBeNull()
    expect(desc!.textContent).toContain("cannot sell")
  })

  it("does not re-render on subsequent open/close cycles", () => {
    toggleCriticalFlags([{ label: "Initial flag", severity: "critical", impact: 100 }])
    const panel = document.getElementById("ant-critical-flags")!
    const firstChild = panel.firstChild

    // Close, then re-open with a different payload
    toggleCriticalFlags([{ label: "Initial flag", severity: "critical", impact: 100 }])
    toggleCriticalFlags([{ label: "Different payload", severity: "critical", impact: 100 }])

    expect(panel.firstChild).toBe(firstChild)
    expect(panel.textContent).toContain("Initial flag")
    expect(panel.textContent).not.toContain("Different payload")
  })
})
