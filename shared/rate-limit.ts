/**
 * Sliding-window rate limiter, persisted to chrome.storage.local.
 *
 * Why persisted: the previous in-memory implementation reset on every
 * page reload (F5 in a content-script, or service-worker recycle in
 * background.ts). A user could spam the API simply by refreshing —
 * the server-side Upstash limiter still caught most of it, but the
 * client-side throttle was effectively decorative. With persistence,
 * the window survives page reloads / SW recycles inside the same
 * browser profile.
 *
 * The state is per-storage-key, so multiple limiters (different
 * `storageKey` constructor args) coexist without collision. The
 * shared scanRateLimiter at the bottom is the only production caller
 * today, but the class is designed to support a per-action limiter
 * (e.g. one for /api/feedback, another for /api/graph) without
 * touching the persistence layer.
 *
 * Trade-off vs the previous design: every tryAcquire() now does a
 * chrome.storage.local get + set. On modern Chrome that's a sub-
 * millisecond operation in MV3, and we only acquire on user-initiated
 * scans (not on every keystroke), so the perf cost is invisible. In
 * exchange we get F5-resistant, SW-recycle-resistant rate limiting.
 *
 * Test-env fallback: when chrome.storage isn't available (vitest
 * environment: 'node'), the limiter silently degrades to in-memory
 * state. This keeps the unit tests fast without needing a chrome mock
 * per call — see the `_memoryFallback` private field. The fallback
 * is only used when chrome.storage throws, never as the primary path.
 */

import { config } from "./config"

interface StorageGetCallback {
  (items: Record<string, unknown>): void
}

interface StorageSetCallback {
  (): void
}

interface StorageLike {
  get: (keys: string | string[], cb: StorageGetCallback) => void
  set: (items: Record<string, unknown>, cb?: StorageSetCallback) => void
}

function getChromeStorage(): StorageLike | null {
  try {
    // chrome may be undefined in vitest's `node` environment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (globalThis as any).chrome
    if (c?.storage?.local && typeof c.storage.local.get === "function") {
      return c.storage.local as StorageLike
    }
  } catch {
    // Access can throw in restricted contexts (extension worker not
    // yet bootstrapped). Caller falls back to memory.
  }
  return null
}

export class RateLimiter {
  // In-memory fallback used when chrome.storage isn't reachable
  // (tests, restricted contexts). Mirrors the persisted shape.
  private _memoryFallback: number[] = []

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    /**
     * chrome.storage.local key. Default covers the single production
     * use-case; callers needing distinct limiters pass a unique
     * value (e.g. "antares_rl_feedback").
     */
    private readonly storageKey: string = "antares_rl_scan",
  ) {}

  private async readTimestamps(): Promise<number[]> {
    const storage = getChromeStorage()
    if (!storage) return [...this._memoryFallback]
    return new Promise((resolve) => {
      try {
        storage.get([this.storageKey], (v) => {
          const arr = v?.[this.storageKey]
          resolve(Array.isArray(arr) ? (arr as number[]) : [])
        })
      } catch {
        resolve([...this._memoryFallback])
      }
    })
  }

  private async writeTimestamps(ts: number[]): Promise<void> {
    this._memoryFallback = [...ts]
    const storage = getChromeStorage()
    if (!storage) return
    return new Promise((resolve) => {
      try {
        storage.set({ [this.storageKey]: ts }, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   * Persists the updated window to chrome.storage on each call so the
   * limit survives F5 and SW recycles.
   */
  async tryAcquire(): Promise<boolean> {
    const now = Date.now()
    const previous = await this.readTimestamps()
    const live = previous.filter((t) => now - t < this.windowMs)
    if (live.length >= this.maxRequests) {
      // Write the filtered list anyway so old entries get garbage-
      // collected over time. Caller learns it's rate-limited but the
      // storage layer doesn't grow unbounded.
      if (live.length !== previous.length) await this.writeTimestamps(live)
      return false
    }
    live.push(now)
    await this.writeTimestamps(live)
    return true
  }

  /**
   * Returns the number of milliseconds until the next request is allowed.
   * Returns 0 if a request can be made immediately.
   */
  async getRetryAfterMs(): Promise<number> {
    const now = Date.now()
    const live = (await this.readTimestamps()).filter(
      (t) => now - t < this.windowMs,
    )
    if (live.length < this.maxRequests) return 0
    const oldest = live[0]
    return oldest + this.windowMs - now
  }

  /** Test-only — clear both layers. Production callers should never need this. */
  async _resetForTests(): Promise<void> {
    this._memoryFallback = []
    const storage = getChromeStorage()
    if (!storage) return
    return new Promise((resolve) => {
      try {
        storage.set({ [this.storageKey]: [] }, () => resolve())
      } catch {
        resolve()
      }
    })
  }
}

// Use centralized config values for rate limiting
export const scanRateLimiter = new RateLimiter(
  config.rateLimitMaxScans,
  config.rateLimitWindowMs,
)
