/* @vitest-environment happy-dom */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { setupNavListeners, cleanupNavListeners } from "../contents/modules/address-detector"

// Audit flagged the previous setupNavListeners as a permanent leak: the
// MutationObserver was never disconnected and history.pushState /
// replaceState were wrapped without saving the originals, so toggling the
// extension or re-injecting the content script accumulated wrappers and
// observers on every navigation. These tests pin down the new lifecycle:
// setup is idempotent and cleanup truly restores the host page.

describe("setupNavListeners / cleanupNavListeners", () => {
  let originalPushState: typeof history.pushState
  let originalReplaceState: typeof history.replaceState

  beforeEach(() => {
    // Snapshot the pristine history APIs before any setup, so each test
    // starts from a clean baseline regardless of test ordering.
    originalPushState = history.pushState
    originalReplaceState = history.replaceState
    cleanupNavListeners()  // ensure no leftover state from a prior test
  })

  afterEach(() => {
    cleanupNavListeners()
    // Belt-and-braces: force-restore in case a test bypasses cleanup.
    history.pushState = originalPushState
    history.replaceState = originalReplaceState
  })

  it("wraps history.pushState and history.replaceState on setup", () => {
    setupNavListeners()
    expect(history.pushState).not.toBe(originalPushState)
    expect(history.replaceState).not.toBe(originalReplaceState)
  })

  it("restores the original history APIs on cleanup", () => {
    setupNavListeners()
    cleanupNavListeners()
    expect(history.pushState).toBe(originalPushState)
    expect(history.replaceState).toBe(originalReplaceState)
  })

  it("is idempotent — second setup does not re-wrap an already-wrapped pushState", () => {
    setupNavListeners()
    const wrappedFirst = history.pushState
    setupNavListeners()  // would have stacked another wrapper before this PR
    expect(history.pushState).toBe(wrappedFirst)
  })

  it("a setup → cleanup → setup cycle ends with a single wrap, not two", () => {
    setupNavListeners()
    cleanupNavListeners()
    setupNavListeners()

    // After the second setup, calling cleanup once must fully restore.
    cleanupNavListeners()
    expect(history.pushState).toBe(originalPushState)
    expect(history.replaceState).toBe(originalReplaceState)
  })

  it("cleanup is safe to call when nothing is installed", () => {
    // No setup was called — cleanup must not throw and must not modify the
    // history APIs.
    expect(() => cleanupNavListeners()).not.toThrow()
    expect(history.pushState).toBe(originalPushState)
    expect(history.replaceState).toBe(originalReplaceState)
  })

  it("calling the wrapped pushState still calls the original (no chained wrapping after cycle)", () => {
    let originalCallCount = 0
    const trackedOriginal = function trackedPushState(
      this: History,
      ...args: Parameters<typeof history.pushState>
    ) {
      originalCallCount++
      return originalPushState.apply(this, args)
    }
    history.pushState = trackedOriginal

    setupNavListeners()
    history.pushState({}, "", "/test1")
    expect(originalCallCount).toBe(1)

    cleanupNavListeners()
    // After cleanup, history.pushState should be `trackedOriginal` again.
    expect(history.pushState).toBe(trackedOriginal)

    history.pushState({}, "", "/test2")
    expect(originalCallCount).toBe(2)

    // Restore for other tests
    history.pushState = originalPushState
  })
})
