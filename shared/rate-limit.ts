/**
 * Simple sliding-window rate limiter for the extension.
 * Prevents excessive API calls from content scripts or popup.
 */
export class RateLimiter {
  private timestamps: number[] = []

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {}

  /**
   * Returns true if the request is allowed, false if rate-limited.
   */
  tryAcquire(): boolean {
    const now = Date.now()
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs)
    if (this.timestamps.length >= this.maxRequests) {
      return false
    }
    this.timestamps.push(now)
    return true
  }

  /**
   * Returns the number of milliseconds until the next request is allowed.
   * Returns 0 if a request can be made immediately.
   */
  getRetryAfterMs(): number {
    const now = Date.now()
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs)
    if (this.timestamps.length < this.maxRequests) return 0
    const oldest = this.timestamps[0]
    return oldest + this.windowMs - now
  }
}

// Default: 10 scans per 60 seconds
export const scanRateLimiter = new RateLimiter(10, 60_000)
