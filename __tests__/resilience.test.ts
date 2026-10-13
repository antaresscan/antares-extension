import { describe, it, expect, vi, afterEach } from "vitest"
import {
  SCAN_BUDGET_MS, RECOVERY_DELAYS_MS, RECOVERY_GIVE_UP_MS,
  sleep, recoveryDelayMs, windowsOf, madeAtOf, staleAgeLabel, scannedAgoText, scannedAgoOf,
} from "../contents/modules/resilience"

// What the overlay does when the scanner is slow or cannot be reached (contents/modules/resilience.ts): pure rules, wired by scanner.ts.

const T = 1_800_000_000_000
const FRESH_MS = 5 * 60_000

afterEach(() => { vi.useRealTimers() })

describe("the budget and the retry calendar", () => {
  it("a scan waits 15 s at most (it used to be able to wait almost two minutes)", () => {
    expect(SCAN_BUDGET_MS).toBe(15_000)
  })

  it("after a failure: 3 s, 8 s, 15 s, 30 s, then every minute", () => {
    expect([...RECOVERY_DELAYS_MS]).toEqual([3_000, 8_000, 15_000, 30_000, 60_000])
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((n) => recoveryDelayMs(n, 0))).toEqual([3_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000])
  })

  it("it stops after a day since the first failure, and not before", () => {
    expect(RECOVERY_GIVE_UP_MS).toBe(24 * 60 * 60_000)
    expect(recoveryDelayMs(7, RECOVERY_GIVE_UP_MS - 1)).toBe(60_000)
    expect(recoveryDelayMs(7, RECOVERY_GIVE_UP_MS)).toBeNull()
    expect(recoveryDelayMs(7, RECOVERY_GIVE_UP_MS * 3)).toBeNull()
  })

  it("a negative or fractional attempt number is read as the first", () => {
    expect(recoveryDelayMs(-3, 0)).toBe(3_000)
    expect(recoveryDelayMs(1.9, 0)).toBe(8_000)
  })
})

describe("sleep: a wait between two attempts must not outlive the scan it belongs to", () => {
  it("waits the time asked", async () => {
    vi.useFakeTimers()
    let done = false
    void sleep(1500).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })

  it("ends at once when the signal aborts", async () => {
    vi.useFakeTimers()
    const ctl = new AbortController()
    let done = false
    void sleep(6000, ctl.signal).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    ctl.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  it("does not wait at all on a signal that is already aborted", async () => {
    vi.useFakeTimers()
    const ctl = new AbortController()
    ctl.abort()
    let done = false
    void sleep(6000, ctl.signal).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })
})

describe("windowsOf: the two moments an answer is good until, on this device's clock", () => {
  it("a server that sends nothing (an older one): 5 minutes, and no stale display", () => {
    const w = windowsOf({}, T, FRESH_MS)
    expect(w.freshUntil).toBe(T + FRESH_MS)
    expect(w.staleUntil).toBe(T + FRESH_MS)
  })

  it("the server's durations are used, counted from the moment the answer was received", () => {
    const w = windowsOf({ freshForSec: 300, staleLeftSec: 2700 }, T, FRESH_MS)
    expect(w.freshUntil).toBe(T + 300_000)
    expect(w.staleUntil).toBe(T + 2_700_000)
  })

  it("a degraded answer (30 s) is fresh for 30 s", () => {
    expect(windowsOf({ freshForSec: 30, staleLeftSec: 0 }, T, FRESH_MS).freshUntil).toBe(T + 30_000)
  })

  it("the server can shorten the fresh window, never stretch it past the default", () => {
    expect(windowsOf({ freshForSec: 99_999 }, T, FRESH_MS).freshUntil).toBe(T + FRESH_MS)
  })

  it("the stale window is never before the fresh one (a stale window of 0 means: not shown stale)", () => {
    const w = windowsOf({ freshForSec: 300, staleLeftSec: 0 }, T, FRESH_MS)
    expect(w.staleUntil).toBe(w.freshUntil)
    const w2 = windowsOf({ freshForSec: 300, staleLeftSec: 120 }, T, FRESH_MS)
    expect(w2.staleUntil).toBe(w2.freshUntil)
  })

  it("never more than 24 h, whatever the server says", () => {
    expect(windowsOf({ freshForSec: 300, staleLeftSec: 10 * 24 * 3600 }, T, FRESH_MS).staleUntil).toBe(T + 24 * 3600 * 1000)
  })

  it("a value that is not a non-negative number counts as absent", () => {
    for (const bad of ["300", -5, NaN, Infinity, null, undefined, {}, []]) {
      const w = windowsOf({ freshForSec: bad, staleLeftSec: bad }, T, FRESH_MS)
      expect(w.freshUntil, String(bad)).toBe(T + FRESH_MS)
      expect(w.staleUntil, String(bad)).toBe(T + FRESH_MS)
    }
  })
})

describe("madeAtOf: when the verdict was made", () => {
  it("the server's date, when the answer was held a while by its cache", () => {
    expect(madeAtOf({ fetchedAt: T - 120_000 }, T)).toBe(T - 120_000)
  })

  it("the moment it was received when the server says nothing", () => {
    expect(madeAtOf({}, T)).toBe(T)
  })

  it("a date from the future (a clock quirk) is not believed: the verdict cannot be younger than its reception", () => {
    expect(madeAtOf({ fetchedAt: T + 30_000 }, T)).toBe(T)
    expect(madeAtOf({ fetchedAt: T + 3_600_000 }, T)).toBe(T)
  })

  it("a date from more than an hour before is not believed either (the device clock is far off)", () => {
    expect(madeAtOf({ fetchedAt: T - 2 * 3_600_000 }, T)).toBe(T)
  })

  it("not a number: the moment it was received", () => {
    expect(madeAtOf({ fetchedAt: "now" }, T)).toBe(T)
    expect(madeAtOf({ fetchedAt: NaN }, T)).toBe(T)
  })
})

describe("the label under the header of a verdict shown from memory", () => {
  it("minutes, then hours, then days", () => {
    expect(staleAgeLabel(0)).toBe("less than a minute ago")
    expect(staleAgeLabel(59_999)).toBe("less than a minute ago")
    expect(staleAgeLabel(60_000)).toBe("1 min ago")
    expect(staleAgeLabel(12 * 60_000 + 40_000)).toBe("12 min ago")
    expect(staleAgeLabel(59 * 60_000)).toBe("59 min ago")
    expect(staleAgeLabel(60 * 60_000)).toBe("1 h ago")
    expect(staleAgeLabel(130 * 60_000)).toBe("2 h 10 min ago")
    expect(staleAgeLabel(25 * 3_600_000)).toBe("1 d ago")
  })

  it("never negative", () => {
    expect(staleAgeLabel(-5000)).toBe("less than a minute ago")
  })

  it("says when it was scanned, nothing more", () => {
    expect(scannedAgoText(5 * 60_000)).toBe("Scanned 5 min ago")
    expect(scannedAgoText(130 * 60_000)).toBe("Scanned 2 h 10 min ago")
    expect(scannedAgoText(10_000)).toBe("Scanned less than a minute ago")
  })
})

describe("scannedAgoOf: the age of a verdict the SERVER served from memory", () => {
  it("the seconds the server sent, for a verdict served from memory (a data source is down)", () => {
    expect(scannedAgoOf({ scannedAgoSec: 360 })).toBe(360)
    expect(scannedAgoOf({ scannedAgoSec: 0 })).toBe(0)
  })

  it("null for an ordinary answer, and for a value that is not a non-negative number", () => {
    expect(scannedAgoOf({})).toBeNull()
    for (const bad of ["360", -1, NaN, Infinity, null, undefined, {}, []]) expect(scannedAgoOf({ scannedAgoSec: bad }), String(bad)).toBeNull()
  })
})

