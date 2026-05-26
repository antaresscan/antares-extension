// __tests__/rate-limit-persistent.test.ts
//
// Pins the persistent-rate-limiter contract. The previous in-memory
// implementation reset on F5; the new one survives reloads by writing
// the window to chrome.storage.local on each acquire. This test
// exercises both code paths:
//
//   1. With a chrome.storage mock — verifies persistence behaviour
//      (a second limiter instance sees the prior instance's writes).
//   2. Without chrome (vitest's `node` env) — verifies the in-memory
//      fallback works so the unit tests don't all need a storage mock.

import { describe, it, expect, beforeEach } from "vitest"

import { RateLimiter } from "../shared/rate-limit"

interface MockStore {
  data: Record<string, unknown>
}

function installChromeStorageMock(): MockStore {
  const store: MockStore = { data: {} }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: (
          keys: string | string[],
          cb: (v: Record<string, unknown>) => void,
        ) => {
          const keyArr = Array.isArray(keys) ? keys : [keys]
          const out: Record<string, unknown> = {}
          for (const k of keyArr) {
            if (k in store.data) out[k] = store.data[k]
          }
          cb(out)
        },
        set: (
          items: Record<string, unknown>,
          cb?: () => void,
        ) => {
          Object.assign(store.data, items)
          cb?.()
        },
      },
    },
  }
  return store
}

function uninstallChromeStorageMock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).chrome = undefined
}

describe("RateLimiter — in-memory fallback (no chrome.storage)", () => {
  beforeEach(() => {
    uninstallChromeStorageMock()
  })

  it("allows up to maxRequests, then refuses", async () => {
    const rl = new RateLimiter(3, 60_000, "antares_rl_test_mem")
    expect(await rl.tryAcquire()).toBe(true)
    expect(await rl.tryAcquire()).toBe(true)
    expect(await rl.tryAcquire()).toBe(true)
    expect(await rl.tryAcquire()).toBe(false)
  })

  it("getRetryAfterMs returns 0 when slot is free", async () => {
    const rl = new RateLimiter(3, 60_000, "antares_rl_test_mem")
    expect(await rl.getRetryAfterMs()).toBe(0)
  })

  it("getRetryAfterMs returns positive ms when at cap", async () => {
    const rl = new RateLimiter(2, 60_000, "antares_rl_test_mem")
    await rl.tryAcquire()
    await rl.tryAcquire()
    const wait = await rl.getRetryAfterMs()
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(60_000)
  })
})

describe("RateLimiter — chrome.storage backing (survives F5)", () => {
  let store: MockStore

  beforeEach(() => {
    store = installChromeStorageMock()
  })

  it("persists acquired timestamps to storage", async () => {
    const rl = new RateLimiter(5, 60_000, "antares_rl_test_persist_1")
    await rl.tryAcquire()
    await rl.tryAcquire()
    const stored = store.data["antares_rl_test_persist_1"]
    expect(Array.isArray(stored)).toBe(true)
    expect((stored as number[]).length).toBe(2)
  })

  it("a fresh instance picks up the previous instance's state (F5 simulation)", async () => {
    // Round 1: instance A burns 3/3 budget
    const a = new RateLimiter(3, 60_000, "antares_rl_test_persist_2")
    expect(await a.tryAcquire()).toBe(true)
    expect(await a.tryAcquire()).toBe(true)
    expect(await a.tryAcquire()).toBe(true)
    expect(await a.tryAcquire()).toBe(false)

    // Simulate F5 — drop A entirely, build a new B over the same key
    const b = new RateLimiter(3, 60_000, "antares_rl_test_persist_2")
    // B sees A's writes, so first call is already at cap → refused
    expect(await b.tryAcquire()).toBe(false)
  })

  it("filters out entries older than the window on every read", async () => {
    const rl = new RateLimiter(5, 1_000, "antares_rl_test_persist_3")
    // Inject stale entries directly into storage to simulate aged state
    store.data["antares_rl_test_persist_3"] = [Date.now() - 60_000]
    expect(await rl.tryAcquire()).toBe(true)
    // The stale entry should have been removed when the new one was
    // appended.
    const after = store.data["antares_rl_test_persist_3"] as number[]
    expect(after.length).toBe(1)
    expect(after[0]).toBeGreaterThan(Date.now() - 100)
  })

  it("isolates limiters by storageKey", async () => {
    const a = new RateLimiter(2, 60_000, "antares_rl_test_persist_iso_a")
    const b = new RateLimiter(2, 60_000, "antares_rl_test_persist_iso_b")
    // Burn A's budget; B should be untouched
    await a.tryAcquire()
    await a.tryAcquire()
    expect(await a.tryAcquire()).toBe(false)
    expect(await b.tryAcquire()).toBe(true)
    expect(await b.tryAcquire()).toBe(true)
  })

  it("ignores corrupted storage values gracefully", async () => {
    // Storage somehow ended up with a non-array under our key (older
    // build wrote a different shape, manual edit, etc.). The limiter
    // should treat it as an empty window rather than crash.
    store.data["antares_rl_test_persist_corrupt"] = "not-an-array"
    const rl = new RateLimiter(3, 60_000, "antares_rl_test_persist_corrupt")
    expect(await rl.tryAcquire()).toBe(true)
  })
})
