/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// The liquidity figure of the overlay's footer line ($4.36M) was the only figure of the card set in IBM Plex Mono; everything else is Bebas Neue (2026-10-15). It is Bebas Neue
// now, in the same colours as before (green above $50K, red under $5K, white between). The dash of a liquidity nobody could read, and the check marks and dashes of the
// other four cells, are untouched.

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache, resetSourceGap } = await import("../contents/modules/state")
const { SHADOW_CSS } = await import("../contents/modules/styles")

const CA = "So1anaTokenAddressForTests11111111111111111"
const T = 1_800_000_000_000

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 500, risk: "DANGER", flags: [], pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 36_900, marketCap: 13_300_000, priceUsd: 0.37, liquidity: 4_360_000, tokenSymbol: "CARDS", tokenName: "Cards Collector Crypt", safeBlocked: false,
  mintAuthority: false, freezeAuthority: false, lpBurned: false, lpLocked: false, honeypot: false,
  freshForSec: 300, staleLeftSec: 1200, fetchedAt: Date.now(), ...over,
}) as unknown as ScanResponseData

let store: Map<string, unknown>
const fetchMock = vi.fn()
const sendMessage = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => { cb?.({ ok: true }); return Promise.resolve() })

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
  vi.stubGlobal("chrome", { storage: { local }, runtime: { lastError: undefined, sendMessage } })
}
const quotaHeaders = (tier: string) => new Headers({
  "X-Antares-Quota-Tier": tier, "X-Antares-Quota-Used": "3", "X-Antares-Quota-Limit": "-1", "X-Antares-Quota-Remaining": "-1", "X-Antares-Quota-Reset": "0",
})
const answer = (body: unknown, tier: string) => Promise.resolve({ ok: true, status: 200, headers: quotaHeaders(tier), json: () => Promise.resolve(body) })
/** The mark in the Liq cell (the last of the five) and in the other four. */
const liqB = () => state.shadow?.querySelector(".ss .si:last-child b") as HTMLElement | null
const otherBs = () => [...(state.shadow?.querySelectorAll(".ss .si:not(:last-child) b") ?? [])] as HTMLElement[]

beforeEach(() => {
  vi.useFakeTimers({ now: T })
  installChrome()
  sendMessage.mockClear()
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

const rule = (selector: string): string | null => {
  const at = SHADOW_CSS.indexOf(selector + " {")
  return at < 0 ? null : SHADOW_CSS.slice(at + selector.length + 2, SHADOW_CSS.indexOf("}", at))
}

describe("the liquidity figure, in the CSS", () => {
  it("is Bebas Neue, like the rest of the card", () => {
    const r = rule(".si b.liq")
    expect(r, "the .si b.liq rule").not.toBeNull()
    expect(r).toMatch(/font-family:\s*'Bebas Neue'/)
    expect(r).not.toMatch(/IBM Plex Mono/)
    expect(r).toMatch(/font-size:\s*11px/) // 12px was a touch too big next to the 9px labels (2026-10-15)
  })

  it("the other marks of the line keep their face: the dashes stay the same dash (IBM Plex Mono), the ticks and crosses are drawn shapes", () => {
    expect(rule(".si b")).toMatch(/font-family:\s*'IBM Plex Mono'/)
    expect(rule(".si b.ok")).not.toMatch(/Bebas/)
    expect(rule(".si b.no")).not.toMatch(/Bebas/)
  })

  it("its colours are the ones it had: green, red, amber", () => {
    expect(rule(".si b.y")).toMatch(/#00e5b0/)
    expect(rule(".si b.n")).toMatch(/#ff5f5f/)
  })
})

describe("the liquidity figure, in the overlay", () => {
  for (const tier of ["pro", "free"] as const) {
    it.each([
      [4_360_000, "liq y", "$4.36M"],
      [267_900, "liq y", "$267.9K"],
      [21_400, "liq", "$21.4K"],
      [3_200, "liq n", "$3.2K"],
    ])(`${tier} | liquidity %d: class "%s", shown as %s`, async (liquidity, cls, text) => {
      fetchMock.mockImplementation(() => answer(data({ liquidity, ...(tier === "free" ? { proLocked: true } : {}) }), tier))
      await scan(CA)
      expect(liqB()?.getAttribute("class")).toBe(cls)
      expect(liqB()?.textContent).toBe(text)
    })
  }

  it("a liquidity nobody could read is the little dash, not a Bebas figure", async () => {
    fetchMock.mockImplementation(() => answer(data({ liquidity: null }), "pro"))
    await scan(CA)
    expect(liqB()?.textContent).toBe("—")
    expect(liqB()?.classList.contains("liq")).toBe(false)
  })

  it("the other four cells are not touched: none of them carries the class", async () => {
    fetchMock.mockImplementation(() => answer(data({ mintAuthority: true, lpBurned: true }), "pro"))
    await scan(CA)
    expect(otherBs()).toHaveLength(4)
    for (const b of otherBs()) expect(b.classList.contains("liq")).toBe(false)
  })

  it("the Limited data card keeps its liquidity figure, in the same face", async () => {
    fetchMock.mockImplementation(() => answer(data({ degraded: true, sourceGap: true, freshForSec: 30, staleLeftSec: 0 }), "pro"))
    await scan(CA)
    expect(liqB()?.getAttribute("class")).toBe("liq y")
    expect(liqB()?.textContent).toBe("$4.36M")
  })
})

// ─── The line of the footer (2026-10-16) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The figure sat at a different height depending on its colour and next to a cross or a check: the green one was pushed 1.5px down, the white and red ones not (2px above
// the checks and 4px above the cross), and the cross was 1.8px under the checks. Measured in real Chromium, at 8x pixels and at the usual screen scalings (the gallery of the
// Liq demo): now the check, the cross, the dash and the figure share one line, within half a pixel. happy-dom has no layout, so what is pinned here is the CSS that makes it:
// one push for the figure whatever its colour, one for the dash, the cross brought up to the checks.
describe("the line of the footer", () => {
  it("the colour of the figure moves nothing: the colour classes carry a colour and no position", () => {
    for (const cls of [".si b.y", ".si b.n", ".si b.w"]) {
      expect(rule(cls), cls).not.toBeNull()
      expect(rule(cls), cls).not.toMatch(/\btop\s*:|position\s*:|margin|padding|transform/)
    }
  })

  it("the figure has ONE push, the same for every colour", () => {
    expect(rule(".si b.liq")).toMatch(/position:\s*relative/)
    expect(rule(".si b.liq")).toMatch(/top:\s*1\.3px/)
  })

  // The dash used to be a letter (an em dash in the card's mono face, pushed 1.3px down). A glyph is rounded to whole device pixels on its own, so at 150 % screen scaling it landed
  // up to one device pixel off the line of the drawn marks (measured in real Chromium by scripts/overlay-alignment.mjs). It is now drawn like the check and the cross: a bar in the
  // same 12x12 box, with no push of its own and no dependence on a font.
  it("the dash is a DRAWN mark in the same 12x12 box as the check and the cross, the same everywhere (the cells and the Liq cell)", () => {
    const box = rule(".si b.dash")
    expect(box).toMatch(/display:\s*inline-flex/)
    expect(box).toMatch(/width:\s*12px/)
    expect(box).toMatch(/height:\s*12px/)
    expect(box).toMatch(/position:\s*relative/)
    expect(box).toMatch(/font-size:\s*0/)
    expect(box, "no push of its own: the bar sits inside the box, like the tick and the cross").not.toMatch(/\btop\s*:/)
    const bar = rule(".si b.dash::before")
    expect(bar).not.toBeNull()
    expect(bar).toMatch(/content:\s*''/)
    expect(bar).toMatch(/position:\s*absolute/)
    expect(bar).toMatch(/height:\s*1px/)
    expect(bar).toMatch(/background:\s*currentColor/)
  })

  it("the cross is brought up to the line of the checks (it was pushed 1.5px down), the check is not moved", () => {
    expect(rule(".si b.no")).toMatch(/top:\s*-\.1px/)
    expect(rule(".si b.no")).not.toMatch(/top:\s*1\.5px/)
    expect(rule(".si b.ok")).not.toMatch(/\btop\s*:/)
  })

  it("the dash is drawn the same way in the check cells, in the LP cell and in the Liq cell: one class", async () => {
    fetchMock.mockImplementation(() => answer(data({ liquidity: null, honeypot: null, lpBurned: null, lpLocked: null }), "pro"))
    await scan(CA)
    const dashes = [...(state.shadow?.querySelectorAll(".ss .si b.dash") ?? [])]
    expect(dashes.length).toBeGreaterThanOrEqual(2)
    for (const d of dashes) expect(d.textContent).toBe("\u2014")
    expect(liqB()?.classList.contains("dash")).toBe(true)
  })
})
