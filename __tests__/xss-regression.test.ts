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
  // Analysis are paid features but stay visible to Free users so they
  // can see what they're missing. The buttons carry a "PRO" lock-pill,
  // are dimmed, and clicking any of them opens /pricing instead of the
  // feature.

  it("Free users see all 3 deep-dive buttons (visible, not hidden)", () => {
    const data = makeScanData({
      _quota: { tier: "free", used: 3, limit: 50, remaining: 47, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
  })

  it("Free users see the buttons in a locked state with a PRO pill", () => {
    const data = makeScanData({
      _quota: { tier: "free", used: 3, limit: 50, remaining: 47, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    // Each of the 3 buttons gets the .locked class
    expect(html).toContain('class="cf-btn locked"')
    expect(html).toContain('class="ai-btn ai-btn--active locked"')
    // Full Analysis is an <a>, takes class="locked" (attribute order
    // depends on insertion order in el(), so just check both attrs are
    // present on any <a> tag in the DOM tree).
    const anchor = new DOMParser().parseFromString(html, "text/html")
      .querySelector("a#ant-full-analysis")
    expect(anchor?.getAttribute("class")).toBe("locked")
    // 3 lock-pills, one per button
    const pillMatches = html.match(/class="lock-pill">PRO/g) ?? []
    expect(pillMatches.length).toBe(3)
  })

  it("Free Full Analysis link points at the pricing page (so no-JS still works)", () => {
    const data = makeScanData({
      _quota: { tier: "free", used: 50, limit: 50, remaining: 0, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    // Static href is the pricing URL so the link works without JS
    // (right-click "Open in new tab", crawlers, etc.). Click handler
    // augments with install_id at runtime, but the base contract is
    // a working link.
    expect(html).toContain("antaresscan.com/pricing")
  })

  it("Pro users get unlocked footer (no .locked, no PRO pill)", () => {
    const data = makeScanData({
      _quota: { tier: "pro", used: 100, limit: -1, remaining: -1, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
    expect(html).not.toContain("locked")
    expect(html).not.toContain("lock-pill")
  })

  it("Lifetime users get unlocked footer (no .locked, no PRO pill)", () => {
    const data = makeScanData({
      _quota: { tier: "lifetime", used: 9999, limit: -1, remaining: -1, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
    expect(html).not.toContain("locked")
    expect(html).not.toContain("lock-pill")
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
    expect(html).not.toContain("locked")
  })

  it("locked cf-btn and ai-btn render as <a> with bare /pricing href (no install_id in URL)", () => {
    // The previous implementation rendered them as <button> with an
    // async click handler doing e.preventDefault() + getInstallId()
    // + window.open(). The async gap consumed the user-gesture grace
    // and the popup got blocked — clicks did nothing. Native <a> nav
    // has no such gap. install_id is transferred to the pricing page
    // by the bridge content script via postMessage, not via the URL.
    const data = makeScanData({
      _quota: { tier: "free", used: 3, limit: 50, remaining: 47, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112", "install-test-aaaaaaaaaaaa")
    const doc = new DOMParser().parseFromString(html, "text/html")

    const cf = doc.querySelector("#ant-critical-flags-btn") as HTMLAnchorElement
    expect(cf.tagName).toBe("A")
    expect(cf.getAttribute("href")).toContain("/pricing")
    expect(cf.getAttribute("href")).not.toContain("install=")
    expect(cf.getAttribute("target")).toBe("_blank")

    const ai = doc.querySelector("#ant-ai-summary-btn") as HTMLAnchorElement
    expect(ai.tagName).toBe("A")
    expect(ai.getAttribute("href")).toContain("/pricing")
    expect(ai.getAttribute("href")).not.toContain("install=")

    const fa = doc.querySelector("#ant-full-analysis") as HTMLAnchorElement
    expect(fa.getAttribute("href")).toContain("/pricing")
    expect(fa.getAttribute("href")).not.toContain("install=")
  })

  it("locked buttons fall back to bare /pricing when install_id is absent", () => {
    const data = makeScanData({
      _quota: { tier: "free", used: 3, limit: 50, remaining: 47, resetAt: 0 },
    })
    // No installId arg — buildResult / buildResultNode default to undefined
    const html = buildResult(data, "So11111111111111111111111111111111111111112")
    const doc = new DOMParser().parseFromString(html, "text/html")
    const cf = doc.querySelector("#ant-critical-flags-btn") as HTMLAnchorElement
    expect(cf.getAttribute("href")).toContain("/pricing")
    expect(cf.getAttribute("href")).not.toContain("install=")
  })

  it("at-cap quota badge in header renders as bare /pricing <a> (no install_id in URL)", () => {
    // Same async-popup-block bug, same fix. The "0/50 → PRO" badge
    // is a fallback handle for users who miss the OUT OF SCANS card
    // (e.g. it scrolled off-screen) — it must navigate on a single
    // click without async indirection. install_id flows via the
    // bridge content script, not via the URL.
    const data = makeScanData({
      _quota: { tier: "free", used: 50, limit: 50, remaining: 0, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112", "install-test-bbbbbbbbbbbb")
    const doc = new DOMParser().parseFromString(html, "text/html")
    const badge = doc.querySelector(".quota-badge.danger") as HTMLAnchorElement
    expect(badge).not.toBeNull()
    expect(badge.tagName).toBe("A")
    expect(badge.getAttribute("href")).toContain("/pricing")
    expect(badge.getAttribute("href")).not.toContain("install=")
  })

  it("Pro/Lifetime users still get <button> for cf/ai (toggles panel, doesn't navigate)", () => {
    const data = makeScanData({
      _quota: { tier: "pro", used: 100, limit: -1, remaining: -1, resetAt: 0 },
    })
    const html = buildResult(data, "So11111111111111111111111111111111111111112")
    const doc = new DOMParser().parseFromString(html, "text/html")
    expect(doc.querySelector("#ant-critical-flags-btn")?.tagName).toBe("BUTTON")
    expect(doc.querySelector("#ant-ai-summary-btn")?.tagName).toBe("BUTTON")
  })

  it("cf-panel and ai-panel containers exist for both tiers", () => {
    // The buttons are visible to Free (just locked), so the panel
    // containers need to be addressable too. The toggle handlers
    // never fire for Free (the click short-circuits to /pricing
    // before they can run).
    const free = makeScanData({
      _quota: { tier: "free", used: 1, limit: 50, remaining: 49, resetAt: 0 },
    })
    const pro = makeScanData({
      _quota: { tier: "pro", used: 1, limit: -1, remaining: -1, resetAt: 0 },
    })
    const freeHtml = buildResult(free, "So11111111111111111111111111111111111111112")
    const proHtml = buildResult(pro, "So11111111111111111111111111111111111111112")

    expect(freeHtml).toContain('id="ant-critical-flags"')
    expect(freeHtml).toContain('id="ant-ai-summary"')
    expect(proHtml).toContain('id="ant-critical-flags"')
    expect(proHtml).toContain('id="ant-ai-summary"')
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
    // Wording changed in PR #525 — panel now surfaces ALL severities,
    // so the empty state only triggers when there are LITERALLY zero
    // flags (unusual; layers normally emit at least one bonus/info).
    expect(empty!.textContent).toBe("All signals reviewed. Nothing to display.")
  })

  it("renders the empty-state message when flags is null", () => {
    toggleCriticalFlags(null)
    const panel = document.getElementById("ant-critical-flags")!
    expect(panel.querySelector(".cf-panel-empty")).not.toBeNull()
  })

  it("INCLUDES bonus + info flags in the panel (post PR #525 credibility fix)", () => {
    // Founder feedback: hiding bonus + info created the "no issues found
    // / CAUTION" UX contradiction. Panel now surfaces every signal so
    // the user can read the full reasoning behind any verdict.
    const flags = [
      { label: "LP Burned ✓", severity: "bonus", impact: 50 },
      { label: "LP holds 1.3% of supply — limited rug impact", severity: "info", impact: 10 },
      { label: "Honeypot detected — cannot sell", severity: "critical", impact: 200 },
    ]
    toggleCriticalFlags(flags)
    const panel = document.getElementById("ant-critical-flags")!
    expect(panel.querySelectorAll(".cf-flag")).toHaveLength(3)
    expect(panel.textContent).toContain("Honeypot")
    expect(panel.textContent).toContain("LP Burned")
    expect(panel.textContent).toContain("1.3% of supply")
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
