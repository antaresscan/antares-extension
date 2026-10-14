/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// A scan made while a data source is silent shows the Limited data card, with no verdict. For a token this device already scanned IN FULL and that
// came out DANGER or RUG, that silence must not make it look unknown: the card says "Last full scan: RUG, 12 min ago", in small grey text, Free and
// Pro alike. Nothing is said for SAFE / CAUTION (a stale good word is the one that misleads), nor for a token never scanned in full on this device.

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache, lastBadCache, resetSourceGap } = await import("../contents/modules/state")
const { noteFullScan, getLastBad, sweepLastBad, sweepScanCache, clearAllScanCache } = await import("../contents/modules/cache")
const { lastFullScanText } = await import("../contents/modules/resilience")
const { LAST_BAD_PREFIX, LAST_BAD_MAX_AGE_MS, LAST_BAD_MAX_ENTRIES } = await import("../contents/modules/constants")
const { SHADOW_CSS } = await import("../contents/modules/styles")

const CA = "So1anaTokenAddressForTests11111111111111111"
const CA2 = "So1anaTokenAddressForTests22222222222222222"
const MIN = 60_000
const DAY = 24 * 60 * MIN
const T = 1_800_000_000_000
const BAD = ["DANGER", "RUG"] as const
const GOOD = ["SAFE", "CAUTION"] as const
const SCORE: Record<string, number> = { SAFE: 1000, CAUTION: 800, DANGER: 500, RUG: 100 }

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 900, risk: "SAFE", flags: [], pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000, tokenSymbol: "TKN", tokenName: "Token", lpBurned: true,
  lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false,
  freshForSec: 300, staleLeftSec: 1200, ...over,
}) as unknown as ScanResponseData
const full = (risk: string, over: Record<string, unknown> = {}) => data({ risk, score: SCORE[risk], fetchedAt: Date.now(), ...over })
const gapped = (over: Record<string, unknown> = {}) =>
  data({ risk: "CAUTION", score: 850, degraded: true, sourceGap: true, freshForSec: 30, staleLeftSec: 0, fetchedAt: Date.now(), ...over })

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

const quotaHeaders = (tier: string) => new Headers({
  "X-Antares-Quota-Tier": tier, "X-Antares-Quota-Used": "3", "X-Antares-Quota-Limit": "-1", "X-Antares-Quota-Remaining": "-1", "X-Antares-Quota-Reset": "0",
})
const answer = (body: unknown, tier?: string) => Promise.resolve({ ok: true, status: 200, headers: tier ? quotaHeaders(tier) : new Headers(), json: () => Promise.resolve(body) })
const q = (sel: string) => state.shadow?.querySelector(sel) ?? null
const lastFull = () => q(".last-full")?.textContent ?? null
const gapLine = () => q(".source-gap")?.textContent ?? null
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const lastBadKey = (ca: string) => LAST_BAD_PREFIX + ca

/** A full scan of `ca` on this device, then `ms` later a scan made while a source is silent (the scan cache is emptied first: the question is the memory of the BAD verdict). */
async function fullThenGap(risk: string, ms: number, opts: { tier?: string; ca?: string } = {}) {
  const ca = opts.ca ?? CA
  fetchMock.mockImplementation(() => answer(full(risk), opts.tier))
  await scan(ca)
  await advance(ms)
  await clearAllScanCache() // the full answer is old (a real rescan, whatever the age): the scan cache goes, the last bad verdict stays
  fetchMock.mockImplementation(() => answer(gapped(), opts.tier))
  state.lastCA = ""
  await scan(ca)
}

beforeEach(() => {
  vi.useFakeTimers({ now: T })
  installChrome()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  scanCache.clear()
  lastBadCache.clear()
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

describe("the words", () => {
  it("name the verdict and how long ago, like \"Scanned 6 min ago\"", () => {
    expect(lastFullScanText("RUG", 12 * MIN)).toBe("Last full scan: RUG, 12 min ago")
    expect(lastFullScanText("DANGER", 10_000)).toBe("Last full scan: DANGER, less than a minute ago")
    expect(lastFullScanText("RUG", 3 * DAY + 5 * MIN)).toBe("Last full scan: RUG, 3 d ago")
  })
})

describe("the Limited data card of a token whose last full scan was bad", () => {
  for (const tier of ["free", "pro"] as const) {
    for (const risk of BAD) {
      it(`${tier} | last full scan ${risk}: the card says so, with the age, above the countdown`, async () => {
        await fullThenGap(risk, 12 * MIN, { tier })
        expect(state.boxEl?.classList.contains("limited")).toBe(true)
        await advance(0)
        expect(lastFull()).toBe(`Last full scan: ${risk}, 12 min ago`)
        const line = q(".last-full")!
        expect(line.nextElementSibling?.classList.contains("source-gap")).toBe(true) // sits right above the countdown
        expect(gapLine()).toMatch(/^Source unavailable, rescanning in \d+s$/)
        // still no verdict: the card itself carries none of the verdict classes, and its big word is LIMITED DATA
        expect(q(".vb h1")?.textContent).toBe("LIMITED DATA")
        expect(["safe", "caution", "danger", "rug"].filter((c) => state.boxEl?.classList.contains(c))).toEqual([])
      })
    }
  }

  it("the age goes on counting while the card stays", async () => {
    await fullThenGap("RUG", 5 * MIN)
    await advance(0)
    expect(lastFull()).toBe("Last full scan: RUG, 5 min ago")
    // the source stays down for 3 more minutes (a try every minute): the line keeps its age true
    fetchMock.mockImplementation(() => answer(gapped()))
    await advance(3 * MIN + 5_000)
    expect(lastFull()).toMatch(/^Last full scan: RUG, [89] min ago$/)
    expect(state.shadow?.querySelectorAll(".last-full").length).toBe(1) // one line, not one per try
  })

  it("it is the verdict's own word that takes its colour, nothing else on the line", async () => {
    await fullThenGap("RUG", MIN)
    await advance(0)
    expect(q(".last-full .lf-word")?.classList.contains("lf-rug")).toBe(true)
    expect(SHADOW_CSS).toMatch(/\.last-full \.lf-rug \{ color: #ff2244; \}/)
    expect(SHADOW_CSS).toMatch(/\.last-full \.lf-danger \{ color: #ff5f5f; \}/)
    // the line itself is the grey of the other small labels
    expect(SHADOW_CSS.slice(SHADOW_CSS.indexOf("\n.last-full {"), SHADOW_CSS.indexOf("}", SHADOW_CSS.indexOf("\n.last-full {")))).toContain("#777")
  })

  it("when the sources answer again the real verdict takes the card's place and the line goes with it", async () => {
    await fullThenGap("RUG", 10 * MIN)
    await advance(0)
    expect(lastFull()).not.toBeNull()
    fetchMock.mockImplementation(() => answer(full("RUG")))
    await advance(32_000)
    expect(state.boxEl?.classList.contains("rug")).toBe(true)
    expect(state.boxEl?.classList.contains("limited")).toBe(false)
    expect(lastFull()).toBeNull()
  })
})

describe("a slow storage read does not put the line on a card that is no longer the Limited data card", () => {
  it("the real verdict arrives while the last bad verdict is being read: the line is not drawn on it", async () => {
    // a RUG from a full scan on this device, only in the storage (a reload)
    store.set(lastBadKey(CA), { risk: "RUG", at: T - 10 * MIN })
    // hold the read of that key until the test lets it go
    const local = (globalThis as unknown as { chrome: { storage: { local: { get: (k: unknown, cb: (i: Record<string, unknown>) => void) => void } } } }).chrome.storage.local
    const realGet = local.get
    let release: (() => void) | null = null
    local.get = (keys, cb) => {
      if (typeof keys === "string" && keys.startsWith(LAST_BAD_PREFIX)) { release = () => realGet(keys, cb); return }
      realGet(keys, cb)
    }
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
    // the source comes back and the real verdict takes the card, then the read finishes
    fetchMock.mockImplementation(() => answer(full("RUG")))
    await advance(32_000)
    expect(state.boxEl?.classList.contains("rug")).toBe(true)
    expect(release).not.toBeNull()
    release!()
    await advance(0)
    expect(lastFull()).toBeNull()
  })
})

describe("and not on another token's card either", () => {
  it("the user goes to another token while the last bad verdict is being read: the line is not drawn on the new card", async () => {
    store.set(lastBadKey(CA), { risk: "RUG", at: T - 10 * MIN })
    const local = (globalThis as unknown as { chrome: { storage: { local: { get: (k: unknown, cb: (i: Record<string, unknown>) => void) => void } } } }).chrome.storage.local
    const realGet = local.get
    let release: (() => void) | null = null
    local.get = (keys, cb) => {
      if (typeof keys === "string" && keys === lastBadKey(CA)) { release = () => realGet(keys, cb); return }
      realGet(keys, cb)
    }
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    // another token, scanned in full (a SAFE one), takes the box
    fetchMock.mockImplementation(() => answer(full("SAFE", { resolvedMint: CA2 })))
    await scan(CA2)
    expect(state.boxEl?.classList.contains("safe")).toBe(true)
    release!()
    await advance(0)
    expect(lastFull()).toBeNull()
  })
})

describe("when there is nothing to remind", () => {
  for (const risk of GOOD) {
    it(`last full scan ${risk}: no line (a stale good word is the one that misleads)`, async () => {
      await fullThenGap(risk, 12 * MIN)
      await advance(0)
      expect(state.boxEl?.classList.contains("limited")).toBe(true)
      expect(lastFull()).toBeNull()
      expect(store.has(lastBadKey(CA))).toBe(false)
    })
  }

  it("a token never scanned in full on this device: no line", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(0)
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
    expect(lastFull()).toBeNull()
  })

  it("a full scan that came out DANGER, then a full scan that came out SAFE: the later one counts, nothing is said", async () => {
    fetchMock.mockImplementation(() => answer(full("DANGER")))
    await scan(CA)
    await advance(6 * MIN)
    fetchMock.mockImplementation(() => answer(full("SAFE")))
    state.lastCA = ""
    await scan(CA)
    expect(store.has(lastBadKey(CA))).toBe(false)
    await advance(MIN)
    fetchMock.mockImplementation(() => answer(gapped()))
    state.lastCA = ""
    await scan(CA)
    await advance(0)
    expect(lastFull()).toBeNull()
  })

  it("a Limited data answer never writes a verdict, whatever the engine reached behind it", async () => {
    for (const risk of ["DANGER", "RUG"]) {
      fetchMock.mockImplementation(() => answer(gapped({ risk, score: SCORE[risk] })))
      state.lastCA = ""
      scanCache.clear()
      await scan(CA)
    }
    expect(store.has(lastBadKey(CA))).toBe(false)
    expect(lastBadCache.has(CA)).toBe(false)
    await advance(0)
    expect(lastFull()).toBeNull()
  })

  it("a verdict the server served from memory is not a full scan: it writes nothing", async () => {
    fetchMock.mockImplementation(() => answer(full("RUG", { scannedAgoSec: 360, servedFromMemory: true })))
    await scan(CA)
    expect(store.has(lastBadKey(CA))).toBe(false)
  })

  it("another token's bad verdict is not this token's", async () => {
    fetchMock.mockImplementation(() => answer(full("RUG", { resolvedMint: CA2 })))
    await scan(CA2)
    await advance(MIN)
    fetchMock.mockImplementation(() => answer(gapped()))
    state.lastCA = ""
    await scan(CA)
    await advance(0)
    expect(lastFull()).toBeNull()
  })

  it("older than a week: no line, and the entry is dropped", async () => {
    await fullThenGap("RUG", 8 * DAY)
    await advance(0)
    expect(lastFull()).toBeNull()
    expect(store.has(lastBadKey(CA))).toBe(false)
  })

  it("just under a week: still said (a rug stays a rug)", async () => {
    await fullThenGap("RUG", 6 * DAY)
    await advance(0)
    expect(lastFull()).toBe("Last full scan: RUG, 6 d ago")
  })
})

describe("where it is kept", () => {
  it("in extension storage, as the verdict word and the time only (no payload)", async () => {
    fetchMock.mockImplementation(() => answer(full("RUG")))
    await scan(CA)
    expect(store.get(lastBadKey(CA))).toEqual({ risk: "RUG", at: T })
  })

  it("it survives a reload of the page: the memory is empty, the storage is not", async () => {
    await fullThenGap("DANGER", 4 * MIN)
    lastBadCache.clear()
    resetSourceGap()
    state.lastCA = ""
    scanCache.clear()
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(0)
    expect(lastFull()).toBe("Last full scan: DANGER, 4 min ago")
  })

  it("it is not under the scan cache's prefix, so signing in or out (which wipes the scan cache) and the scan cache's sweep leave it alone", async () => {
    fetchMock.mockImplementation(() => answer(full("RUG")))
    await scan(CA)
    await clearAllScanCache()
    await advance(10 * MIN)
    await sweepScanCache(Date.now() + 30 * DAY)
    expect(store.get(lastBadKey(CA))).toEqual({ risk: "RUG", at: T })
  })

  it("a value planted in the storage that is not DANGER or RUG is ignored (nothing but our two words is ever written to the card)", async () => {
    for (const planted of [{ risk: "<img src=x onerror=alert(1)>", at: T }, { risk: "SAFE", at: T }, { risk: "RUG", at: "yesterday" }, { risk: "RUG" }, null, "RUG"]) {
      lastBadCache.clear()
      store.set(lastBadKey(CA), planted)
      expect(await getLastBad(CA, T + MIN)).toBeNull()
    }
  })

  it("an age in the future (a device clock set back) reads as just now, never negative", async () => {
    store.set(lastBadKey(CA), { risk: "RUG", at: T + 10 * MIN })
    resetSourceGap()
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(0)
    expect(lastFull()).toBe("Last full scan: RUG, less than a minute ago")
  })

  it("repeated full scans of the same bad token write one entry, the newest", async () => {
    fetchMock.mockImplementation(() => answer(full("DANGER")))
    await scan(CA)
    await advance(6 * MIN)
    fetchMock.mockImplementation(() => answer(full("RUG")))
    state.lastCA = ""
    await scan(CA)
    expect(store.get(lastBadKey(CA))).toEqual({ risk: "RUG", at: T + 6 * MIN })
    expect([...store.keys()].filter((k) => k.startsWith(LAST_BAD_PREFIX))).toEqual([lastBadKey(CA)])
  })
})

describe("the sweep keeps it small", () => {
  it("drops what is older than a week and keeps at most LAST_BAD_MAX_ENTRIES, oldest first, touching nothing else", async () => {
    const now = T + 30 * DAY
    store.set("antares_scan_history", [1, 2, 3])
    store.set("antares_cache:scan:other", { ts: now, data: {} })
    store.set(lastBadKey("old"), { risk: "RUG", at: now - LAST_BAD_MAX_AGE_MS - 1 })
    store.set(lastBadKey("junk"), { risk: "RUG" })
    for (let i = 0; i < LAST_BAD_MAX_ENTRIES + 5; i++) store.set(lastBadKey("t" + i), { risk: "DANGER", at: now - 1000 + i })
    await sweepLastBad(now)
    const kept = [...store.keys()].filter((k) => k.startsWith(LAST_BAD_PREFIX))
    expect(kept).toHaveLength(LAST_BAD_MAX_ENTRIES)
    expect(store.has(lastBadKey("old"))).toBe(false)
    expect(store.has(lastBadKey("junk"))).toBe(false)
    expect(store.has(lastBadKey("t0"))).toBe(false) // the oldest of the surplus went
    expect(store.has(lastBadKey("t" + (LAST_BAD_MAX_ENTRIES + 4)))).toBe(true)
    expect(store.get("antares_scan_history")).toEqual([1, 2, 3])
    expect(store.has("antares_cache:scan:other")).toBe(true)
  })
})

describe("noteFullScan", () => {
  it.each([...BAD])("%s: remembered", (risk) => {
    noteFullScan(CA, full(risk), T)
    expect(lastBadCache.get(CA)).toEqual({ risk, at: T })
  })
  it.each([...GOOD])("%s: forgotten", (risk) => {
    lastBadCache.set(CA, { risk: "RUG", at: T })
    noteFullScan(CA, full(risk), T)
    expect(lastBadCache.has(CA)).toBe(false)
  })
  it("a verdict word it does not know changes nothing", () => {
    lastBadCache.set(CA, { risk: "RUG", at: T })
    noteFullScan(CA, full("MAYBE"), T)
    expect(lastBadCache.get(CA)).toEqual({ risk: "RUG", at: T })
  })
})
