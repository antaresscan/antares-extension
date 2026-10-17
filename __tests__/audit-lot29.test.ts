/* @vitest-environment happy-dom */
// __tests__/audit-lot29.test.ts — Lot 29 of the file-by-file audit (2026-10-17): the scanner. Fails on the previous code.
//
// A scan that the user left (a navigation to another token) must never draw its answer, or report it to the badge, once a newer scan owns
// the overlay. Two awaits had no check after them: the write of the answer to the cache (it hashes the session first) and, on the cached
// path, the read of the install id.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// The next calls of getInstallId / cacheScan wait for a gate when one is queued (one gate per call), else go through at once.
const installGates: Promise<void>[] = []
const cacheGates: Promise<void>[] = []
function gate(queue: Promise<void>[]): () => void {
  let open = () => {}
  queue.push(new Promise<void>((r) => { open = r }))
  return open
}

vi.mock("../shared/install-id", () => ({
  getInstallId: async () => { await installGates.shift(); return "install-test-aaaaaaaaaaaa" },
}))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn(), buildScanResultMessage: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))
vi.mock("../contents/modules/cache", async (importOriginal) => {
  const real = await importOriginal<typeof import("../contents/modules/cache")>()
  return { ...real, cacheScan: async (...args: Parameters<typeof real.cacheScan>) => { await cacheGates.shift(); return real.cacheScan(...args) } }
})

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache } = await import("../contents/modules/state")
const { resetState } = await import("../contents/modules/components")
const { reportScanResult } = await import("../contents/modules/scan-report")

const CA = "So1anaTokenAddressForTests11111111111111111"
const CA2 = "So1anaTokenAddressForTests22222222222222222"
const data = (symbol: string, mint: string): ScanResponseData => ({
  score: 900, risk: "SAFE", flags: [], pair: null, resolvedMint: mint, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000, tokenSymbol: symbol, tokenName: symbol, lpBurned: true,
  lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false, freshForSec: 300, staleLeftSec: 1200,
}) as unknown as ScanResponseData

const fetchMock = vi.fn((url: string) => Promise.resolve({
  ok: true, status: 200, headers: new Headers(),
  json: () => Promise.resolve(url.includes(`ca=${CA2}`) ? data("BBB", CA2) : data("AAA", CA)),
}))
// The card only: the shadow root also holds the stylesheet, whose embedded fonts are base64 ("AAA" is in them).
const text = () => state.boxEl?.textContent ?? ""
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  const store = new Map<string, unknown>()
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: (keys: string | string[] | null, cb: (items: Record<string, unknown>) => void) => {
        const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]
        cb(Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))])))
      },
      set: (items: Record<string, unknown>, cb?: () => void) => { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); cb?.() },
      remove: (keys: string[], cb?: () => void) => { for (const k of [keys].flat()) store.delete(k); cb?.() },
    } },
    runtime: { lastError: undefined, sendMessage: () => Promise.resolve() },
  })
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockClear()
  vi.mocked(reportScanResult).mockClear()
  scanCache.clear()
  installGates.length = 0
  cacheGates.length = 0
  document.documentElement.querySelector("#antares-host")?.remove()
  Object.assign(state, {
    host: null, shadow: null, boxEl: null, lastCA: "", manuallyDismissed: false, currentScanController: null, failureView: null,
    recoveryTimer: null, recoveryCa: "", recoveryAttempt: 0, recoveryStartedAt: 0, staleExpiryTimer: null, rescanTimer: null,
  })
})

afterEach(() => {
  resetState()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("scanner — a scan the user left never draws over the newer one", () => {
  it("the answer of token A lands while it is being cached, the user is already on token B: B stays on screen (A was drawn over it)", async () => {
    await scan(CA2) // B was scanned earlier: in the cache
    expect(text()).toContain("BBB")
    state.lastCA = ""

    const openCache = gate(cacheGates)
    void scan(CA) // the user opens A: the answer arrives and is being cached
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    resetState() // a navigation back to B: A's scan is cancelled
    await scan(CA2) // B from the cache
    expect(text()).toContain("BBB")

    openCache()
    await settle()
    expect(state.lastCA).toBe(CA2)
    expect(text()).toContain("BBB")
    expect(text()).not.toContain("AAA")
    expect(vi.mocked(reportScanResult).mock.calls.map((c) => c[0])).not.toContain(CA)
  })

  it("cached path: token A waits for the install id, the user goes on to B: B stays on screen (A was drawn over it)", async () => {
    await scan(CA)
    state.lastCA = ""
    await scan(CA2) // both in the cache
    state.lastCA = ""
    vi.mocked(reportScanResult).mockClear()

    const openInstall = gate(installGates)
    void scan(CA) // A, from the cache: waits for the install id
    await settle()

    resetState() // the user goes on to B
    await scan(CA2)
    expect(text()).toContain("BBB")

    openInstall()
    await settle()
    expect(state.lastCA).toBe(CA2)
    expect(text()).toContain("BBB")
    expect(text()).not.toContain("AAA")
    expect(vi.mocked(reportScanResult).mock.calls.map((c) => c[0])).toEqual([CA2])
  })
})
