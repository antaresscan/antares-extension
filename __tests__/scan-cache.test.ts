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
