// __tests__/session-handler.test.ts
//
// Unit tests for the chrome.storage.onChanged session-token handler.
// Pin the behaviour that the account-switch bug exposed: an in-flight
// /api/scan authenticated with the previous session token MUST be
// aborted before the new scan fires, otherwise the late-landing old
// response overwrites the freshly-rendered new-tier overlay.

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock all the side-effect modules BEFORE importing session-handler
// so the imports inside it resolve to our spies, not the real ones.
vi.mock("../contents/modules/cache", () => ({
  clearAllScanCache: vi.fn(),
  hydrateCacheFromLS: vi.fn(),
  getCached: vi.fn(),
  saveToLS: vi.fn(),
}))

vi.mock("../contents/modules/scanner", () => ({
  scan: vi.fn().mockResolvedValue(undefined),
  scheduleRescanIfPriceCrash: vi.fn(),
  isValid: vi.fn(),
  QuotaExhaustedError: class QuotaExhaustedError extends Error {},
}))

vi.mock("../contents/modules/address-detector", () => ({
  poll: vi.fn(),
  setupNavListeners: vi.fn(),
  cleanupNavListeners: vi.fn(),
  getInitialDelay: vi.fn(() => 0),
}))

// state is a singleton — we manipulate it directly in each test rather
// than mocking it. import after the vi.mock calls above so the modules
// session-handler imports are stubbed.
import { state } from "../contents/modules/state"
import { handleSessionTokenChange } from "../contents/modules/session-handler"
import { clearAllScanCache } from "../contents/modules/cache"
import { scan } from "../contents/modules/scanner"
import { poll } from "../contents/modules/address-detector"

describe("handleSessionTokenChange", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the shared state singleton to a known baseline before each
    // test. Tests that need a different baseline should override here.
    state.enabled = true
    state.lastCA = ""
    state.currentScanController = null
    state.manuallyDismissed = false
  })

  it("is a no-op when the extension is toggled off", () => {
    state.enabled = false
    state.lastCA = "TokenAAA1111111111111111111111111111111"

    handleSessionTokenChange()

    expect(clearAllScanCache).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
    expect(poll).not.toHaveBeenCalled()
  })

  it("clears manuallyDismissed so the overlay can re-appear after sign-in/out", () => {
    state.manuallyDismissed = true
    state.lastCA = "TokenAAA1111111111111111111111111111111"

    handleSessionTokenChange()

    expect(state.manuallyDismissed).toBe(false)
  })

  it("aborts the in-flight scan controller and nulls it", () => {
    const controller = new AbortController()
    const abortSpy = vi.spyOn(controller, "abort")
    state.currentScanController = controller
    state.lastCA = "TokenAAA1111111111111111111111111111111"

    handleSessionTokenChange()

    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(state.currentScanController).toBeNull()
  })

  it("clears the scan cache before triggering the silent rescan", () => {
    state.lastCA = "TokenAAA1111111111111111111111111111111"

    handleSessionTokenChange()

    expect(clearAllScanCache).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith("TokenAAA1111111111111111111111111111111", { silent: true })
    expect(poll).not.toHaveBeenCalled()
  })

  it("falls through to poll() when no CA is currently displayed", () => {
    state.lastCA = ""

    handleSessionTokenChange()

    expect(clearAllScanCache).toHaveBeenCalledTimes(1)
    expect(scan).not.toHaveBeenCalled()
    expect(poll).toHaveBeenCalledTimes(1)
  })

  // ─── REGRESSION TESTS ───────────────────────────────────────────────
  // The bugs that prompted this module's extraction.

  it("REGRESSION: account-switch — both fires must abort + re-scan", () => {
    // Scenario: user is on a DexScreener token page with an in-flight
    // scan when they log out, then log in to a different account. The
    // listener fires twice in quick succession.
    state.lastCA = "TokenAAA1111111111111111111111111111111"

    // First fire: logout. There's a scan in flight from initial page
    // load that's still authenticated with the OLD session token.
    const controllerA = new AbortController()
    const abortSpyA = vi.spyOn(controllerA, "abort")
    state.currentScanController = controllerA

    handleSessionTokenChange()

    expect(abortSpyA).toHaveBeenCalledTimes(1)
    expect(state.currentScanController).toBeNull()
    expect(scan).toHaveBeenCalledTimes(1)

    // Simulate the silent rescan we just kicked off wiring up its own
    // controller, as the real scan() function does.
    const controllerB = new AbortController()
    const abortSpyB = vi.spyOn(controllerB, "abort")
    state.currentScanController = controllerB

    // Second fire: login (as new account). The scan from the logout is
    // still in flight; it MUST be aborted, otherwise it would land last
    // with anonymous data and overwrite the new account's Pro overlay.
    handleSessionTokenChange()

    expect(abortSpyB).toHaveBeenCalledTimes(1)
    expect(state.currentScanController).toBeNull()
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan).toHaveBeenLastCalledWith("TokenAAA1111111111111111111111111111111", { silent: true })
  })

  it("REGRESSION: drops nothing when no controller is in flight", () => {
    // First scan on the page, no previous scan running. The handler
    // must still clear the cache and start the scan, not return early
    // because state.currentScanController is null.
    state.lastCA = "TokenAAA1111111111111111111111111111111"
    state.currentScanController = null

    handleSessionTokenChange()

    expect(clearAllScanCache).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith("TokenAAA1111111111111111111111111111111", { silent: true })
  })
})
