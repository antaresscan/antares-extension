/* @vitest-environment happy-dom */
// The overlay is drawn on top of pages we do not control. With an OPEN shadow root any script of the page could read host.shadowRoot and rewrite the
// verdict on screen ("SAFE" over a rug): the root is CLOSED (components.ts), and the page gets null.
//
// A closed root changes two things for the code of the extension, and this file pins both so that the overlay cannot silently stop working:
//   1. nothing may reach the overlay through host.shadowRoot (it is null): the extension keeps its own reference in state.shadow;
//   2. an event heard OUTSIDE the root (on the host) no longer lists the elements inside it in composedPath(): dragging the card by its header
//      used to read composedPath()[0] on the host, which would now be the host itself, never the header: no drag would ever have started.
//
// So: the page cannot read or rewrite the card; and the card still renders, its buttons still answer, and it can still be dragged.
//
// A LIMIT OF THIS FILE, written down because it matters: happy-dom does not model the rule of point 2 (its composedPath() still lists the
// elements inside a closed root), so the drag tests below also pass with the old drag.ts. What stops that code from coming back is the last
// describe, which reads the source. The behaviour itself was checked in a real Chromium page with the real overlay code and a real mouse (the
// description of the pull request): the old drag code did not move the card with a closed root, the new one does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ScanResponseData } from "../shared/types"

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))
vi.mock("../contents/modules/scan-report", () => ({ reportScanResult: vi.fn() }))
vi.mock("../contents/modules/session-token", () => ({ readSessionToken: () => Promise.resolve(null) }))
vi.mock("../shared/rate-limit", () => ({ scanRateLimiter: { tryAcquire: () => Promise.resolve(true), getRetryAfterMs: () => Promise.resolve(0) } }))

;(window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true

const { scan } = await import("../contents/modules/scanner")
const { state, scanCache, resetSourceGap } = await import("../contents/modules/state")
const { createHost } = await import("../contents/modules/components")
const { POS_KEY } = await import("../contents/modules/constants")

const CA = "So1anaTokenAddressForTests11111111111111111"
const T = 1_800_000_000_000

const data = (over: Record<string, unknown> = {}): ScanResponseData => ({
  score: 500, risk: "DANGER", flags: [{ label: "A real flag", severity: "critical", impact: -20 }], pair: null, resolvedMint: CA, confidence: 90,
  sources_used: ["dexscreener", "helius"], holders: 1000, marketCap: 1_000_000, priceUsd: 1, liquidity: 50_000, tokenSymbol: "TKN", tokenName: "Token",
  lpBurned: false, lpLocked: false, safeBlocked: false, mintAuthority: false, freezeAuthority: false, honeypot: false, aiSummary: "A summary.",
  freshForSec: 300, staleLeftSec: 1200, fetchedAt: T, ...over,
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

/** What the EXTENSION sees: it holds the root in state.shadow. */
const q = (sel: string) => state.shadow?.querySelector(sel) ?? null
const host = () => document.getElementById("antares-host") as HTMLElement
const click = (sel: string) => q(sel)?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }))
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const pointer = (type: string, init: Record<string, unknown> = {}) =>
  new window.PointerEvent(type, { pointerId: 7, clientX: 100, clientY: 100, bubbles: true, cancelable: true, composed: true, ...init })

beforeEach(() => {
  vi.useFakeTimers({ now: T })
  installChrome()
  sendMessage.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(window, "open").mockImplementation(() => null)
  scanCache.clear()
  try { localStorage.removeItem(POS_KEY) } catch { /* no storage */ }
  document.documentElement.querySelector("#antares-host")?.remove()
  document.documentElement.style.userSelect = ""
  resetSourceGap()
  Object.assign(state, {
    host: null, shadow: null, boxEl: null, lastCA: "", manuallyDismissed: false, currentScanController: null, failureView: null,
    recoveryTimer: null, recoveryCa: "", recoveryAttempt: 0, recoveryStartedAt: 0, staleExpiryTimer: null, rescanTimer: null, activePointerId: null,
  })
})
afterEach(() => {
  resetSourceGap()
  if (state.recoveryTimer) clearTimeout(state.recoveryTimer)
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(tier: "free" | "pro") {
  fetchMock.mockImplementation(() => answer(data(), tier))
  await scan(CA)
}

describe("the page cannot read or rewrite the overlay", () => {
  it("the host's shadowRoot is null: the root is closed", () => {
    createHost()
    expect(host()).not.toBeNull()
    expect(host().shadowRoot).toBeNull()
    expect(state.shadow).not.toBeNull() // the extension keeps its own reference
  })

  it.each(["free", "pro"] as const)("%s | the drawn card is in the root, and nothing of it is reachable from the page", async (tier) => {
    await render(tier)
    expect(q(".vb")?.textContent).toContain("DANGER") // it is there, for the extension
    expect(host().shadowRoot).toBeNull()
    expect(document.querySelector(".vb")).toBeNull() // the page's queries do not pierce the root
    expect(document.querySelector(".box")).toBeNull()
    expect(document.querySelector("#ant-close")).toBeNull()
    expect(host().querySelector(".vb")).toBeNull()
    expect(host().textContent).toBe("") // nothing in the host's light DOM either
  })

  it("a page script that tries to rewrite the verdict fails, and the verdict on screen does not change", async () => {
    await render("pro")
    const hostile = () => {
      const root = (document.getElementById("antares-host") as HTMLElement).shadowRoot
      if (!root) throw new Error("no access")
      root.querySelector(".vb h1")!.textContent = "SAFE"
    }
    expect(hostile).toThrow("no access")
    expect(q(".vb h1")?.textContent).not.toBe("SAFE")
    expect(q(".vb")?.textContent).toContain("DANGER")
  })
})

describe("the overlay still works with the root closed", () => {
  it("Free: the card shows the verdict and the Pro-locked buttons are links to the plans", async () => {
    await render("free")
    expect(q(".vb")?.textContent).toContain("DANGER")
    for (const sel of ["#ant-critical-flags-btn", "#ant-full-analysis", "#ant-ai-summary-btn"]) {
      const b = q(sel) as HTMLElement
      expect(b, sel).not.toBeNull()
      expect(b.classList.contains("locked"), sel).toBe(true)
      expect(b.getAttribute("href"), sel).toContain("pricing")
    }
  })

  it("Pro: Critical Flags and AI Summary open and close their panels, Full Analysis asks the background to open the page", async () => {
    await render("pro")

    click("#ant-critical-flags-btn")
    await advance(50)
    expect(q("#ant-critical-flags.open")).not.toBeNull()
    click("#ant-critical-flags-btn")
    await advance(50)
    // The close is animated: it starts now and ends on the CSS "animationend" event, which a real browser sends and happy-dom does not.
    expect(q("#ant-critical-flags.closing")).not.toBeNull()
    q("#ant-critical-flags")!.dispatchEvent(new window.Event("animationend"))
    expect(q("#ant-critical-flags.open")).toBeNull()

    click("#ant-ai-summary-btn")
    await advance(50)
    expect(q("#ant-ai-summary.open")).not.toBeNull()

    click("#ant-full-analysis")
    expect(sendMessage.mock.calls.some((c) => (c[0] as { type?: string })?.type === "OPEN_TAB")).toBe(true)
  })

  it("the close button hides the card and remembers the dismissal", async () => {
    await render("pro")
    click("#ant-close")
    await advance(300)
    expect(state.manuallyDismissed).toBe(true)
    expect(state.boxEl?.style.display).toBe("none")
  })
})

describe("dragging works with the root closed", () => {
  it("a press on the header starts a drag; the moves move the card; the release saves where it was left", async () => {
    await render("pro")
    expect(state.activePointerId).toBeNull()

    q(".hd")!.dispatchEvent(pointer("pointerdown", { clientX: 100, clientY: 100 }))
    expect(state.activePointerId).toBe(7) // the press inside the root was heard, with the real element as its target
    expect(document.documentElement.style.userSelect).toBe("none")

    host().dispatchEvent(pointer("pointermove", { clientX: 160, clientY: 130 }))
    expect(state.pendingX).toBe(60)
    expect(state.pendingY).toBe(30)
    await advance(50) // the frame commits the position
    expect(host().style.transform).toBe("translate(60px,30px)")

    host().dispatchEvent(pointer("pointerup", { clientX: 160, clientY: 130 }))
    expect(state.activePointerId).toBeNull()
    expect(document.documentElement.style.userSelect).toBe("")
    expect(JSON.parse(localStorage.getItem(POS_KEY) ?? "null")).toEqual({ x: 60, y: 30 })
  })

  it("a press on the close button does not start a drag", async () => {
    await render("pro")
    q("#ant-close")!.dispatchEvent(pointer("pointerdown"))
    expect(state.activePointerId).toBeNull()
  })

  it("a press on the body of the card (not the header) does not start a drag", async () => {
    await render("pro")
    q(".vb")!.dispatchEvent(pointer("pointerdown"))
    q("#ant-full-analysis")!.dispatchEvent(pointer("pointerdown"))
    expect(state.activePointerId).toBeNull()
  })

  it("a press dispatched on the host itself (what a script of the page could do) does not start a drag", async () => {
    await render("pro")
    host().dispatchEvent(pointer("pointerdown"))
    expect(state.activePointerId).toBeNull()
  })

  it("a move or a release of ANOTHER pointer, or with no drag going, changes nothing", async () => {
    await render("pro")
    host().dispatchEvent(pointer("pointermove", { clientX: 300, clientY: 300 }))
    host().dispatchEvent(pointer("pointerup"))
    expect(state.activePointerId).toBeNull()
    q(".hd")!.dispatchEvent(pointer("pointerdown", { pointerId: 7 }))
    host().dispatchEvent(pointer("pointermove", { pointerId: 8, clientX: 500, clientY: 500 }))
    expect(state.pendingX).not.toBe(500)
    host().dispatchEvent(pointer("pointercancel"))
    expect(state.activePointerId).toBeNull()
  })
})

// ── The guard on the source: the two things a closed root forbids must not come back.
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx)$/.test(p)) out.push(p)
  }
  return out
}
const code = (file: string) => readFileSync(file, "utf8").split(String.fromCharCode(13)).join("")
// What is left of a file once its comments are gone: the guard reads the code, not the explanations of why it is written this way.
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("the source keeps the root closed and keeps nothing that needs it open", () => {
  const files = [...sources("contents"), ...sources("shared"), "background.ts", "options.tsx"]

  it("the root is created closed, and only there", () => {
    const src = withoutComments(code(join("contents", "modules", "components.ts")))
    expect(src).toMatch(/attachShadow\(\{ mode: "closed" \}\)/)
    expect(src).not.toMatch(/mode: "open"/)
    for (const f of files) expect(withoutComments(code(f)), f).not.toMatch(/mode:\s*"open"/)
  })

  it("no code reaches the overlay through host.shadowRoot (it is null)", () => {
    for (const f of files) expect(withoutComments(code(f)), f).not.toMatch(/\.shadowRoot\b/)
  })

  it("no listener outside the root reads composedPath() (it stops at the host): drag.ts listens inside the root", () => {
    for (const f of files) expect(withoutComments(code(f)), f).not.toMatch(/composedPath/)
    const drag = withoutComments(code(join("contents", "modules", "drag.ts")))
    expect(drag).toMatch(/state\.shadow\?\.addEventListener\("pointerdown"/)
  })
})
