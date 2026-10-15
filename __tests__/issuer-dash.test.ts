/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// An issuer's asset (a stablecoin, a tokenized stock, a liquid staking token...) holds its mint and freeze authorities by design, and its liquidity pool is not what backs it.
// Next to a SAFE verdict, red crosses under Mint, Freeze and LP Lock read as a contradiction (2026-10-14: the Apple xStock, SAFE, with three crosses). For such a token those
// three cells are the same little dash as Sell, Free and Pro alike. The server says which tokens (`issuerKind`, from its registry by mint address); every other token is unchanged.

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache, resetSourceGap } = await import("../contents/modules/state")

const CA = "So1anaTokenAddressForTests11111111111111111"
const T = 1_800_000_000_000
const KINDS = ["stable", "tokenized", "lst", "wrapped", "yield", "vault"] as const

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 1000, risk: "SAFE", flags: [], pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 36_900, marketCap: 13_300_000, priceUsd: 343.86, liquidity: 267_900, tokenSymbol: "AAPLX", tokenName: "Apple xStock", safeBlocked: false,
  // what the engine sees on an xStock: the issuer holds both authorities, the pool is not burned or locked, nothing known on Sell (Solana)
  mintAuthority: true, freezeAuthority: true, lpBurned: false, lpLocked: false, honeypot: null,
  freshForSec: 300, staleLeftSec: 1200, fetchedAt: Date.now(), aiSummary: "A summary.", ...over,
}) as unknown as ScanResponseData

let store: Map<string, unknown>
const fetchMock = vi.fn()
const sendMessage = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => { cb?.({ ok: true }); return Promise.resolve() })

function installChrome() {
  store = new Map()
  const local = {
    get: (keys: string | string[] | null, cb: (items: Record<string, unknown>) => void) => {
      const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k))
      cb(out)
    },
    set: (items: Record<string, unknown>, cb: () => void) => { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); cb() },
    remove: (keys: string[], cb: () => void) => { for (const k of keys) store.delete(k); cb() },
  }
  vi.stubGlobal("chrome", { storage: { local }, runtime: { lastError: undefined, sendMessage } })
}

const quotaHeaders = (tier: string) => new Headers({
  "X-Antares-Quota-Tier": tier, "X-Antares-Quota-Used": "3", "X-Antares-Quota-Limit": "-1", "X-Antares-Quota-Remaining": "-1", "X-Antares-Quota-Reset": "0",
})
const answer = (body: unknown, tier: string) => Promise.resolve({ ok: true, status: 200, headers: quotaHeaders(tier), json: () => Promise.resolve(body) })

/** The five cells of the footer line, by their label: the mark in each (class of the <b>, its text, its inline style). */
function cells() {
  const out: Record<string, { text: string; cls: string; style: string }> = {}
  for (const si of state.shadow?.querySelectorAll(".ss .si") ?? []) {
    const label = (si.querySelector("span")?.textContent ?? "").trim()
    const b = si.querySelector("b")
    out[label.replace(/^LP (Locked|Burned).*/, "LP Lock")] = { text: b?.textContent ?? "", cls: b?.getAttribute("class") ?? "", style: b?.getAttribute("style") ?? "" }
  }
  return out
}
const isDash = (c: { text: string; cls: string }) => c.text === "—" && c.cls === "dash"

beforeEach(() => {
  vi.useFakeTimers({ now: T })
  installChrome()
  sendMessage.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  scanCache.clear()
  document.documentElement.querySelector("#antares-host")?.remove()
  resetSourceGap()
  Object.assign(state, {
    host: null, shadow: null, boxEl: null, lastCA: "", manuallyDismissed: false, currentScanController: null, failureView: null,
    recoveryTimer: null, recoveryCa: "", recoveryAttempt: 0, recoveryStartedAt: 0, staleExpiryTimer: null, rescanTimer: null,
  })
})
afterEach(() => {
  resetSourceGap()
  if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("an issuer's asset: Mint, Freeze and LP Lock are a dash, like Sell", () => {
  for (const tier of ["pro", "free"] as const) {
    for (const kind of KINDS) {
      it(`${tier} | ${kind}: three dashes, the same dash as Sell, and the liquidity keeps its figure`, async () => {
        fetchMock.mockImplementation(() => answer(data({ issuerKind: kind, ...(tier === "free" ? { proLocked: true } : {}) }), tier))
        await scan(CA)
        const c = cells()
        expect(Object.keys(c).sort()).toEqual(["Freeze", "LP Lock", "Liq", "Mint", "Sell"])
        for (const label of ["Sell", "Mint", "Freeze", "LP Lock"]) expect(isDash(c[label]), label).toBe(true)
        // the SAME dash: same text, same style, under every label
        for (const label of ["Mint", "Freeze", "LP Lock"]) expect(c[label].style, label).toBe(c.Sell.style)
        // the liquidity is public market data: its figure stays
        expect(c.Liq.text).toMatch(/267/)
      })
    }
  }

  it("the verdict is untouched: still SAFE, still the same score", async () => {
    fetchMock.mockImplementation(() => answer(data({ issuerKind: "tokenized" }), "pro"))
    await scan(CA)
    expect(state.boxEl?.classList.contains("safe")).toBe(true)
  })
})

describe("every other token is unchanged: the crosses and ticks still say what the engine found", () => {
  for (const issuerKind of [null, undefined, ""] as const) {
    it(`issuerKind ${JSON.stringify(issuerKind)}: authorities still enabled are crosses, a burned pool is a tick`, async () => {
      fetchMock.mockImplementation(() => answer(data({ issuerKind, risk: "CAUTION", lpBurned: true }), "pro"))
      await scan(CA)
      const c = cells()
      expect(c.Mint.cls).toBe("no")
      expect(c.Freeze.cls).toBe("no")
      expect(c["LP Lock"].cls).toBe("ok")
      expect(isDash(c.Sell)).toBe(true) // Sell is a dash on Solana, as it always was
    })
  }

  it("a token whose authorities are renounced keeps its ticks", async () => {
    fetchMock.mockImplementation(() => answer(data({ mintAuthority: false, freezeAuthority: false, lpBurned: true, risk: "SAFE" }), "pro"))
    await scan(CA)
    const c = cells()
    expect(c.Mint.cls).toBe("ok")
    expect(c.Freeze.cls).toBe("ok")
    expect(c["LP Lock"].cls).toBe("ok")
  })

  it("an unknown LP (nothing said either way) is the same dash as Sell, not a lighter one", async () => {
    fetchMock.mockImplementation(() => answer(data({ lpBurned: null, lpLocked: null, mintAuthority: false, freezeAuthority: false }), "pro"))
    await scan(CA)
    const c = cells()
    expect(isDash(c["LP Lock"])).toBe(true)
    expect(c["LP Lock"].style).toBe(c.Sell.style)
  })
})

describe("the Limited data card is unchanged: all four checks are dashes", () => {
  it("a token that is not an issuer's asset, Limited data: dashes, and the liquidity figure", async () => {
    fetchMock.mockImplementation(() => answer(data({ degraded: true, sourceGap: true, freshForSec: 30, staleLeftSec: 0, risk: "CAUTION" }), "pro"))
    await scan(CA)
    const c = cells()
    for (const label of ["Sell", "Mint", "Freeze", "LP Lock"]) expect(isDash(c[label]), label).toBe(true)
    expect(c.Liq.text).toMatch(/267/)
  })
})
