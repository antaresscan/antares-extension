/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ScanResponseData } from "../shared/types"

// While the card says "Limited data" no verdict is known, so its three footer buttons (Critical Flags, Full Analysis, AI Summary) do nothing. 2026-10-14: a click on
// Full Analysis opened the token page, which read the scan again and showed "SAFE" while the overlay said Limited data. The buttons are dimmed, not links, not focusable,
// and no click handler is ever bound to them; the real verdict brings them back. Free and Pro alike.

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache, resetSourceGap } = await import("../contents/modules/state")
const { LIMITED_BUTTONS_TITLE } = await import("../contents/modules/resilience")
const { SHADOW_CSS } = await import("../contents/modules/styles")

const CA = "So1anaTokenAddressForTests11111111111111111"
const T = 1_800_000_000_000
const VERDICTS = ["SAFE", "CAUTION", "DANGER", "RUG"] as const
const SCORE: Record<string, number> = { SAFE: 1000, CAUTION: 800, DANGER: 500, RUG: 100 }
const BUTTON_IDS = ["#ant-critical-flags-btn", "#ant-full-analysis", "#ant-ai-summary-btn"] as const

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 900, risk: "SAFE", flags: [], pair: null, resolvedMint: CA, confidence: 90, sources_used: ["dexscreener", "helius"],
  holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000, tokenSymbol: "TKN", tokenName: "Token", lpBurned: true,
  lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false,
  freshForSec: 300, staleLeftSec: 1200, ...over,
}) as unknown as ScanResponseData
const full = (risk: string) => data({ risk, score: SCORE[risk], fetchedAt: Date.now(), aiSummary: "A summary.", flags: risk === "SAFE" ? [] : [{ label: "A real flag", severity: "warning", impact: 5 }] })
const gapped = (risk: string) => data({ risk, score: SCORE[risk], degraded: true, sourceGap: true, freshForSec: 30, staleLeftSec: 0, fetchedAt: Date.now() })

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
const q = (sel: string) => state.shadow?.querySelector(sel) ?? null
const click = (sel: string) => q(sel)?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const openPanels = () => [...(state.shadow?.querySelectorAll("#ant-critical-flags.open, #ant-ai-summary.open") ?? [])]
const openedTabs = () => sendMessage.mock.calls.filter((c) => (c[0] as { type?: string })?.type === "OPEN_TAB").length

let windowOpen: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers({ now: T })
  installChrome()
  sendMessage.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  windowOpen = vi.spyOn(window, "open").mockImplementation(() => null)
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
  windowOpen.mockRestore()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the Limited data card: its three buttons do nothing", () => {
  for (const tier of ["free", "pro"] as const) {
    for (const risk of VERDICTS) {
      it(`${tier} | the scan reached ${risk}: the three buttons are inert, and a click on any of them opens nothing`, async () => {
        fetchMock.mockImplementation(() => answer(gapped(risk), tier))
        await scan(CA)
        expect(state.boxEl?.classList.contains("limited")).toBe(true)

        for (const sel of BUTTON_IDS) {
          const b = q(sel) as HTMLElement
          expect(b, sel).not.toBeNull()
          expect(b.getAttribute("aria-disabled"), sel).toBe("true")
          expect(b.getAttribute("tabindex"), sel).toBe("-1")
          expect(b.classList.contains("disabled"), sel).toBe(true)
          // nothing to follow: no address, no new-tab target
          expect(b.hasAttribute("href"), sel + " href").toBe(false)
          expect(b.hasAttribute("target"), sel + " target").toBe(false)
          expect(b.hasAttribute("title"), sel + " title (the tooltip is on the footer)").toBe(false)
        }
        // a real <button> is disabled for good measure (Pro: Critical Flags and AI Summary)
        if (tier === "pro") {
          expect((q("#ant-critical-flags-btn") as HTMLButtonElement).disabled).toBe(true)
          expect((q("#ant-ai-summary-btn") as HTMLButtonElement).disabled).toBe(true)
        }
        // the Free buttons keep their PRO look (the card is the same as the others), but lead nowhere
        if (tier === "free") expect(state.shadow?.querySelectorAll(".fo .locked")).toHaveLength(3)

        // clicking: no tab, no popup, no panel
        for (const sel of BUTTON_IDS) click(sel)
        await advance(500)
        expect(openedTabs()).toBe(0)
        expect(windowOpen).not.toHaveBeenCalled()
        expect(openPanels()).toHaveLength(0)
      })
    }
  }

  it("the footer says why when the pointer rests on it (the inert buttons ignore the pointer, so it is the footer that is hovered)", async () => {
    fetchMock.mockImplementation(() => answer(gapped("SAFE"), "pro"))
    await scan(CA)
    expect(q(".fo")?.getAttribute("title")).toBe(LIMITED_BUTTONS_TITLE)
    expect(LIMITED_BUTTONS_TITLE).toBe("Available when the data sources answer")
  })

  it("the style dims them and ignores the pointer", () => {
    const start = SHADOW_CSS.indexOf('.fo [aria-disabled="true"]')
    expect(start).toBeGreaterThan(-1)
    const css = SHADOW_CSS.slice(start, SHADOW_CSS.indexOf("}", start))
    expect(css).toContain("pointer-events: none")
    expect(css).toContain("cursor: not-allowed")
    expect(css).toMatch(/opacity:\s*\.\d+/)
  })

  it("a panel the user had open on the real verdict is gone with it when the card turns Limited data (nothing stays open on a verdict that is not shown)", async () => {
    fetchMock.mockImplementation(() => answer(full("DANGER"), "pro"))
    await scan(CA)
    click("#ant-critical-flags-btn")
    await advance(300)
    expect(openPanels().length).toBeGreaterThan(0)
    // the source goes silent: the next scan is Limited data
    fetchMock.mockImplementation(() => answer(gapped("DANGER"), "pro"))
    await advance(6 * 60_000)
    state.lastCA = ""
    await scan(CA, { refresh: true })
    expect(state.boxEl?.classList.contains("limited")).toBe(true)
    expect(openPanels()).toHaveLength(0)
    click("#ant-critical-flags-btn")
    await advance(300)
    expect(openPanels()).toHaveLength(0)
  })
})

describe("the real verdict brings the buttons back", () => {
  it("Pro: Limited data, then the source answers: Full Analysis opens the token page again, the panels toggle again", async () => {
    fetchMock.mockImplementation(() => answer(gapped("SAFE"), "pro"))
    await scan(CA)
    click("#ant-full-analysis")
    expect(openedTabs()).toBe(0)
    fetchMock.mockImplementation(() => answer(full("SAFE"), "pro"))
    await advance(32_000)
    expect(state.boxEl?.classList.contains("limited")).toBe(false)
    for (const sel of BUTTON_IDS) {
      const b = q(sel) as HTMLElement
      expect(b.getAttribute("aria-disabled"), sel).toBeNull()
      expect(b.classList.contains("disabled"), sel).toBe(false)
    }
    expect(q(".fo")?.hasAttribute("title")).toBe(false)
    click("#ant-full-analysis")
    expect(openedTabs()).toBe(1)
    click("#ant-ai-summary-btn")
    await advance(300)
    expect(openPanels().length).toBeGreaterThan(0)
  })

  it("Free: the upgrade links are links again, to the pricing page", async () => {
    fetchMock.mockImplementation(() => answer(gapped("CAUTION"), "free"))
    await scan(CA)
    expect(q("#ant-full-analysis")?.hasAttribute("href")).toBe(false)
    fetchMock.mockImplementation(() => answer(full("CAUTION"), "free"))
    await advance(32_000)
    for (const sel of BUTTON_IDS) {
      const b = q(sel) as HTMLElement
      expect(b.getAttribute("href"), sel).toContain("pricing")
      expect(b.getAttribute("target"), sel).toBe("_blank")
      expect(b.getAttribute("aria-disabled"), sel).toBeNull()
    }
  })

  it("witness: a card that is not Limited data was never inert (the click on Full Analysis opens the token page for Pro)", async () => {
    fetchMock.mockImplementation(() => answer(full("DANGER"), "pro"))
    await scan(CA)
    for (const sel of BUTTON_IDS) expect(q(sel)?.getAttribute("aria-disabled"), sel).toBeNull()
    click("#ant-full-analysis")
    expect(openedTabs()).toBe(1)
  })
})
