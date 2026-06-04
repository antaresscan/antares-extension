// __tests__/rescan-handler.test.ts
//
// Unit tests for the RESCAN_DONE handler (contents/modules/rescan-handler.ts).
//
// This handler is the final piece of the token.html → overlay sync:
//   1. token.html writes the fresh API result to chrome.storage.local
//   2. Background relays RESCAN_DONE to all trading-platform tabs
//   3. handleRescanDone() reads the stored result, warms the local cache,
//      and calls scan() — the overlay re-renders with zero network cost.
//
// Root cause of the bug we're pinning: even when the RESCAN_DONE signal
// reached the overlay, calling scan(ca) WITHOUT warming the cache first
// caused the content script to re-fetch from the API which returned the
// OLD verdict from the server Redis cache (several minutes TTL). The user
// saw "CAUTION" in the overlay while token.html showed "SAFE".

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks (must be before imports that use them) ──────────────────────────

vi.mock("../contents/modules/cache", () => ({
  evictCached: vi.fn(),
  saveToLS: vi.fn(),
  hydrateCacheFromLS: vi.fn(),
  getCached: vi.fn(),
  clearAllScanCache: vi.fn(),
}))

vi.mock("../contents/modules/scanner", () => ({
  scan: vi.fn().mockResolvedValue(undefined),
  scheduleRescanIfPriceCrash: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────

import { state, scanCache } from "../contents/modules/state"
import { evictCached, saveToLS } from "../contents/modules/cache"
import { scan } from "../contents/modules/scanner"
import { handleRescanDone, FRESH_SCAN_KEY, FRESH_SCAN_TTL_MS } from "../contents/modules/rescan-handler"

// ── Chrome storage mock ───────────────────────────────────────────────────

type StorageData = Record<string, unknown>

function makeChromeMock(store: StorageData = {}) {
  return {
    storage: {
      local: {
        get: vi.fn((_keys: string[], cb: (r: StorageData) => void) => cb(store)),
        set: vi.fn((_items: StorageData, cb?: () => void) => cb?.()),
        remove: vi.fn((_k: string, cb?: () => void) => cb?.()),
      },
    },
  }
}

const VALID_CA = "TokenABC1111111111111111111111111111111"
const OTHER_CA = "TokenXYZ9999999999999999999999999999999"

const FRESH_DATA = {
  risk: "SAFE",
  score: 920,
  flags: [],
  confidence: 1,
  sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
} as unknown as import("../shared/types").ScanResponseData

describe("handleRescanDone", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scanCache.clear()
    state.lastCA = VALID_CA
    state.manuallyDismissed = false
    state.enabled = true
    // Reset chrome global
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({
      [FRESH_SCAN_KEY]: { ca: VALID_CA, data: FRESH_DATA, ts: Date.now() },
    })
  })

  // ── Guard conditions ──────────────────────────────────────────────────

  it("no-op when ca is empty", () => {
    handleRescanDone("")
    expect(scan).not.toHaveBeenCalled()
    expect(evictCached).not.toHaveBeenCalled()
  })

  it("no-op when ca does not match state.lastCA", () => {
    handleRescanDone(OTHER_CA)
    expect(scan).not.toHaveBeenCalled()
    expect(evictCached).not.toHaveBeenCalled()
  })

  it("no-op when overlay was manually dismissed", () => {
    state.manuallyDismissed = true
    handleRescanDone(VALID_CA)
    expect(scan).not.toHaveBeenCalled()
    expect(evictCached).not.toHaveBeenCalled()
  })

  // ── Happy path: fresh result in storage ──────────────────────────────

  it("warms the scanCache with the stored result", () => {
    handleRescanDone(VALID_CA)
    expect(scanCache.get(VALID_CA)?.data).toEqual(FRESH_DATA)
  })

  it("calls saveToLS with the stored result and null session", () => {
    handleRescanDone(VALID_CA)
    expect(saveToLS).toHaveBeenCalledWith(VALID_CA, FRESH_DATA, null)
  })

  it("resets state.lastCA to '' so scan() does not short-circuit", () => {
    handleRescanDone(VALID_CA)
    // lastCA is reset synchronously inside the storage callback
    // (chrome mock calls callback synchronously in tests)
    expect(state.lastCA).toBe("")
  })

  it("calls scan(ca) after warming the cache", () => {
    handleRescanDone(VALID_CA)
    expect(scan).toHaveBeenCalledWith(VALID_CA)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it("does NOT call evictCached on the happy path", () => {
    handleRescanDone(VALID_CA)
    expect(evictCached).not.toHaveBeenCalled()
  })

  // ── Root-cause regression: server cache bypass ────────────────────────

  it("REGRESSION: scan() is called after warming cache, not a cold re-fetch", () => {
    // The bug: handleRescanDone called scan(ca) WITHOUT warming the cache,
    // so the content script re-fetched from the API → Redis returned the
    // old verdict. With the fix, the cache is warm when scan() runs.
    handleRescanDone(VALID_CA)

    // scanCache must be warm BEFORE scan() is called. Since the chrome
    // mock is synchronous, this ordering is guaranteed — scan() is called
    // after the storage callback completes.
    expect(scanCache.has(VALID_CA)).toBe(true)
    expect(scan).toHaveBeenCalled()
  })

  // ── Fallback: storage miss or stale result ────────────────────────────

  it("falls back to evictCached + scan when storage has no entry", () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({}) // empty storage
    handleRescanDone(VALID_CA)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })

  it("falls back when stored result CA does not match", () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({
      [FRESH_SCAN_KEY]: { ca: OTHER_CA, data: FRESH_DATA, ts: Date.now() },
    })
    handleRescanDone(VALID_CA)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })

  it(`falls back when stored result is older than ${FRESH_SCAN_TTL_MS}ms`, () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({
      [FRESH_SCAN_KEY]: { ca: VALID_CA, data: FRESH_DATA, ts: Date.now() - FRESH_SCAN_TTL_MS - 1 },
    })
    handleRescanDone(VALID_CA)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })

  it("falls back when stored data field is null", () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({
      [FRESH_SCAN_KEY]: { ca: VALID_CA, data: null, ts: Date.now() },
    })
    handleRescanDone(VALID_CA)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
  })

  it("falls back when ts is missing from stored entry", () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({
      [FRESH_SCAN_KEY]: { ca: VALID_CA, data: FRESH_DATA }, // no ts
    })
    handleRescanDone(VALID_CA)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  it("handles corrupted storage gracefully (non-object value)", () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({
      [FRESH_SCAN_KEY]: "not-an-object",
    })
    // Should not throw, should fall back cleanly
    expect(() => handleRescanDone(VALID_CA)).not.toThrow()
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })

  it("does not update scanCache on the fallback path", () => {
    ;(globalThis as Record<string, unknown>).chrome = makeChromeMock({})
    handleRescanDone(VALID_CA)
    expect(scanCache.has(VALID_CA)).toBe(false)
  })
})
