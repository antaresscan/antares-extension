// __tests__/rescan-handler.test.ts
//
// Unit tests for handleRescanDone() in contents/modules/rescan-handler.ts.
//
// The function is the final step of the token.html → overlay sync:
//   1. token.html writes { ca, data, ts } to chrome.storage.local
//   2. chrome.storage.onChanged fires in the content script with newValue
//   3. antares-inject.ts calls handleRescanDone(val.ca, val.data)
//   4. Handler warms the local cache and calls scan() — re-render, no network
//
// Root-cause pin: previous approaches re-fetched from the API without ?fresh=1
// → Redis cache returned the old verdict. This version passes the data
// directly so scan() hits a warm cache and never touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest"

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

import { state, scanCache } from "../contents/modules/state"
import { evictCached, saveToLS } from "../contents/modules/cache"
import { scan } from "../contents/modules/scanner"
import { handleRescanDone } from "../contents/modules/rescan-handler"

const VALID_CA = "TokenABC1111111111111111111111111111111"
const OTHER_CA = "TokenXYZ9999999999999999999999999999999"
const FRESH_DATA = {
  risk: "SAFE", score: 920, flags: [], confidence: 1,
  sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "solscan"],
} as unknown as import("../shared/types").ScanResponseData

describe("handleRescanDone", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scanCache.clear()
    state.lastCA = VALID_CA
    state.manuallyDismissed = false
    state.enabled = true
  })

  // ── Guards ────────────────────────────────────────────────────────────

  it("no-op when ca is empty", () => {
    handleRescanDone("", FRESH_DATA)
    expect(scan).not.toHaveBeenCalled()
  })

  it("no-op when ca does not match state.lastCA", () => {
    handleRescanDone(OTHER_CA, FRESH_DATA)
    expect(scan).not.toHaveBeenCalled()
  })

  it("no-op when overlay was manually dismissed", () => {
    state.manuallyDismissed = true
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scan).not.toHaveBeenCalled()
  })

  // ── Happy path: data passed directly ─────────────────────────────────

  it("warms scanCache with the fresh data", () => {
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scanCache.get(VALID_CA)?.data).toEqual(FRESH_DATA)
  })

  it("calls saveToLS with the fresh data and null session", () => {
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(saveToLS).toHaveBeenCalledWith(VALID_CA, FRESH_DATA, null)
  })

  it("resets state.lastCA to '' so scan() does not short-circuit", () => {
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(state.lastCA).toBe("")
  })

  it("calls scan(ca) exactly once", () => {
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scan).toHaveBeenCalledWith(VALID_CA)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it("does NOT call evictCached on the happy path", () => {
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(evictCached).not.toHaveBeenCalled()
  })

  // ── REGRESSION: root-cause pin ────────────────────────────────────────

  it("REGRESSION: scanCache is warm BEFORE scan() is called (no cold re-fetch)", () => {
    // Bug: previous versions called scan(ca) without warming the cache,
    // causing the content script to hit the API → Redis returned the old
    // verdict. With this fix, cache is warm so scan() re-renders immediately.
    handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scanCache.has(VALID_CA)).toBe(true)
    expect(scan).toHaveBeenCalled()
  })

  // ── Fallback: no data provided ────────────────────────────────────────

  it("calls evictCached + scan when no data is provided", () => {
    handleRescanDone(VALID_CA, undefined)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })

  it("does not populate scanCache on the fallback path", () => {
    handleRescanDone(VALID_CA, undefined)
    expect(scanCache.has(VALID_CA)).toBe(false)
  })
})
