/* @vitest-environment happy-dom */

import { describe, it, expect } from "vitest"
import { buildResult } from "../contents/modules/components"
import type { ScanResponseData } from "../shared/types"

// The overlay's Sell / Mint / Freeze pills. The API now sends true (present / blocked), false (verified absent) or null
// (NOT verified). Mint and Freeze already rendered null as a dash; Sell rendered it as a green tick, which is how an
// unmeasured token got a "Sell check" it never earned.

const MINT = "So11111111111111111111111111111111111111112"

function makeScanData(over: Partial<ScanResponseData> = {}): ScanResponseData {
  return {
    score: 900, risk: "SAFE", flags: [], pair: null, resolvedMint: MINT, confidence: 90,
    sources_used: ["dexscreener", "helius"], holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000,
    tokenSymbol: "TKN", tokenName: "Token", lpBurned: true, lpLocked: false, safeBlocked: false,
    mintAuthority: false, freezeAuthority: false, honeypot: false,
    ...over,
  } as ScanResponseData
}

/** "ok" / "no" for a tick / cross, "-" for the dash, per pill label. */
function pills(over: Partial<ScanResponseData>): Record<string, string> {
  const root = document.createElement("div")
  root.innerHTML = buildResult(makeScanData(over), MINT)
  const out: Record<string, string> = {}
  root.querySelectorAll(".si").forEach((si) => {
    const label = si.querySelector("span")?.textContent ?? ""
    const b = si.querySelector("b")
    out[label] = b?.classList.contains("ok") ? "ok" : b?.classList.contains("no") ? "no" : (b?.textContent ?? "").trim() === "—" ? "-" : "?"
  })
  return out
}

describe("Sell / Mint / Freeze pills", () => {
  it("verified clean: three ticks", () => {
    expect(pills({ honeypot: false, mintAuthority: false, freezeAuthority: false })).toMatchObject({ Sell: "ok", Mint: "ok", Freeze: "ok" })
  })

  it("verified present / blocked: three crosses", () => {
    expect(pills({ honeypot: true, mintAuthority: true, freezeAuthority: true })).toMatchObject({ Sell: "no", Mint: "no", Freeze: "no" })
  })

  it("NOT verified (null): three dashes, never a tick", () => {
    expect(pills({ honeypot: null, mintAuthority: null, freezeAuthority: null })).toMatchObject({ Sell: "-", Mint: "-", Freeze: "-" })
  })

  it("RENDER-like: mint and freeze active, the sale not guaranteed", () => {
    expect(pills({ honeypot: null, mintAuthority: true, freezeAuthority: true })).toMatchObject({ Sell: "-", Mint: "no", Freeze: "no" })
  })

  it("a response that predates the tri-state (field absent) is also shown as not verified", () => {
    expect(pills({ honeypot: undefined })).toMatchObject({ Sell: "-" })
  })
})
