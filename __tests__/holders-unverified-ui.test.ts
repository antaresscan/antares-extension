/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach } from "vitest"
import { buildResult } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import { toggleCriticalFlags } from "../contents/modules/critical-flags"
import {
  HOLDERS_UNVERIFIED_LABEL,
  isHoldersUnverifiedFlag,
} from "../shared/holders-unverified"
import type { ScanResponseData } from "../shared/types"

// When holder data is missing the API caps the verdict at CAUTION and the scan
// carries the layer flag below. The overlay used to hide every "X unavailable"
// flag, so a CAUTION verdict read "No issues found" with nothing to explain it
// (the contradiction the SAFE override in determineVerdict was added to paper
// over). This one flag is now shown, under a neutral label. Every other
// pipeline-status flag stays hidden.

const MINT = "So11111111111111111111111111111111111111112"
const HOLDERS_FLAG = {
  label: "Helius unavailable — holder concentration unverified",
  severity: "warning",
  impact: 0,
}

function makeScanData(over: Partial<ScanResponseData> = {}): ScanResponseData {
  return {
    score: 850,
    risk: "CAUTION",
    flags: [],
    pair: null,
    resolvedMint: MINT,
    confidence: 80,
    sources_used: ["dexscreener"],
    holders: 1000,
    marketCap: 1_000_000,
    priceUsd: 1.0,
    liquidity: 50_000,
    tokenSymbol: "TKN",
    tokenName: "Token",
    mintAuthority: false,
    freezeAuthority: false,
    lpBurned: true,
    lpLocked: false,
    honeypot: false,
    safeBlocked: true,
    ...over,
  } as ScanResponseData
}

describe("isHoldersUnverifiedFlag", () => {
  it("matches the layer flag", () => {
    expect(isHoldersUnverifiedFlag(HOLDERS_FLAG.label)).toBe(true)
  })

  it("does not match other pipeline-status flags or non-strings", () => {
    expect(isHoldersUnverifiedFlag("GoPlus unavailable")).toBe(false)
    expect(isHoldersUnverifiedFlag("Helius RPC timed out")).toBe(false)
    expect(isHoldersUnverifiedFlag("Top 10 holders > 50%")).toBe(false)
    expect(isHoldersUnverifiedFlag(undefined)).toBe(false)
    expect(isHoldersUnverifiedFlag(42)).toBe(false)
  })
})

describe("overlay summary — holders unverified", () => {
  it("counts the unverified-holders flag, so a CAUTION verdict is never 'No issues found'", () => {
    const html = buildResult(makeScanData({ flags: [HOLDERS_FLAG] as ScanResponseData["flags"] }), MINT)

    expect(html).toContain("1 flag detected")
    expect(html).not.toContain("No issues found")
  })

  it("adds it to the count of the real flags", () => {
    const flags = [
      HOLDERS_FLAG,
      { label: "Mint Authority enabled", severity: "critical", impact: 200 },
    ] as ScanResponseData["flags"]
    const html = buildResult(makeScanData({ risk: "DANGER", flags }), MINT)

    expect(html).toContain("2 flags")
    expect(html).toContain("1 critical")
  })

  it("control: other pipeline-status flags stay hidden (info severity)", () => {
    const html = buildResult(
      makeScanData({ flags: [{ label: "GoPlus unavailable", severity: "info", impact: 0 }] as ScanResponseData["flags"] }),
      MINT,
    )

    expect(html).toContain("No issues found")
  })

  it("control: other pipeline-status flags stay hidden even at warning severity", () => {
    const html = buildResult(
      makeScanData({ flags: [{ label: "Helius RPC timed out", severity: "warning", impact: 0 }] as ScanResponseData["flags"] }),
      MINT,
    )

    expect(html).toContain("No issues found")
  })
})

describe("Critical Flags panel — holders unverified", () => {
  beforeEach(() => {
    document.body.innerHTML = ""
    const root = document.createElement("div")
    const panel = document.createElement("div")
    panel.id = "ant-critical-flags"
    root.appendChild(panel)
    document.body.appendChild(root)
    state.shadow = root as unknown as ShadowRoot
  })

  it("lists the flag under a neutral label and explains the CAUTION cap", () => {
    toggleCriticalFlags([HOLDERS_FLAG] as ScanResponseData["flags"], "CAUTION")
    const panel = document.getElementById("ant-critical-flags")!

    expect(panel.querySelector(".cf-flag-label")?.textContent).toBe(HOLDERS_UNVERIFIED_LABEL)
    expect(panel.querySelector(".cf-flag-desc")?.textContent).toContain("capped at CAUTION")
    // The label names the missing check, not the data vendor.
    expect(panel.textContent).not.toContain("Helius")
    expect(panel.querySelector(".cf-section-warning")).not.toBeNull()
  })

  it("control: another pipeline-status flag, even at warning severity, still renders nothing", () => {
    toggleCriticalFlags(
      [{ label: "GoPlus unavailable", severity: "warning", impact: 0 }] as ScanResponseData["flags"],
      "CAUTION",
    )
    const panel = document.getElementById("ant-critical-flags")!

    expect(panel.querySelector(".cf-flag")).toBeNull()
    expect(panel.textContent).toContain("Nothing to display")
  })
})
