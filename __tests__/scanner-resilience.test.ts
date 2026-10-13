/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// The overlay when the scanner is slow or cannot be reached (contents/modules/scanner.ts + resilience.ts + cache.ts), end to end with a
// simulated clock: how long a scan waits, what is on screen when it fails (the last known verdict, with when it was scanned, when the server
// allowed it; else the loading screen, which stays: there is never an error screen), that it tries again by itself, and that it stops when it should.

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
const HOUR_MS = 60 * MIN

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
/** There is never an error screen: neither its words nor its button, wherever the overlay is. */
const noErrorScreen = () => {
  expect(text()).not.toContain("Connection failed")
  expect(text()).not.toContain("Retry")
  expect(q(".err-vb")).toBeNull()
  expect(q(".err-retry")).toBeNull()
}
/** The loading screen, kept while the scanner cannot be reached. */
const waiting = () => {
  expect(q(".skel")).not.toBeNull()
  expect(q(".skel-slow-hint")?.textContent).toBe("Taking longer than usual, still on it") // it says why it stays
  expect(q(".skel-slow-hint")?.classList.contains("now")).toBe(true) // and says it at once
  expect(q(".vb")).toBeNull()
  expect(state.failureView).toBe("waiting")
  noErrorScreen()
}

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
  expect(q(".scanned-ago")).toBeNull()
  expect(text()).toContain("TKN")
  await advance(afterMs)
  state.lastCA = "" // the page asks again (a navigation back to this token)
}

describe("a scan waits 15 s at most", () => {
  it("a scanner that never answers: at 15 s the overlay stops waiting for THAT request, but keeps its loading screen: no error, ever", async () => {
    fetchMock.mockImplementation(hangs)
    void scan(CA)
    await advance(14_800)
    expect(q(".skel")).not.toBeNull()
    expect(state.failureView).toBeNull() // still the first attempt
    await advance(400)
    waiting()
    expect(callsFor(CA)).toBe(1) // one long attempt, not four
  })

  it("a scanner that answers 500 each time: it tries again 3 times (10.5 s of waiting), then keeps the loading screen", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(10_600)
    expect(callsFor(CA)).toBe(4)
    waiting()
  })

  it("a scanner that answers in 12 s is waited for (a slow scan is not a failure)", async () => {
    fetchMock.mockImplementation(() => new Promise((res) => setTimeout(() => res(answer(data())), 12_000)))
    void scan(CA)
    await advance(12_100)
    expect(text()).toContain("TKN")
    noErrorScreen()
    expect(state.failureView).toBeNull()
  })

  it("a scan the user moved away from is cancelled, not reported as a failure", async () => {
    fetchMock.mockImplementation((url: string, init?: { signal?: AbortSignal }) => (String(url).includes(`ca=${CA2}`) ? answer(data({ resolvedMint: CA2 })) : hangs(url, init)))
    void scan(CA)
    await advance(1000)
    void scan(CA2) // another token: the first scan is aborted
    await advance(20_000)
    noErrorScreen()
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

describe("the loading screen warns only when a scan is past its limit", () => {
  it("within its normal time the loading screen says \"Still loading\" (it fades in after 3 s); past the 15 s limit it says \"Taking longer than usual, still on it\", at once", async () => {
    fetchMock.mockImplementation(hangs)
    void scan(CA)
    await advance(500)
    let hint = q(".skel-slow-hint")
    expect(hint?.textContent).toBe("Still loading…")
    expect(hint?.classList.contains("now")).toBe(false) // the normal 3 s delay: a fast scan never shows it
    await advance(14_000) // 14.5 s: still within the limit
    hint = q(".skel-slow-hint")
    expect(hint?.textContent).toBe("Still loading…")
    expect(text()).not.toContain("Taking longer than usual")
    await advance(1_000) // 15.5 s: the limit is passed
    hint = q(".skel-slow-hint")
    expect(hint?.textContent).toBe("Taking longer than usual, still on it")
    expect(hint?.classList.contains("now")).toBe(true)
  })

  it("a scan that is merely slow (12 s) never sees the warning", async () => {
    fetchMock.mockImplementation(() => new Promise((res) => setTimeout(() => res(answer(data())), 12_000)))
    void scan(CA)
    await advance(11_000)
    expect(q(".skel-slow-hint")?.textContent).toBe("Still loading…")
    expect(text()).not.toContain("Taking longer than usual")
    await advance(1_100)
    expect(text()).toContain("TKN")
    expect(text()).not.toContain("Taking longer than usual")
  })

  it("a request that fails early (the server answers 500 four times, 10.5 s) is past its limit too: the warning appears when it has failed", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(5_000)
    expect(q(".skel-slow-hint")?.textContent).toBe("Still loading…")
    await advance(6_000)
    expect(q(".skel-slow-hint")?.textContent).toBe("Taking longer than usual, still on it")
  })

  it("when an old verdict leaves and the loading screen comes back, the message is there at once", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 600 }), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".scanned-ago")).not.toBeNull()
    await advance(5 * MIN) // past the 10 min window
    waiting() // includes: the message, with the class that shows it at once
  })
})

describe("a request the server refuses (an invalid address): nothing to scan, nothing to retry", () => {
  it.each([400, 404, 422])("a %i: one request, no retry, no recovery, and the overlay goes away quietly (no loading screen forever)", async (status) => {
    fetchMock.mockImplementation(() => httpError(status))
    void scan(CA)
    await advance(300)
    expect(callsFor(CA)).toBe(1) // not four
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(1) // and no background attempt later
    expect(state.recoveryTimer).toBeNull()
    expect(state.failureView).toBeNull()
    expect(state.boxEl?.style.display).toBe("none")
    noErrorScreen()
  })

  it("but a 429 (too many requests) and a 5xx are retried: they can change", async () => {
    let n = 0
    fetchMock.mockImplementation(() => (++n <= 2 ? httpError(n === 1 ? 429 : 502) : answer(data())))
    void scan(CA)
    await advance(6000)
    expect(callsFor(CA)).toBe(3)
    expect(text()).toContain("TKN")
    noErrorScreen()
  })
})

describe("when the scanner cannot be reached: the last known verdict, with when it was scanned, if the server allowed it", () => {
  it("shows it with a small line at the foot of the card, centred, in the card's own font: \"Scanned 6 min ago\"", async () => {
    await seedThenAskAgain(data(), 6 * MIN)
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")))
    void scan(CA)
    await advance(11_000)
    const line = q(".scanned-ago")
    expect(line?.textContent).toBe("Scanned 6 min ago")
    expect(text()).toContain("TKN")
    // the foot of the card: the last thing in it, after the buttons
    const card = line?.parentElement as HTMLElement
    expect(card.lastElementChild).toBe(line)
    expect(card.querySelector(".vb")).not.toBeNull()
    expect(state.failureView).toBe("stale")
    noErrorScreen()
  })

  it("not when the server did not allow it for that verdict (a SAFE of a young token: staleLeftSec 0): the loading screen stays", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 0 }), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".scanned-ago")).toBeNull()
    waiting()
  })

  it("if the old verdict cannot be drawn (damaged in the extension storage), the overlay still answers: the loading screen, and it keeps trying", async () => {
    const { cacheScan } = await import("../contents/modules/cache")
    await cacheScan(CA, data({ flags: "damaged" }), null)
    await advance(6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".scanned-ago")).toBeNull()
    waiting()
    expect(state.recoveryTimer).not.toBeNull()
  })

  it("not from a server that says nothing (an older one): 5 minutes, then the loading screen, exactly as before (minus the error)", async () => {
    const old = data() as unknown as Record<string, unknown>
    delete old.freshForSec
    delete old.staleLeftSec
    await seedThenAskAgain(old as unknown as ScanResponseData, 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".scanned-ago")).toBeNull()
    waiting()
  })

  it("a verdict beyond its window is not shown: the loading screen", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 400 }), 7 * MIN) // 420 s since the verdict, window 400 s
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".scanned-ago")).toBeNull()
    waiting()
  })

  it("the old verdict goes the moment its window is over: back to the loading screen, never a stale SAFE kept on screen", async () => {
    await seedThenAskAgain(data({ staleLeftSec: 600 }), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(state.failureView).toBe("stale") // 6 min 11 s: still inside the 10 min
    await advance(3 * MIN)
    expect(state.failureView).toBe("stale") // 9 min 11 s
    await advance(2 * MIN)
    expect(q(".scanned-ago")).toBeNull() // past 10 min
    waiting()
    expect(state.boxEl?.className).toBe("box") // not tinted with the verdict that left
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
      expect(q(".scanned-ago")).toBeNull()
      waiting()
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden
    }
  })

  it("the age in the line is refreshed every 20 s, without rebuilding the card (a panel the user has open stays open)", async () => {
    await seedThenAskAgain(data(), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    const card = q(".vb")
    expect(q(".scanned-ago")?.textContent).toContain("6 min ago")
    await advance(2 * MIN)
    expect(q(".scanned-ago")?.textContent).toMatch(/8 min ago/)
    expect(q(".vb")).toBe(card) // the same node
  })
})

describe("a verdict the server served from memory (a data source is down): the same line, and the overlay keeps asking", () => {
  const memory = (ageSec: number, over: Record<string, unknown> = {}) => data({ scannedAgoSec: ageSec, servedFromMemory: true, degraded: true, freshForSec: 30, staleLeftSec: 0, ...over })

  it("the verdict stays SAFE, with \"Scanned 6 min ago\" as the last thing in the card, like an old verdict", async () => {
    fetchMock.mockImplementation(() => answer(memory(360)))
    await scan(CA)
    expect(state.boxEl?.className).toContain("safe")
    const line = q(".scanned-ago")
    expect(line?.textContent).toBe("Scanned 6 min ago")
    expect((line?.parentElement as HTMLElement).lastElementChild).toBe(line)
    expect(state.failureView).toBe("stale")
    expect(state.recoveryTimer).not.toBeNull() // it keeps asking until the data source is back
    noErrorScreen()
  })

  it("the age keeps up with the clock (the server counts it from when the market was read), without rebuilding the card", async () => {
    const t0 = Date.now()
    fetchMock.mockImplementation(() => answer(memory(360 + Math.round((Date.now() - t0) / 1000)))) // the real server: the memory is one reading, its age grows
    await scan(CA)
    const card = q(".vb")
    await advance(2 * MIN + 30_000) // 8 min 30 s: the line was last touched at most 20 s ago
    expect(q(".scanned-ago")?.textContent).toBe("Scanned 8 min ago")
    expect(q(".vb")).toBe(card)
  })

  it("and between two answers of the server its age is refreshed every 20 s by the overlay itself", async () => {
    fetchMock.mockImplementation(() => answer(memory(360)))
    await scan(CA)
    await advance(25_000)
    const first = q(".scanned-ago")?.textContent
    expect(first).toBe("Scanned 6 min ago")
    // a long silence of the server: only the overlay's own tick moves the age (the next attempt is a minute away at this point of the calendar)
    fetchMock.mockImplementation(() => new Promise(() => {}))
    await advance(5 * MIN)
    expect(q(".scanned-ago")?.textContent).toMatch(/^Scanned (10|11) min ago$/)
  })

  it("when the data source is back, the fresh verdict replaces it: the line goes, the retries stop", async () => {
    let n = 0
    fetchMock.mockImplementation(() => (++n === 1 ? answer(memory(360)) : answer(data())))
    await scan(CA)
    expect(q(".scanned-ago")).not.toBeNull()
    await advance(10_000) // the first background attempt (3 s) got an ordinary answer
    expect(q(".scanned-ago")).toBeNull()
    expect(state.failureView).toBeNull()
    expect(state.recoveryTimer).toBeNull()
    const calls = fetchMock.mock.calls.length
    await advance(5 * MIN)
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it("while the data source stays down it keeps asking on the calendar (3 s, 8 s...), the line staying", async () => {
    fetchMock.mockImplementation(() => answer(memory(360)))
    await scan(CA)
    await advance(20 * MIN)
    expect(callsFor(CA)).toBeGreaterThan(10) // the calendar: 3, 8, 15, 30 s, then every minute
    expect(q(".scanned-ago")).not.toBeNull()
    expect(state.failureView).toBe("stale")
  })

  it("the same old verdict again (the data source is still down): only the age changes, the card is not redrawn and does not flash", async () => {
    fetchMock.mockImplementation(() => answer(memory(360)))
    await scan(CA)
    const card = q(".vb")
    await advance(10_000) // a background attempt (3 s, then 8 s later) got the same answer
    expect(callsFor(CA)).toBeGreaterThan(1)
    expect(q(".vb")).toBe(card) // the same node: nothing redrawn
    expect(q(".topbar.flash")).toBeNull()
    expect(q(".scanned-ago")?.textContent).toMatch(/^Scanned 6 min ago$/)
    expect(state.boxEl?.classList.contains("refreshing")).toBe(false)
  })

  it("a DIFFERENT verdict from memory (a worse one) is drawn: the card follows the server", async () => {
    let n = 0
    fetchMock.mockImplementation(() => answer(++n === 1 ? memory(360) : memory(900, { risk: "RUG", rugKind: "confirmed", score: 40 })))
    await scan(CA)
    expect(state.boxEl?.className).toContain("safe")
    await advance(10_000)
    expect(state.boxEl?.className).toContain("rug")
    expect(q(".scanned-ago")?.textContent).toMatch(/^Scanned 1[5-6] min ago$/)
  })

  it("from the overlay's own memory (the answer is cached 30 s): the same line, not a plain verdict", async () => {
    fetchMock.mockImplementation(() => answer(memory(360)))
    await scan(CA)
    const before = callsFor(CA)
    state.lastCA = "" // the page asks again within the 30 s
    await scan(CA)
    expect(callsFor(CA)).toBe(before) // served from the overlay's memory
    expect(q(".scanned-ago")?.textContent).toBe("Scanned 6 min ago")
    expect(state.failureView).toBe("stale")
  })

  it("an ordinary answer shows no line, and a value that is not a number is ignored", async () => {
    for (const bad of ["6 min", -3, null]) {
      state.lastCA = ""
      scanCache.clear()
      fetchMock.mockImplementation(() => answer(data({ scannedAgoSec: bad })))
      await scan(CA)
      expect(q(".scanned-ago"), String(bad)).toBeNull()
      expect(state.failureView).toBeNull()
    }
  })

  it("closing the box stops the retries", async () => {
    fetchMock.mockImplementation(() => answer(memory(360)))
    await scan(CA)
    state.manuallyDismissed = true
    const before = callsFor(CA)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(before)
  })
})

describe("the rescan after a price crash", () => {
  it("does not lose the old verdict when the scanner is down: a token that crashed keeps its RUG on screen", async () => {
    fetchMock.mockImplementation(() => answer(data({ risk: "RUG", rugKind: "confirmed", score: 40, priceChange1h: -71, staleLeftSec: 86_400 })))
    await scan(CA)
    expect(state.boxEl?.className).toContain("rug")
    fetchMock.mockImplementation(() => httpError(503))
    await advance(20_000) // the rescan 5 s after a crash starts, fails: the live card stays
    expect(callsFor(CA)).toBeGreaterThan(1) // the rescan did ask the scanner again (the entry is not served as fresh any more)
    expect(state.failureView).toBeNull()
    await advance(30 * MIN)
    state.lastCA = "" // the page asks again
    void scan(CA)
    await advance(12_000)
    expect(q(".scanned-ago")?.textContent).toContain("Scanned 30 min ago")
    expect(state.boxEl?.className).toContain("rug")
    expect(state.failureView).toBe("stale")
  })
})

describe("the overlay tries again by itself", () => {
  it("the loading screen: when the scanner is back, the verdict replaces it with no click, with the normal entrance (not a refresh flash)", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    waiting()
    fetchMock.mockImplementation(() => answer(data()))
    await advance(3_100) // the first background attempt is 3 s after the failure
    noErrorScreen()
    expect(q(".skel")).toBeNull()
    expect(text()).toContain("TKN")
    expect(state.failureView).toBeNull()
    expect(state.recoveryTimer).toBeNull()
    expect(state.boxEl?.classList.contains("refreshing")).toBe(false)
    expect(q(".topbar.flash")).toBeNull()
  })

  it("while it waits, the loading screen is the same one all along (not rebuilt when the first attempt fails, nor at each later attempt: no flicker)", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(5_000)
    const skel = q(".skel") // the one the first scan put on screen
    expect(skel).not.toBeNull()
    await advance(6_000) // the first attempt has failed by now
    expect(q(".skel")).toBe(skel)
    await advance(2 * MIN) // several background attempts
    expect(q(".skel")).toBe(skel)
    waiting()
  })

  it("a stale verdict: replaced by the fresh one, the line gone, and no more attempts", async () => {
    await seedThenAskAgain(data(), 6 * MIN)
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(11_000)
    expect(q(".scanned-ago")).not.toBeNull()
    fetchMock.mockImplementation(() => answer(data({ risk: "DANGER", score: 300 })))
    await advance(30_000)
    expect(q(".scanned-ago")).toBeNull()
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

  it("there is no Retry button to press: a long outage and the answer comes back by itself", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(2 * HOUR_MS)
    waiting()
    fetchMock.mockImplementation(() => answer(data()))
    await advance(70_000) // at most a minute between two attempts
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

  it("it keeps trying for hours (every minute): the loading screen stays and nothing else appears", async () => {
    fetchMock.mockImplementation(() => httpError(500))
    void scan(CA)
    await advance(3 * HOUR_MS)
    expect(callsFor(CA)).toBeGreaterThan(150)
    waiting()
  })
})

describe("a fresh answer from the scanner is still what it was", () => {
  it("a normal scan shows the verdict, no line, no failure", async () => {
    fetchMock.mockImplementation(() => answer(data()))
    await scan(CA)
    expect(text()).toContain("TKN")
    expect(q(".scanned-ago")).toBeNull()
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

