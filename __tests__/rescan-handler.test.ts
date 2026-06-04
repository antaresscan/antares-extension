// __tests__/rescan-handler.test.ts
//
// Unit tests for handleRescanDone() in contents/modules/rescan-handler.ts.
//
// ROOT CAUSE PINNED HERE:
//   getCached() validates that e.session === currentSession and evicts on
//   mismatch. Previous versions stored session:null. When the user is logged
//   in, null !== "their-session-token" → getCached() immediately evicts the
//   warm cache entry → scan() falls back to a cold API fetch → the server
//   Redis cache returns the OLD verdict for several more minutes.
//
//   Fix: read the current session token via readSessionToken() BEFORE storing
//   the cache entry, so getCached() always finds a matching session.

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

vi.mock("../contents/modules/session-token", () => ({
  readSessionToken: vi.fn().mockResolvedValue("test-session-token"),
}))

import { state, scanCache } from "../contents/modules/state"
import { evictCached, saveToLS } from "../contents/modules/cache"
import { scan } from "../contents/modules/scanner"
import { readSessionToken } from "../contents/modules/session-token"
import { handleRescanDone } from "../contents/modules/rescan-handler"

const VALID_CA  = "TokenABC1111111111111111111111111111111"
const OTHER_CA  = "TokenXYZ9999999999999999999999999999999"
const SESSION   = "test-session-token"
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
    vi.mocked(readSessionToken).mockResolvedValue(SESSION)
  })

  // ── Guards ────────────────────────────────────────────────────────────

  it("no-op when ca is empty", async () => {
    await handleRescanDone("", FRESH_DATA)
    expect(scan).not.toHaveBeenCalled()
  })

  it("no-op when ca does not match state.lastCA", async () => {
    await handleRescanDone(OTHER_CA, FRESH_DATA)
    expect(scan).not.toHaveBeenCalled()
  })

  it("no-op when overlay was manually dismissed", async () => {
    state.manuallyDismissed = true
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scan).not.toHaveBeenCalled()
  })

  // ── Happy path ────────────────────────────────────────────────────────

  it("reads the current session token before storing the cache entry", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(readSessionToken).toHaveBeenCalledTimes(1)
  })

  it("stores cache entry with the CURRENT session (not null)", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    // The scanCache entry must carry the real session token so getCached()
    // does not evict it on session-validation check.
    expect(scanCache.get(VALID_CA)?.session).toBe(SESSION)
  })

  it("warms scanCache with the fresh data", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scanCache.get(VALID_CA)?.data).toEqual(FRESH_DATA)
  })

  it("calls saveToLS with the fresh data and the CURRENT session", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(saveToLS).toHaveBeenCalledWith(VALID_CA, FRESH_DATA, SESSION)
  })

  it("resets state.lastCA to '' so scan() does not short-circuit", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(state.lastCA).toBe("")
  })

  it("calls scan(ca) exactly once after warming cache", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scan).toHaveBeenCalledWith(VALID_CA)
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it("does NOT call evictCached on the happy path", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(evictCached).not.toHaveBeenCalled()
  })

  // ── ROOT CAUSE REGRESSION PIN ─────────────────────────────────────────

  it("REGRESSION: cache entry has matching session so getCached() keeps it", async () => {
    // Bug: storing session:null while user is logged in caused getCached()
    // to evict the warm entry → cold API fetch → Redis returned old verdict.
    await handleRescanDone(VALID_CA, FRESH_DATA)
    const entry = scanCache.get(VALID_CA)
    expect(entry).not.toBeNull()
    expect(entry?.session).toBe(SESSION)   // must NOT be null for logged-in users
    expect(entry?.data).toEqual(FRESH_DATA)
  })

  it("REGRESSION: scanCache is warm BEFORE scan() fires", async () => {
    await handleRescanDone(VALID_CA, FRESH_DATA)
    // Cache must be set and scan must have been called
    expect(scanCache.has(VALID_CA)).toBe(true)
    expect(scan).toHaveBeenCalled()
  })

  // ── Fallback: no data ─────────────────────────────────────────────────

  it("calls evictCached + scan when no data provided", async () => {
    await handleRescanDone(VALID_CA, undefined)
    expect(evictCached).toHaveBeenCalledWith(VALID_CA)
    expect(saveToLS).not.toHaveBeenCalled()
    expect(readSessionToken).not.toHaveBeenCalled()
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })

  it("does not populate scanCache on fallback path", async () => {
    await handleRescanDone(VALID_CA, undefined)
    expect(scanCache.has(VALID_CA)).toBe(false)
  })

  // ── Edge: logged-out user (session = null) ────────────────────────────

  it("works correctly when user is not logged in (session = null)", async () => {
    vi.mocked(readSessionToken).mockResolvedValue(null)
    await handleRescanDone(VALID_CA, FRESH_DATA)
    expect(scanCache.get(VALID_CA)?.session).toBeNull()
    expect(saveToLS).toHaveBeenCalledWith(VALID_CA, FRESH_DATA, null)
    expect(scan).toHaveBeenCalledWith(VALID_CA)
  })
})
