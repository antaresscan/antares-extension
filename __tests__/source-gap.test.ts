/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// A scan made while a data source did not answer has NO verdict for the user (contents/modules/scanner.ts + components.ts + resilience.ts). The server
// marks it `sourceGap` (Free callers included: the flags that say which source are Pro, the fact that one is missing is not). The overlay shows the
// Limited data card in the design of the others (same layout, same type, the four verdict colours mixed), with a line at its foot that counts down
// ("Source unavailable, rescanning in 24s") to the try it makes by itself; when every source answers the real verdict takes its place.
//
// Written after 2026-10-13/14: a SAFE token read CAUTION, a DANGER read SAFE, a RUG read DANGER while a source was silent, and the Free overlay said
// nothing about why. Replayed on 1 121 tokens with one source silent, the verdict a scan reaches without it is not the token's.

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache, resetSourceGap } = await import("../contents/modules/state")
const {
  SOURCE_GAP_GIVE_UP_MS, SOURCE_GAP_REPEAT_MS, SOURCE_GAP_MARGIN_MS, SOURCE_GAP_QUICK_TRIES, SOURCE_GAP_LABEL, LIMITED_DATA_LABEL, LIMITED_DATA_SUMMARY,
  sourceGapOf, sourceGapRetryAt, sourceGapText,
} = await import("../contents/modules/resilience")

const CA = "So1anaTokenAddressForTests11111111111111111"
const CA2 = "So1anaTokenAddressForTests22222222222222222"
const MIN = 60_000
const T = 1_800_000_000_000
const VERDICTS = ["SAFE", "CAUTION", "DANGER", "RUG"] as const
const VERDICT_CLASS: Record<string, string> = { SAFE: "safe", CAUTION: "caution", DANGER: "danger", RUG: "rug" }
const SCORE: Record<string, number> = { SAFE: 1000, CAUTION: 800, DANGER: 500, RUG: 100 }

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 900, risk: "SAFE", flags: [], pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000, tokenSymbol: "TKN", tokenName: "Token", lpBurned: true,
  lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false,
  freshForSec: 300, staleLeftSec: 1200, ...over,
}) as unknown as ScanResponseData

/** What the server sends for a scan made while a source was silent: marked, degraded (kept 30 s), and a verdict the overlay does not show. */
const gapped = (over: Record<string, unknown> = {}) =>
  data({ risk: "CAUTION", score: 850, degraded: true, sourceGap: true, freshForSec: 30, staleLeftSec: 0, fetchedAt: Date.now(), ...over })

// ─── the pure rules ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("sourceGapOf: when does the overlay say a source did not answer?", () => {
  // The server decides; the overlay does not second-guess it, whatever the verdict the scan reached.
  it.each(VERDICTS)("%s with the server's mark: yes", (risk) => {
    expect(sourceGapOf({ risk, sourceGap: true })).toBe(true)
  })
  it("without the mark, or with anything but true, or from an older server: no", () => {
    expect(sourceGapOf({ risk: "CAUTION" })).toBe(false)
    expect(sourceGapOf({ risk: "CAUTION", sourceGap: false })).toBe(false)
    expect(sourceGapOf({ risk: "CAUTION", sourceGap: "true" })).toBe(false)
    expect(sourceGapOf({ risk: "CAUTION", degraded: true })).toBe(false) // "degraded" alone is not enough: a token with no pool is degraded too
  })
  it("a verdict served from memory has its own line (\"Scanned 6 min ago\"): the two never share a card", () => {
    expect(sourceGapOf({ risk: "SAFE", sourceGap: true, scannedAgoSec: 360 })).toBe(false)
  })
})

describe("sourceGapRetryAt: the countdown is the time the server's own copy has left, not a guess", () => {
  it("the first try is when the server's 30 s copy is over (counted from when the answer was MADE), plus a second of margin", () => {
    const now = T + 5_000
    expect(sourceGapRetryAt({ freshForSec: 30, fetchedAt: T }, now, 0, now)).toBe(T + 30_000 + SOURCE_GAP_MARGIN_MS)
  })
  it("an answer the server held for a while has less to wait: it was made 12 s ago, 19 s are left", () => {
    const now = T + 12_000
    expect(sourceGapRetryAt({ freshForSec: 30, fetchedAt: T }, now, 0, now) - now).toBe(19_000)
  })
  it("never less than a second from now (a copy already over is not retried in the same instant)", () => {
    const now = T + 90_000
    expect(sourceGapRetryAt({ freshForSec: 30, fetchedAt: T }, now, 0, now) - now).toBe(1_000)
  })
  it("from the third try on: a minute apart, so that a source down for long is not hammered by every open tab", () => {
    expect(SOURCE_GAP_QUICK_TRIES).toBe(2)
    const d = { freshForSec: 30, fetchedAt: T }
    expect(sourceGapRetryAt(d, T, 1, T) - T).toBe(31_000)
    expect(sourceGapRetryAt(d, T, 2, T) - T).toBe(SOURCE_GAP_REPEAT_MS)
    expect(sourceGapRetryAt(d, T, 9, T) - T).toBe(SOURCE_GAP_REPEAT_MS)
  })
  it("a server that sends no window (an older one) gets the 30 s it keeps a degraded answer; a device clock far off ignores the server's date", () => {
    expect(sourceGapRetryAt({ fetchedAt: T }, T, 0, T) - T).toBe(31_000)
    expect(sourceGapRetryAt({ freshForSec: 30, fetchedAt: T - 5 * 60 * 60_000 }, T, 0, T) - T).toBe(31_000)
  })
})

describe("sourceGapText", () => {
  it("counts down, whole seconds, rounded up (never says 0s while it still waits)", () => {
    expect(sourceGapText(24_000)).toBe("Source unavailable, rescanning in 24s")
    expect(sourceGapText(23_001)).toBe("Source unavailable, rescanning in 24s")
    expect(sourceGapText(400)).toBe("Source unavailable, rescanning in 1s")
  })
  it("says \"rescanning…\" while the try is under way, and the bare label once the overlay has stopped trying", () => {
    expect(sourceGapText(0)).toBe("Source unavailable, rescanning…")
    expect(sourceGapText(-5_000)).toBe("Source unavailable, rescanning…")
    expect(sourceGapText(null)).toBe(SOURCE_GAP_LABEL)
  })
  it("fits where \"Taking longer than usual, still on it\" already fits", () => {
    expect(sourceGapText(60_000).length).toBeLessThanOrEqual("Taking longer than usual, still on it".length)
  })
})

// ─── the overlay ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let store: Map<string, unknown>
const fetchMock = vi.fn()

function installChrome() {
  store = new Map()
  const local = {
    get: (keys: string | string[] | null, cb: (items: Record<string, unknown>) => void) => {
      const list = keys === null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k))
      cb(out)
    },
    set: (items: Record<string, unknown>, cb: () => void) => { for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v)); cb() },
    remove: (keys: string[], cb: () => void) => { for (const k of keys) store.delete(k); cb() },
  }
  vi.stubGlobal("chrome", { storage: { local }, runtime: { lastError: undefined, sendMessage: () => Promise.resolve() } })
}

const quotaHeaders = (tier: string) => new Headers({
  "X-Antares-Quota-Tier": tier, "X-Antares-Quota-Used": "3", "X-Antares-Quota-Limit": "-1", "X-Antares-Quota-Remaining": "-1", "X-Antares-Quota-Reset": "0",
})
const answer = (body: unknown, tier?: string) => Promise.resolve({ ok: true, status: 200, headers: tier ? quotaHeaders(tier) : new Headers(), json: () => Promise.resolve(body) })
const httpError = (status: number) => Promise.resolve({ ok: false, status, headers: new Headers(), json: () => Promise.resolve(null) })
const text = () => state.shadow?.textContent ?? ""
/** What is written on the card itself (the shadow root also holds the style sheet, whose selectors name the verdicts). */
const cardText = () => state.boxEl?.textContent ?? ""
const q = (sel: string) => state.shadow?.querySelector(sel) ?? null
const qa = (sel: string) => [...(state.shadow?.querySelectorAll(sel) ?? [])]
const line = () => q(".source-gap")?.textContent ?? null
const callsFor = (ca: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(`ca=${ca}`)).length
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const verdictClasses = () => ["safe", "caution", "danger", "rug"].filter((c) => state.boxEl?.classList.contains(c))

beforeEach(() => {
  vi.useFakeTimers({ now: T })
  installChrome()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  scanCache.clear()
  document.documentElement.querySelector("#antares-host")?.remove()
  resetSourceGap()
  Object.assign(state, {
    host: null, shadow: null, boxEl: null, lastCA: "", manuallyDismissed: false, currentScanController: null, failureView: null,
    recoveryTimer: null, recoveryCa: "", recoveryAttempt: 0, recoveryStartedAt: 0, staleExpiryTimer: null, rescanTimer: null,
  })
})

afterEach(() => {
  resetSourceGap()
  if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ─── the Limited data card: every verdict the scan reached, Free and Pro ───────────────────────────────────────────────────────────────────

describe("the Limited data card replaces the verdict, whatever the verdict the scan reached and whatever the tier", () => {
  for (const tier of ["free", "pro"] as const) {
    for (const risk of VERDICTS) {
      it(`${tier} | the scan reached ${risk}: no verdict on screen, the card says LIMITED DATA in the design of the others, with the countdown`, async () => {
        const flags = tier === "free" ? [{ label: "Part of Antares Pro", severity: "warning", impact: 0 }] : [{ label: "Helius unavailable — holder concentration unverified", severity: "warning", impact: 0 }]
        fetchMock.mockImplementation(() => answer(gapped({ risk, score: SCORE[risk], proLocked: tier === "free", flags }), tier))
        await scan(CA)
        // the word, and nothing of the verdict
        expect(q(".vb h1")?.textContent).toBe(LIMITED_DATA_LABEL)
        expect(state.boxEl?.classList.contains("limited")).toBe(true)
        expect(verdictClasses()).toEqual([])
        expect(cardText()).not.toMatch(/\b(SAFE|CAUTION|DANGER|RUG)\b/i)
        expect(cardText()).not.toMatch(/No issues found|flags? detected|flags? —/i) // (the "Critical Flags" button is on every card)
        // the same card as the others: score area, four dots, bar, summary, checks, the three buttons
        expect(q(".ant-score")).toBeNull() // no score count-up: there is no score
        expect(q(".sr .n")?.textContent).toBe("— / 1000")
        expect(qa(".dots .dt")).toHaveLength(4)
        expect(qa(".dots .dt.lim")).toHaveLength(4)
        expect(qa(".sbar.lim i")).toHaveLength(4)
        expect(q(".sum")?.textContent).toBe(LIMITED_DATA_SUMMARY)
        expect(qa(".ss .si")).toHaveLength(5) // Sell, Mint, Freeze, LP, Liq: the checks are "—", the liquidity (public market data) is kept
        expect(qa(".ss .si b").slice(0, 3).map((b) => b.textContent)).toEqual(["—", "—", "—"])
        expect(q("#ant-critical-flags-btn")).not.toBeNull()
        expect(q("#ant-full-analysis")).not.toBeNull()
        expect(q("#ant-ai-summary-btn")).not.toBeNull()
        expect(qa(".locked")).toHaveLength(tier === "free" ? 3 : 0) // Free: the three buttons carry the PRO ghost, as on every card
        // the line and its countdown
        expect(line()).toBe("Source unavailable, rescanning in 31s")
        expect(q(".scanned-ago")).toBeNull()
        expect(state.failureView).toBeNull() // it is an answer, not a failure
      })
    }
  }

  it("the brand colour of a Pro card is kept (gold wordmark), the Limited data card does not take a verdict's", async () => {
    fetchMock.mockImplementation(() => answer(gapped({ risk: "SAFE" }), "pro"))
    await scan(CA)
    expect(q(".brand")?.classList.contains("pro")).toBe(true)
  })

  it("no mark, no Limited data: a complete verdict, a degraded one with no pool (the mark is the server's)", async () => {
    fetchMock.mockImplementation(() => answer(data({ risk: "CAUTION", degraded: true, freshForSec: 30, fetchedAt: Date.now() })))
    await scan(CA)
    expect(q(".vb h1")?.textContent).toBe("CAUTION")
    expect(line()).toBeNull()
  })

  it("a verdict served from memory keeps its own line and is not the Limited data card", async () => {
    fetchMock.mockImplementation(() => answer(gapped({ risk: "SAFE", score: 950, scannedAgoSec: 360, servedFromMemory: true })))
    await scan(CA)
    expect(q(".scanned-ago")?.textContent).toBe("Scanned 6 min ago")
    expect(line()).toBeNull()
    expect(q(".vb h1")?.textContent).toBe("SAFE")
  })

  it("the AI summary text of an incomplete scan (it talks about a verdict) is not offered; a Pro caller keeps the flags that name the silent source", async () => {
    fetchMock.mockImplementation(() => answer(gapped({ risk: "SAFE", aiSummary: "This token looks SAFE.", flags: [{ label: "Helius unavailable — holder concentration unverified", severity: "warning", impact: 0 }] }), "pro"))
    await scan(CA)
    expect(cardText()).not.toContain("This token looks SAFE")
  })
})

describe("a verdict is never shown while a source is silent, and the real one comes back with the source", () => {
  it("SAFE, then Helius goes silent, then it is back: SAFE -> LIMITED DATA -> SAFE, never CAUTION in between", async () => {
    const classes: string[] = []
    const seen = () => classes.push(state.boxEl?.classList.contains("limited") ? "limited" : verdictClasses()[0] ?? "none")
    fetchMock.mockImplementation(() => answer(data({ risk: "SAFE", score: 996, fetchedAt: Date.now() })))
    await scan(CA); seen()
    await advance(6 * MIN)
    fetchMock.mockImplementation(() => answer(gapped({ risk: "CAUTION", score: 850 }))) // what the engine alone says without Helius
    state.lastCA = ""
    await scan(CA); seen()
    fetchMock.mockImplementation(() => answer(data({ risk: "SAFE", score: 996, fetchedAt: Date.now() })))
    await advance(32_000); seen()
    expect(classes).toEqual(["safe", "limited", "safe"])
    expect(q(".sum")?.textContent).toBe("No issues found")
    expect(line()).toBeNull()
  })

  it.each(VERDICTS)("%s -> LIMITED DATA -> %s again: the verdict that comes back is the real one", async (risk) => {
    const full = () => data({ risk, score: SCORE[risk], fetchedAt: Date.now() })
    fetchMock.mockImplementation(() => answer(full()))
    await scan(CA)
    expect(state.boxEl?.classList.contains(VERDICT_CLASS[risk])).toBe(true)
    await advance(6 * MIN)
    fetchMock.mockImplementation(() => answer(gapped({ risk: "SAFE", score: 990 }))) // the engine alone, softened (a DANGER read SAFE without RugCheck)
    state.lastCA = ""
    await scan(CA)
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
    expect(verdictClasses()).toEqual([])
    fetchMock.mockImplementation(() => answer(full()))
    await advance(32_000)
    expect(state.boxEl?.classList.contains(VERDICT_CLASS[risk])).toBe(true)
    expect(state.boxEl?.classList.contains("limited")).toBe(false)
    expect(q(".vb h1")?.textContent).toMatch(new RegExp(risk === "RUG" ? "RUG" : risk))
  })

  it("the first scan of a token during the outage (nothing to compare with): Limited data too, then the verdict", async () => {
    fetchMock.mockImplementation(() => answer(gapped({ risk: "CAUTION" })))
    await scan(CA)
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
    fetchMock.mockImplementation(() => answer(data({ risk: "SAFE", score: 996, fetchedAt: Date.now() })))
    await advance(32_000)
    expect(q(".vb h1")?.textContent).toBe("SAFE")
  })
})

// ─── the countdown, and the try it makes ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the line and its countdown", () => {
  it("the number goes down second by second", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(1_000)
    expect(line()).toBe("Source unavailable, rescanning in 30s")
    await advance(9_000)
    expect(line()).toBe("Source unavailable, rescanning in 21s")
  })

  it("coming back to the token while the 30 s are not over: no request, the line shows what is left", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(10_000)
    state.lastCA = ""
    await scan(CA)
    expect(callsFor(CA)).toBe(1)
    expect(line()).toBe("Source unavailable, rescanning in 21s")
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
  })

  it("at 0 it asks again by itself; the source is back: the verdict replaces the card, the line is gone, nothing counts any more", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    fetchMock.mockImplementation(() => answer(data({ risk: "SAFE", score: 996, fetchedAt: Date.now() })))
    await advance(31_000)
    expect(line()).toBe("Source unavailable, rescanning…") // the try is under way: the card and its line stay until the answer lands
    await advance(1_000)
    expect(callsFor(CA)).toBe(2) // a real request, at the moment announced
    expect(line()).toBeNull()
    expect(state.boxEl?.classList.contains("safe")).toBe(true)
    expect(state.boxEl?.classList.contains("limited")).toBe(false)
    expect(state.gapCa).toBe("")
    expect(state.gapRetryTimer).toBeNull()
    expect(state.gapTickTimer).toBeNull()
    const calls = callsFor(CA)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(calls) // and nothing asks again
  })

  it("the source is still down: the same card is NOT redrawn (no flash, a panel the user has open stays open), only the countdown starts again", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    const card = q(".vb")
    await advance(32_000)
    expect(callsFor(CA)).toBe(2)
    expect(q(".vb")).toBe(card) // the very same node
    expect(line()).toMatch(/^Source unavailable, rescanning in \d+s$/)
  })

  it("the first two tries follow the server's copy (about 31 s apart); from the third on they are a minute apart", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(32_000)
    expect(callsFor(CA)).toBe(2)
    await advance(32_000)
    expect(callsFor(CA)).toBe(3)
    await advance(45_000)
    expect(callsFor(CA)).toBe(3)
    await advance(20_000)
    expect(callsFor(CA)).toBe(4)
  })

  it("a try that cannot reach the scanner: the card and the line stay, no error screen, and it tries again a minute later", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    fetchMock.mockImplementation(() => httpError(500))
    await advance(31_000 + 11_000)
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
    expect(text()).not.toContain("Connection failed")
    expect(q(".err-retry")).toBeNull()
    expect(state.failureView).toBeNull()
    expect(line()).toMatch(/^Source unavailable, rescanning in \d+s$/)
    fetchMock.mockImplementation(() => answer(data({ risk: "SAFE", score: 996, fetchedAt: Date.now() })))
    await advance(61_000)
    expect(line()).toBeNull()
    expect(state.boxEl?.classList.contains("safe")).toBe(true)
  })

  it("a hidden tab does not ask (the page asks again as soon as it is visible); it looks again in 10 s", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
    try {
      await advance(60_000)
      expect(callsFor(CA)).toBe(1)
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false })
    }
    await advance(11_000)
    expect(callsFor(CA)).toBe(2)
  })
})

describe("it stops when it should", () => {
  it("moving to another token ends the countdown of the previous one", async () => {
    fetchMock.mockImplementation((url: string) => answer(String(url).includes(`ca=${CA2}`) ? data({ resolvedMint: CA2 }) : gapped()))
    await scan(CA)
    expect(state.gapCa).toBe(CA)
    await scan(CA2)
    expect(state.gapCa).toBe("")
    expect(line()).toBeNull()
    const before = callsFor(CA)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(before)
  })

  it("closing the box stops it", async () => {
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    state.manuallyDismissed = true
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(1)
    expect(state.gapRetryTimer).toBeNull()
  })

  it("after 15 minutes it stops trying and the line stays, bare (a reload or a navigation starts over)", async () => {
    expect(SOURCE_GAP_GIVE_UP_MS).toBe(15 * MIN)
    fetchMock.mockImplementation(() => answer(gapped()))
    await scan(CA)
    await advance(16 * MIN)
    expect(line()).toBe("Source unavailable")
    expect(state.boxEl?.classList.contains("limited")).toBe(true) // still no verdict
    const calls = callsFor(CA)
    expect(calls).toBeGreaterThan(10)
    expect(calls).toBeLessThan(25)
    await advance(10 * MIN)
    expect(callsFor(CA)).toBe(calls)
    expect(line()).toBe("Source unavailable")
  })
})
