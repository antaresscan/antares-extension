/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach } from "vitest"
import { buildResult } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import { toggleAiSummary } from "../contents/modules/ai-summary"
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

  it("suppresses the DexScreener link when data.pair.url has a non-http scheme", () => {
    const data = makeScanData({
      pair: { url: "javascript:alert(1)" } as ScanResponseData["pair"],
    })

    const html = buildResult(data, "So11111111111111111111111111111111111111112")

    // Defensive: when the upstream-provided URL fails the http(s) regex
    // gate the link is dropped entirely (no canonical fallback). The
    // important invariant for security is that no anchor with the
    // hostile scheme ever reaches the DOM.
    expect(html).not.toContain("javascript:alert")
    expect(html).not.toContain('href="javascript')
    // The Full Analysis link (which uses a # href) must still be present
    // so the panel remains functional.
    expect(html).toContain('id="ant-full-analysis"')
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
