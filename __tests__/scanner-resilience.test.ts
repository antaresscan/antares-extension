/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// The overlay when the scanner is slow or cannot be reached (contents/modules/scanner.ts + resilience.ts + cache.ts), end to end with a
// simulated clock: how long a scan waits, what is on screen when it fails (the last known verdict, marked as old, when the server allowed it;
// else the error screen), that it tries again by itself, and that it stops when it should.

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

// The overlay appends a Google Fonts <link> to its shadow root: the test DOM must not go and fetch it on the real network.
;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan, fetchWithRetry } = await import("../contents/modules/scanner")
const { state, scanCache } = await import("../contents/modules/state")

const CA = "So1anaTokenAddressForTests11111111111111111"
const CA2 = "So1anaTokenAddressForTests22222222222222222"
const MIN = 60_000

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 900, risk: "SAFE", flags: [], pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000, tokenSymbol: "TKN", tokenName: "Token", lpBurned: true,
  lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false,
  freshForSec: 300, staleLeftSec: 1200, ...over,
}) as unknown as ScanResponseData

// ─── stubs: chrome.storage.local, chrome.runtime, fetch ────────────────────────────────────────────────────────────────────────────────
let store: Map<string, unknown>
const fetchMock = vi.fn()

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
  vi.stubGlobal("chrome", { storage: { local }, runtime: { lastError: undefined, sendMessage: () => Promise.resolve() } })
}

const answer = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) })
const httpError = (status: number) => Promise.resolve({ ok: false, status, headers: new Headers(), json: () => Promise.resolve(null) })
/** A request that never answers, but ends (like a real one) when it is aborted. */
const hangs = (_url: string, init?: { signal?: AbortSignal }) => new Promise<never>((_res, rej) => {
  init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true })
})

const text = () => state.shadow?.textContent ?? ""
const q = (sel: string) => state.shadow?.querySelector(sel) ?? null
const callsFor = (ca: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(`ca=${ca}`)).length
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  installChrome()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  scanCache.clear()
  document.documentElement.querySelector("#antares-host")?.remove()
  Object.assign(state, {
    host: null, shadow: null, boxEl: null, lastCA: "", manuallyDismissed: false, currentScanController: null, failureView: null,
    recoveryTimer: null, recoveryCa: "", recoveryAttempt: 0, recoveryStartedAt: 0, staleExpiryTimer: null, rescanTimer: null,
  })
})

afterEach(() => {
  if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
  if (state.staleExpiryTimer) clearTimeout(state.staleExpiryTimer)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A first scan that succeeds (so the verdict is in the cache), then the clock moves on and the page asks again. */
async function seedThenAskAgain(seed: ScanResponseData, afterMs: number) {
  fetchMock.mockImplementation(() => answer(seed))
  await scan(CA)
  expect(q(".stale-banner")).toBeNull()
  expect(text()).toContain("TKN")
  await advance(afterMs)
  state.lastCA = "" // the page asks again (a navigation back to this token)
}

describe("a scan waits 15 s at most", () => {
  it("a scanner that never answers: the loading screen ends at 15 s with the error screen — it used to be able to last almost two minutes", async () => {
    fetchMock.mockImplementation(hangs)
    void scan(CA)
    await advance(14_800)
    expect(text()).not.toContain("Connection failed")
    await advance(400)
    expect(text()).toContain("Connection failed")
    expect(q(".err-retry")).not.toBeNull()
    expect(state.failureView).toBe("error")
    expect(callsFor(CA)).toBe(1) // one long attempt, not four
  })

  it("a scanner that answers 500 each time: it tries again 3 times (10.5 s of waiting) and then shows the error", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(10_600)
    expect(callsFor(CA)).toBe(4)
    expect(text()).toContain("Connection failed")
  })

  it("a scanner that answers in 12 s is waited for (a slow scan is not a failure)", async () => {
    fetchMock.mockImplementation(() => new Promise((res) => setTimeout(() => res(answer(data())), 12_000)))
    void scan(CA)
    await advance(12_100)
    expect(text()).toContain("TKN")
    expect(text()).not.toContain("Connection failed")
    expect(state.failureView).toBeNull()
  })

  it("a scan the user moved away from is cancelled, not reported as a failure", async () => {
    fetchMock.mockImplementation((url: string, init?: { signal?: AbortSignal }) => (String(url).includes(`ca=${CA2}`) ? answer(data({ resolvedMint: CA2 })) : hangs(url, init)))
    void scan(CA)
    await advance(1000)
    void scan(CA2) // another token: the first scan is aborted
    await advance(20_000)
    expect(text()).not.toContain("Connection failed")
    expect(state.failureView).toBeNull()
    expect(text()).toContain("TKN")
  })

  it("the waits between two attempts end when the scan is aborted (fetchWithRetry)", async () => {
    fetchMock.mockImplementation(() => httpError(503))
    const ctl = new AbortController()
    let outcome = "pending"
    void fetchWithRetry("https://x/api/scan?ca=1", ctl.signal).then(() => { outcome = "ok" }, (e: Error) => { outcome = e.name })
    await advance(100) // the first attempt failed: the overlay is now in its 1.5 s wait
    expect(outcome).toBe("pending")
    ctl.abort()
    await advance(0)
    expect(outcome).toBe("AbortError") // at once, not after the 1.5 s
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("when the scanner cannot be reached: the last known verdict, marked as old, if the server allowed it", () => {
  it("shows it with its age and the fact that the overlay is retrying — not the error screen", async () => {
    await seedThenAskAgain(data(), 6 * MIN)
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")))
    void scan(CA)
    await advance(11_000)
    expect(q(".stale-banner")?.textContent).toBe("Last check 6 min ago — scanner unreachable, retrying")
    expect(text()).toContain("TKN")
    expect(q(".err-retry")).toBeNull()
    expect(state.failureView).toBe("stale")
  })

  it("not when the server did not allow it for that verdict (a SAFE of a young token: staleLeftSec 0): the error screen", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 0 }), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".stale-banner")).toBeNull()
    expect(text()).toContain("Connection failed")
    expect(state.failureView).toBe("error")
  })

  it("if the old verdict cannot be drawn (damaged in the extension storage), the overlay still answers: the error screen, and it keeps trying", async () => {
    const { cacheScan } = await import("../contents/modules/cache")
    await cacheScan(CA, data({ flags: "damaged" }), null)
    await advance(6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".stale-banner")).toBeNull()
    expect(text()).toContain("Connection failed")
    expect(state.failureView).toBe("error")
    expect(state.recoveryTimer).not.toBeNull()
  })

  it("not from a server that says nothing (an older one): 5 minutes, then the error screen, exactly as before", async () => {
    const old = data() as unknown as Record<string, unknown>
    delete old.freshForSec
    delete old.staleLeftSec
    await seedThenAskAgain(old as unknown as ScanResponseData, 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".stale-banner")).toBeNull()
    expect(text()).toContain("Connection failed")
  })

  it("a verdict beyond its window is not shown: the error screen", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 400 }), 7 * MIN) // 420 s since the verdict, window 400 s
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".stale-banner")).toBeNull()
    expect(text()).toContain("Connection failed")
  })

  it("the old verdict goes the moment its window is over: an error screen, not a stale SAFE kept on screen", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 600 }), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(state.failureView).toBe("stale") // 6 min 11 s: still inside the 10 min
    await advance(3 * MIN)
    expect(state.failureView).toBe("stale") // 9 min 11 s
    await advance(2 * MIN)
    expect(q(".stale-banner")).toBeNull() // past 10 min
    expect(text()).toContain("Connection failed")
    expect(state.failureView).toBe("error")
  })

  it("even when no attempt runs (the tab is hidden), the old verdict leaves at the end of its window", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 600 }), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(state.failureView).toBe("stale")
    Object.defineProperty(document, "hidden", { value: true, configurable: true })
    try {
      const before = callsFor(CA)
      await advance(5 * MIN) // 11 min since the verdict, window 10 min
      expect(callsFor(CA)).toBe(before) // nothing asked while the tab is hidden
      expect(q(".stale-banner")).toBeNull()
      expect(text()).toContain("Connection failed")
      expect(state.failureView).toBe("error")
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden
    }
  })

  it("the age in the line is refreshed at each failed attempt, without rebuilding the card (a panel the user has open stays open)", async () => {
    await seedThenAskAgain(data(), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    const card = q(".vb")
    expect(q(".stale-banner")?.textContent).toContain("6 min ago")
    await advance(2 * MIN)
    expect(q(".stale-banner")?.textContent).toMatch(/8 min ago/)
    expect(q(".vb")).toBe(card) // the same node
  })
})

describe("the overlay tries again by itself", () => {
  it("the error screen: when the scanner is back, the verdict replaces it with no click", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(state.failureView).toBe("error")
    fetchMock.mockImplementation(() => answer(data()))
    await advance(3_100) // the first background attempt is 3 s after the failure
    expect(text()).not.toContain("Connection failed")
    expect(text()).toContain("TKN")
    expect(state.failureView).toBeNull()
    expect(state.recoveryTimer).toBeNull()
  })

  it("a stale verdict: replaced by the fresh one, the banner gone, and no more attempts", async () => {
    await seedThenAskAgain(data(), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".stale-banner")).not.toBeNull()
    fetchMock.mockImplementation(() => answer(data({ risk: "DANGER", score: 300 })))
    await advance(30_000)
    expect(q(".stale-banner")).toBeNull()
    expect(state.boxEl?.className).toContain("danger")
    expect(state.failureView).toBeNull()
    const calls = fetchMock.mock.calls.length
    await advance(5 * MIN)
    expect(fetchMock.mock.calls.length).toBe(calls) // nothing more
    expect(state.recoveryTimer).toBeNull()
  })

  it("the attempts follow the calendar: 3 s, then 8 s, then 15 s after each failure", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(10_600)
    expect(callsFor(CA)).toBe(4) // the first scan
    await advance(3_000) // 3 s after the failure: a background attempt (4 more calls: its own retries)
    await advance(500)
    expect(callsFor(CA)).toBeGreaterThan(4)
  })

  it("it keeps the Retry button on the error screen: a click starts again from the top", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    fetchMock.mockImplementation(() => answer(data()))
    ;(q(".err-retry") as HTMLButtonElement).click()
    await advance(1000)
    expect(text()).toContain("TKN")
    expect(state.failureView).toBeNull()
  })

  it("moving to another token ends the recovery of the previous one", async () => {
    fetchMock.mockImplementation((url: string) => (String(url).includes(`ca=${CA2}`) ? answer(data({ resolvedMint: CA2 })) : httpError(500)))
    void scan(CA)
    await advance(11_000)
    expect(state.recoveryCa).toBe(CA)
    void scan(CA2)
    await advance(1000)
    expect(state.recoveryTimer).toBeNull()
    const before = callsFor(CA)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(before) // the first token is not asked again
  })

  it("a new scan of the same token (not a background attempt) starts the calendar again at 3 s", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(4 * MIN) // several background attempts later: the calendar is at one attempt a minute
    expect(state.recoveryAttempt).toBeGreaterThan(3)
    state.lastCA = "" // the page asks again
    void scan(CA)
    await advance(11_000) // it fails again
    expect(state.recoveryAttempt).toBe(1)
  })

  it("closing the box stops it", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    state.manuallyDismissed = true
    const before = callsFor(CA)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(before)
    expect(state.recoveryTimer).toBeNull()
  })

  it("it gives up after an hour (the error screen and its Retry button stay)", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(61 * MIN)
    const before = callsFor(CA)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(before)
    expect(text()).toContain("Connection failed")
    expect(q(".err-retry")).not.toBeNull()
  })
})

describe("a fresh answer from the scanner is still what it was", () => {
  it("a normal scan shows the verdict, no banner, no failure", async () => {
    fetchMock.mockImplementation(() => answer(data()))
    await scan(CA)
    expect(text()).toContain("TKN")
    expect(q(".stale-banner")).toBeNull()
    expect(state.failureView).toBeNull()
    expect(state.recoveryTimer).toBeNull()
  })

  it("a degraded answer (30 s) is not served from memory 40 s later: the page is asked again", async () => {
    fetchMock.mockImplementation(() => answer(data({ freshForSec: 30, staleLeftSec: 0, degraded: true })))
    await scan(CA)
    expect(callsFor(CA)).toBe(1)
    await advance(40_000)
    state.lastCA = ""
    await scan(CA)
    expect(callsFor(CA)).toBe(2)
  })

  it("a normal answer is still served from memory for 5 minutes (no new request)", async () => {
    fetchMock.mockImplementation(() => answer(data()))
    await scan(CA)
    await advance(4 * MIN)
    state.lastCA = ""
    await scan(CA)
    expect(callsFor(CA)).toBe(1)
  })
})
