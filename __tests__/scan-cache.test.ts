// __tests__/scan-cache.test.ts
//
// Regression tests for the content-script scan cache.
//
// The bug these pin down: the cache used to mirror every scan into the
// HOST PAGE's localStorage ("antares_scan_<CA>") together with the raw
// 30-day session JWT. Content scripts share storage with the page, so any
// script on dexscreener.com / pump.fun / axiom.trade… could (1) steal the
// JWT and (2) plant a forged "SAFE" entry that the overlay would serve.
// The cache now lives in chrome.storage.local (unreachable from the page)
// and entries carry a one-way session fingerprint, never the token.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ScanResponseData } from "../shared/types"
import { scanCache } from "../contents/modules/state"
import { CACHE_TTL, LS_PREFIX, SCAN_CACHE_PREFIX, SCAN_CACHE_MAX_ENTRIES } from "../contents/modules/constants"
import {
  cacheScan,
  getCached,
  getStale,
  expireCached,
  evictCached,
  clearAllScanCache,
  sweepScanCache,
  purgeLegacyPageStorage,
  sessionFingerprint,
} from "../contents/modules/cache"

const TOKEN_A = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2aWN0aW1AZXhhbXBsZS5jb20ifQ.c2lnbmF0dXJlLUE"
const TOKEN_B = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvdGhlckBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJlLUI"
const CA1 = "So1anaTokenAddressForTests11111111111111111"
const CA2 = "So1anaTokenAddressForTests22222222222222222"
const NOW = 1_800_000_000_000

const SAFE = { risk: "SAFE", score: 950, tokenSymbol: "OK" } as unknown as ScanResponseData
const RUG = { risk: "RUG", score: 120, tokenSymbol: "BAD" } as unknown as ScanResponseData

// ─── chrome.storage.local + page localStorage stubs ─────────────────────────

function installChrome(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  const stub: { runtime: { lastError?: { message: string } } } = { runtime: {} }
  const flags = { failSet: false }
  const local = {
    get: (keys: string | string[] | null, cb: (items: Record<string, unknown>) => void) => {
      const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k))
      cb(out)
    },
    set: (items: Record<string, unknown>, cb: () => void) => {
      if (flags.failSet) {
        stub.runtime.lastError = { message: "QUOTA_BYTES quota exceeded" }
        cb()
        stub.runtime.lastError = undefined
        return
      }
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v))
      cb()
    },
    remove: (keys: string[], cb: () => void) => {
      for (const k of keys) store.delete(k)
      cb()
    },
  }
  // `lastError` must be read live (it is only set for the duration of a callback).
  vi.stubGlobal("chrome", {
    storage: { local },
    runtime: { get lastError() { return stub.runtime.lastError } },
  })
  return { store, flags }
}

function installLocalStorage(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial))
  const setItem = vi.fn((k: string, v: string) => { m.set(k, String(v)) })
  vi.stubGlobal("localStorage", {
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem,
    removeItem: (k: string) => { m.delete(k) },
  })
  return { m, setItem }
}

const cacheKeys = (store: Map<string, unknown>) => [...store.keys()].filter((k) => k.startsWith(SCAN_CACHE_PREFIX))
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

let chromeStore: Map<string, unknown>
let chromeFlags: { failSet: boolean }
let page: ReturnType<typeof installLocalStorage>

function setSession(token: string | null) {
  if (token === null) chromeStore.delete("antares_session_token")
  else chromeStore.set("antares_session_token", token)
}

beforeEach(() => {
  scanCache.clear()
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  const c = installChrome()
  chromeStore = c.store
  chromeFlags = c.flags
  page = installLocalStorage()
})

// ─── sessionFingerprint ─────────────────────────────────────────────────────

describe("sessionFingerprint", () => {
  it("is null for an anonymous session", async () => {
    expect(await sessionFingerprint(null)).toBeNull()
  })

  it("is deterministic, distinguishes sessions and never contains the token", async () => {
    const a1 = await sessionFingerprint(TOKEN_A)
    const a2 = await sessionFingerprint(TOKEN_A)
    const b = await sessionFingerprint(TOKEN_B)
    expect(a1).toMatch(/^[0-9a-f]{24}$/)
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(TOKEN_A).not.toContain(a1 as string)
    expect(a1).not.toContain(TOKEN_A.slice(0, 12))
  })

  it("fails closed: a hashing error yields a value that never matches (not null)", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("no subtle"))
    const x = await sessionFingerprint(TOKEN_A)
    const y = await sessionFingerprint(TOKEN_A)
    expect(x).not.toBeNull()
    expect(x).not.toBe(y)
  })
})

// ─── C1: nothing sensitive in the host page, nothing forgeable from it ──────

describe("cacheScan — keeps the session JWT and the cache out of the host page", () => {
  it("never writes to the page's localStorage and never persists the raw token", async () => {
    setSession(TOKEN_A)
    await cacheScan(CA1, SAFE, TOKEN_A)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))

    expect(page.setItem).not.toHaveBeenCalled()
    expect(page.m.size).toBe(0)

    const entry = chromeStore.get(SCAN_CACHE_PREFIX + CA1) as { session: string | null }
    expect(entry.session).toBe(await sessionFingerprint(TOKEN_A))
    // The token lives under its own key; no CACHE entry may embed it.
    const cacheDump = JSON.stringify(cacheKeys(chromeStore).map((k) => chromeStore.get(k)))
    expect(cacheDump).not.toContain(TOKEN_A)
    expect(cacheDump).not.toContain(TOKEN_A.split(".")[1])
  })

  it("serves the entry the extension wrote (witness: persistence works across a reload)", async () => {
    setSession(TOKEN_A)
    await cacheScan(CA1, SAFE, TOKEN_A)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))

    scanCache.clear() // simulate a page reload: memory gone, storage kept
    expect(await getCached(CA1)).toEqual(SAFE)
  })

  it("ignores a SAFE verdict the page plants in its own localStorage", async () => {
    // What a malicious script on the host site could write under the OLD key.
    page.m.set(LS_PREFIX + CA2, JSON.stringify({ data: { risk: "SAFE", score: 999 }, ts: NOW, session: null }))
    scanCache.clear()

    expect(await getCached(CA2)).toBeNull()
  })
})

describe("purgeLegacyPageStorage", () => {
  it("removes the old antares_scan_* entries (which embedded the JWT) and nothing else", () => {
    page.m.set(LS_PREFIX + CA1, JSON.stringify({ data: SAFE, ts: NOW, session: TOKEN_A }))
    page.m.set(LS_PREFIX + CA2, JSON.stringify({ data: RUG, ts: NOW, session: TOKEN_A }))
    page.m.set("theme", "dark")
    page.m.set("x_" + LS_PREFIX + "y", "keep-me") // prefix must match at the START only

    purgeLegacyPageStorage()

    expect([...page.m.keys()].sort()).toEqual(["theme", "x_" + LS_PREFIX + "y"])
  })

  it("does not throw when the page blocks localStorage", () => {
    vi.stubGlobal("localStorage", {
      get length(): number { throw new Error("SecurityError") },
      key: () => null,
    })
    expect(() => purgeLegacyPageStorage()).not.toThrow()
  })
})

// ─── session / TTL semantics (behaviour the tag exists to protect) ──────────

describe("getCached — session and TTL", () => {
  it("drops the entry after logout and evicts it from storage", async () => {
    setSession(TOKEN_A)
    await cacheScan(CA1, SAFE, TOKEN_A)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))
    expect(await getCached(CA1)).toEqual(SAFE) // witness: same session → served

    setSession(null)
    expect(await getCached(CA1)).toBeNull()
    expect(cacheKeys(chromeStore)).toHaveLength(0)
  })

  it("drops an anonymous entry once the user logs in", async () => {
    await cacheScan(CA1, SAFE, null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))
    expect(await getCached(CA1)).toEqual(SAFE) // witness: still anonymous → served

    setSession(TOKEN_A)
    expect(await getCached(CA1)).toBeNull()
  })

  it("drops the entry when another account signs in", async () => {
    setSession(TOKEN_A)
    await cacheScan(CA1, SAFE, TOKEN_A)
    setSession(TOKEN_B)
    expect(await getCached(CA1)).toBeNull()
  })

  it("expires entries after CACHE_TTL", async () => {
    await cacheScan(CA1, SAFE, null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))

    vi.spyOn(Date, "now").mockReturnValue(NOW + CACHE_TTL - 1)
    expect(await getCached(CA1)).toEqual(SAFE) // witness: just inside the TTL

    vi.spyOn(Date, "now").mockReturnValue(NOW + CACHE_TTL + 1)
    expect(await getCached(CA1)).toBeNull()
    expect(cacheKeys(chromeStore)).toHaveLength(0)
  })

  it("treats a corrupted stored entry as a miss", async () => {
    chromeStore.set(SCAN_CACHE_PREFIX + CA1, { ts: NOW }) // no `data`
    chromeStore.set(SCAN_CACHE_PREFIX + CA2, { data: SAFE, ts: "yesterday" })
    expect(await getCached(CA1)).toBeNull()
    expect(await getCached(CA2)).toBeNull()
  })

  it("evictCached removes both tiers", async () => {
    await cacheScan(CA1, SAFE, null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))
    await evictCached(CA1)
    expect(scanCache.has(CA1)).toBe(false)
    expect(cacheKeys(chromeStore)).toHaveLength(0)
  })
})

// ─── bounded storage, and the prefix-collision trap ─────────────────────────

describe("sweepScanCache / clearAllScanCache never touch other extension state", () => {
  const OTHER = {
    antares_session_token: TOKEN_A,
    antares_scan_history: [{ ca: CA1, verdict: "SAFE" }], // starts with "antares_scan_" — must survive
    antares_popup_pos: { x: 1, y: 2 },
  }

  beforeEach(() => {
    for (const [k, v] of Object.entries(OTHER)) chromeStore.set(k, v)
  })

  it("sweep drops expired and malformed entries, keeps live ones", async () => {
    chromeStore.set(SCAN_CACHE_PREFIX + "old", { data: SAFE, ts: NOW - CACHE_TTL - 1, session: null })
    chromeStore.set(SCAN_CACHE_PREFIX + "bad", { data: SAFE, ts: "x", session: null })
    chromeStore.set(SCAN_CACHE_PREFIX + "live", { data: SAFE, ts: NOW - 1000, session: null })

    await sweepScanCache(NOW)

    expect(cacheKeys(chromeStore)).toEqual([SCAN_CACHE_PREFIX + "live"])
    for (const [k, v] of Object.entries(OTHER)) expect(chromeStore.get(k)).toEqual(v)
  })

  it("sweep caps the cache at SCAN_CACHE_MAX_ENTRIES, evicting the oldest first", async () => {
    const total = SCAN_CACHE_MAX_ENTRIES + 5
    for (let i = 0; i < total; i++) {
      // i = 0 is the oldest
      chromeStore.set(SCAN_CACHE_PREFIX + `t${i}`, { data: SAFE, ts: NOW - (total - i) * 100, session: null })
    }

    await sweepScanCache(NOW)

    const left = cacheKeys(chromeStore)
    expect(left).toHaveLength(SCAN_CACHE_MAX_ENTRIES)
    for (let i = 0; i < 5; i++) expect(left).not.toContain(SCAN_CACHE_PREFIX + `t${i}`)
    expect(left).toContain(SCAN_CACHE_PREFIX + `t${total - 1}`)
    for (const [k, v] of Object.entries(OTHER)) expect(chromeStore.get(k)).toEqual(v)
  })

  it("clearAllScanCache wipes memory synchronously and only cache keys in storage", async () => {
    await cacheScan(CA1, SAFE, null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))

    const pending = clearAllScanCache()
    expect(scanCache.size).toBe(0) // synchronous: a scan started right after can't read a stale entry
    await pending

    expect(cacheKeys(chromeStore)).toHaveLength(0)
    for (const [k, v] of Object.entries(OTHER)) expect(chromeStore.get(k)).toEqual(v)
  })
})

describe("cacheScan — storage failures", () => {
  it("a failed write (quota) triggers a sweep and the in-memory entry still serves", async () => {
    chromeStore.set(SCAN_CACHE_PREFIX + "stale", { data: RUG, ts: NOW - CACHE_TTL - 1, session: null })
    chromeFlags.failSet = true

    await cacheScan(CA1, SAFE, null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(0)) // stale entry swept to make room
    await flush()

    expect(await getCached(CA1)).toEqual(SAFE) // memory tier unaffected
  })
})

// ─── The windows the SERVER decides: fresh (reuse without asking), stale (show, marked as old, when the scanner cannot be reached) ──────

describe("getCached / getStale — fresh and stale windows decided by the server", () => {
  const withWindows = (d: ScanResponseData, freshForSec: number, staleLeftSec: number, extra: Record<string, unknown> = {}) =>
    ({ ...d, freshForSec, staleLeftSec, ...extra }) as unknown as ScanResponseData
  const at = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(NOW + ms)

  it("a degraded answer (30 s) is served for 30 s, not for 5 minutes", async () => {
    await cacheScan(CA1, withWindows(SAFE, 30, 0), null)
    at(29_000)
    expect(await getCached(CA1)).not.toBeNull()
    at(31_000)
    expect(await getCached(CA1)).toBeNull()
  })

  it("an answer from a server that says nothing is served for 5 minutes and never stale (the old behaviour, exactly)", async () => {
    await cacheScan(CA1, SAFE, null)
    at(CACHE_TTL - 1)
    expect(await getCached(CA1)).toEqual(SAFE)
    at(CACHE_TTL + 1)
    expect(await getCached(CA1)).toBeNull()
    expect(await getStale(CA1)).toBeNull()
  })

  it("past its fresh window an answer is not served as fresh, but may still be shown stale until its stale window is over", async () => {
    await cacheScan(CA1, withWindows(SAFE, 300, 1200), null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))

    at(6 * 60_000)
    expect(await getCached(CA1)).toBeNull() // not fresh any more
    expect(cacheKeys(chromeStore)).toHaveLength(1) // ... but kept: it may still be shown stale
    const stale = await getStale(CA1)
    expect(stale?.data).toMatchObject({ risk: "SAFE" })
    expect(stale?.staleUntil).toBe(NOW + 1_200_000)

    at(1_200_000 - 1)
    expect(await getStale(CA1)).not.toBeNull()
    at(1_200_000 + 1)
    expect(await getStale(CA1)).toBeNull()
    expect(cacheKeys(chromeStore)).toHaveLength(0) // dropped for good
  })

  it("a verdict the server did not allow stale (staleLeftSec 0) is never shown stale", async () => {
    await cacheScan(CA1, withWindows(SAFE, 300, 0), null)
    at(CACHE_TTL + 1_000)
    expect(await getStale(CA1)).toBeNull()
  })

  it("a confirmed RUG (24 h) is still there 23 hours later, from the extension storage after a reload of the page", async () => {
    await cacheScan(CA1, withWindows(RUG, 300, 86_400), null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))
    scanCache.clear() // the page was reloaded: only the extension storage remains
    at(23 * 3_600_000)
    const stale = await getStale(CA1)
    expect(stale?.data).toMatchObject({ risk: "RUG" })
    at(24 * 3_600_000 + 1_000)
    expect(await getStale(CA1)).toBeNull()
  })

  it("the session rule holds for a stale verdict too: a Pro verdict never survives a logout, nor another account", async () => {
    setSession(TOKEN_A)
    await cacheScan(CA1, withWindows(SAFE, 300, 1200), TOKEN_A)
    at(6 * 60_000)
    expect(await getStale(CA1)).not.toBeNull() // witness: same session

    setSession(TOKEN_B)
    expect(await getStale(CA1)).toBeNull()
    expect(cacheKeys(chromeStore)).toHaveLength(0)

    setSession(TOKEN_A)
    await cacheScan(CA2, withWindows(SAFE, 300, 1200), TOKEN_A)
    setSession(null)
    expect(await getStale(CA2)).toBeNull()
  })

  it("madeAt is when the verdict was made: the server's date when its cache held the answer a while", async () => {
    await cacheScan(CA1, withWindows(SAFE, 300, 1200, { fetchedAt: NOW - 90_000 }), null)
    at(6 * 60_000)
    expect((await getStale(CA1))?.madeAt).toBe(NOW - 90_000)
    await cacheScan(CA2, withWindows(SAFE, 300, 1200), null)
    expect((await getStale(CA2))?.madeAt).toBe(NOW + 6 * 60_000) // no date from the server: the moment it was received (the clock is at +6 min here)
  })

  it("nothing there, nothing to show", async () => {
    expect(await getStale(CA1)).toBeNull()
  })
})

describe("sweepScanCache — keeps what may still be shown stale", () => {
  it("an entry past the 5 minutes but inside its stale window survives the sweep; once the window is over it is dropped", async () => {
    await cacheScan(CA1, { ...SAFE, freshForSec: 300, staleLeftSec: 1800 } as unknown as ScanResponseData, null)
    await cacheScan(CA2, SAFE, null) // an older server: gone after 5 minutes
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(2))

    await sweepScanCache(NOW + 20 * 60_000)
    expect(cacheKeys(chromeStore)).toEqual([SCAN_CACHE_PREFIX + CA1])

    await sweepScanCache(NOW + 31 * 60_000)
    expect(cacheKeys(chromeStore)).toHaveLength(0)
  })
})

describe("expireCached — stops serving an entry as fresh but keeps what may still be shown stale", () => {
  const withWindows = (d: ScanResponseData, freshForSec: number, staleLeftSec: number) => ({ ...d, freshForSec, staleLeftSec }) as unknown as ScanResponseData

  it("the rescan after a price crash must not lose the old verdict: no longer fresh, still shown stale", async () => {
    await cacheScan(CA1, withWindows(RUG, 300, 86_400), null)
    expect(await getCached(CA1)).not.toBeNull() // witness: fresh
    await expireCached(CA1)
    expect(await getCached(CA1)).toBeNull() // asked again
    expect((await getStale(CA1))?.data).toMatchObject({ risk: "RUG" }) // ... but the old verdict is still there if the asking fails
  })

  it("the expiry is written to the extension storage too (a reload of the page does not bring it back to life)", async () => {
    await cacheScan(CA1, withWindows(RUG, 300, 86_400), null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))
    await expireCached(CA1)
    await vi.waitFor(() => expect((chromeStore.get(SCAN_CACHE_PREFIX + CA1) as { freshUntil: number }).freshUntil).toBe(NOW - 1))
    scanCache.clear()
    expect(await getCached(CA1)).toBeNull()
    expect(await getStale(CA1)).not.toBeNull()
  })

  it("an entry from a server that sends no stale window is evicted, exactly as before", async () => {
    await cacheScan(CA1, SAFE, null)
    await vi.waitFor(() => expect(cacheKeys(chromeStore)).toHaveLength(1))
    await expireCached(CA1)
    expect(scanCache.has(CA1)).toBe(false)
    expect(cacheKeys(chromeStore)).toHaveLength(0)
  })

  it("nothing there, nothing to do", async () => {
    await expect(expireCached(CA1)).resolves.toBeUndefined()
  })
})

