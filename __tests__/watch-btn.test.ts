/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock getInstallId BEFORE importing the modules — the watchlist panel
// resolves it inside its load loop, so the mock has to be wired first.
vi.mock("../shared/install-id", () => ({
  getInstallId: vi.fn(),
}))

vi.mock("../shared/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import { attachWatchBtn, buildResult } from "../contents/modules/components"
import { toggleWatchlist } from "../contents/modules/watchlist"
import { state } from "../contents/modules/state"
import { getInstallId } from "../shared/install-id"
import type { ScanResponseData } from "../shared/types"

const VALID_INSTALL = "install-test-aaaaaaaaaaaa"
const SAMPLE_CA = "So11111111111111111111111111111111111111112"

function setupOverlayShadow(): void {
  document.body.innerHTML = ""
  const root = document.createElement("div")
  // Mimic the buildResultNode tree — only the IDs the watchlist + button
  // logic look up via querySelector.
  const btn = document.createElement("button")
  btn.id = "ant-watchlist-btn"
  root.appendChild(btn)

  const wlPanel = document.createElement("div")
  wlPanel.id = "ant-watchlist"
  wlPanel.className = "wl-panel"
  root.appendChild(wlPanel)

  const aiPanel = document.createElement("div")
  aiPanel.id = "ant-ai-summary"
  aiPanel.className = "ai-panel open"
  root.appendChild(aiPanel)

  const cfPanel = document.createElement("div")
  cfPanel.id = "ant-critical-flags"
  cfPanel.className = "cf-panel open"
  root.appendChild(cfPanel)

  document.body.appendChild(root)
  state.shadow = root as unknown as ShadowRoot
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getInstallId).mockResolvedValue(VALID_INSTALL)
  setupOverlayShadow()
})

// ─── Toggle button wiring ─────────────────────────────────────────────────────

describe("attachWatchBtn (toggle wiring)", () => {
  it("clicking the toggle button opens the watchlist panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [], count: 0, max: 5, tier: "free" }),
      }),
    )

    attachWatchBtn(SAMPLE_CA)
    const btn = document.getElementById("ant-watchlist-btn")!
    btn.dispatchEvent(new Event("click", { bubbles: true }))
    await settle()

    const panel = document.getElementById("ant-watchlist")!
    expect(panel.classList.contains("open")).toBe(true)
  })

  it("opening the watchlist closes the AI Summary and Critical Flags panels (mutex)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [], count: 0, max: 5, tier: "free" }),
      }),
    )

    attachWatchBtn(SAMPLE_CA)
    document.getElementById("ant-watchlist-btn")!.dispatchEvent(
      new Event("click", { bubbles: true }),
    )
    await settle()

    expect(document.getElementById("ant-ai-summary")!.classList.contains("open")).toBe(false)
    expect(document.getElementById("ant-critical-flags")!.classList.contains("open")).toBe(false)
  })

  it("clicking again closes the panel without re-fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [], count: 0, max: 5, tier: "free" }),
    })
    vi.stubGlobal("fetch", fetchMock)

    attachWatchBtn(SAMPLE_CA)
    const btn = document.getElementById("ant-watchlist-btn")!
    btn.dispatchEvent(new Event("click", { bubbles: true }))
    await settle()
    btn.dispatchEvent(new Event("click", { bubbles: true }))
    await settle()

    expect(document.getElementById("ant-watchlist")!.classList.contains("open")).toBe(false)
    // First open did one GET; close should not have triggered another
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─── Panel rendering ──────────────────────────────────────────────────────────

describe("toggleWatchlist (panel content)", () => {
  it("renders 'No tokens yet' when the watchlist is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [], count: 0, max: 5, tier: "free" }),
      }),
    )

    toggleWatchlist(SAMPLE_CA)
    await settle()

    const panel = document.getElementById("ant-watchlist")!
    expect(panel.textContent).toContain("No tokens yet")
    expect(panel.textContent).toContain("Free")
    expect(panel.textContent).toContain("0/5")
  })

  it("renders the list with newest items first", async () => {
    const items = [
      { address: "OLD" + "x".repeat(40), addedAt: Date.now() - 10 * 60_000 },
      { address: "NEW" + "x".repeat(40), addedAt: Date.now() - 1 * 60_000 },
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items, count: 2, max: 5, tier: "free" }),
      }),
    )

    toggleWatchlist(SAMPLE_CA)
    await settle()

    const rows = document.querySelectorAll("#ant-watchlist .wl-row")
    expect(rows.length).toBe(2)
    // First row should be NEW (1 minute ago) — newest first
    expect(rows[0].textContent).toContain("NEW")
    expect(rows[1].textContent).toContain("OLD")
  })

  it("shows the upgrade CTA when Free tier hits the limit", async () => {
    const fullList = Array.from({ length: 5 }, (_, i) => ({
      address: `T${i}`.padEnd(43, "x"),
      addedAt: Date.now() - i * 60_000,
    }))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: fullList, count: 5, max: 5, tier: "free" }),
      }),
    )

    toggleWatchlist(SAMPLE_CA)
    await settle()

    const panel = document.getElementById("ant-watchlist")!
    expect(panel.textContent).toContain("Limit reached")
    expect(panel.textContent).toContain("Pro")
    expect(panel.textContent).toContain("50 slots")
  })

  it("renders 'Watching · Remove' when the current token is in the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ address: SAMPLE_CA, addedAt: Date.now() - 60_000 }],
          count: 1,
          max: 5,
          tier: "free",
        }),
      }),
    )

    toggleWatchlist(SAMPLE_CA)
    await settle()

    const panel = document.getElementById("ant-watchlist")!
    expect(panel.textContent).toContain("Watching")
    expect(panel.textContent).toContain("Remove")
  })

  it("renders 'Watchlist unavailable' when the GET fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    )

    toggleWatchlist(SAMPLE_CA)
    await settle()

    expect(document.getElementById("ant-watchlist")!.textContent).toContain("unavailable")
  })

  it("issues a POST when '+ Add' is clicked, then re-fetches the list", async () => {
    let callCount = 0
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++
      if (init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ added: true, count: 1, max: 5, tier: "free" }),
        })
      }
      // GET — first call empty, subsequent (after POST) shows the new entry
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          callCount === 1
            ? { items: [], count: 0, max: 5, tier: "free" }
            : {
                items: [{ address: SAMPLE_CA, addedAt: Date.now() }],
                count: 1,
                max: 5,
                tier: "free",
              },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    toggleWatchlist(SAMPLE_CA)
    await settle()

    const addBtn = document.querySelector("#ant-watchlist .wl-add") as HTMLButtonElement
    expect(addBtn).toBeTruthy()
    addBtn.dispatchEvent(new Event("click", { bubbles: true }))
    await settle()

    // Should have done at least: GET (initial) + POST (add) + GET (reload)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    const postCall = fetchMock.mock.calls.find(
      (call: unknown[]) =>
        (call[1] as RequestInit | undefined)?.method === "POST",
    )
    expect(postCall).toBeDefined()
  })

  it("shows 'Install ID not detected' when getInstallId returns null", async () => {
    vi.mocked(getInstallId).mockResolvedValue(null)

    toggleWatchlist(SAMPLE_CA)
    await settle()

    expect(document.getElementById("ant-watchlist")!.textContent).toContain("Install ID")
  })
})

// ─── Regression guard — overlay structure unchanged ───────────────────────────

describe("buildResult — overlay structure regression guard", () => {
  function makeData(over: Partial<ScanResponseData> = {}): ScanResponseData {
    return {
      score: 850,
      risk: "SAFE",
      flags: [],
      pair: null,
      resolvedMint: SAMPLE_CA,
      sources_used: ["dexscreener"],
      tokenSymbol: "TEST",
      tokenName: "Test Token",
      mintAuthority: false,
      freezeAuthority: false,
      lpBurned: true,
      lpLocked: false,
      honeypot: false,
      safeBlocked: false,
      ...over,
    } as ScanResponseData
  }

  it("preserves all 3 existing footer button IDs after watchlist toggle addition", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
  })

  it("adds the watchlist toggle button to the footer", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain('id="ant-watchlist-btn"')
    expect(html).toContain("★ Watchlist")
  })

  it("adds the watchlist panel placeholder to the overlay tree", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain('id="ant-watchlist"')
    expect(html).toContain('class="wl-panel"')
  })

  it("preserves brand and close button in the header", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain("ANTARES")
    expect(html).toContain('id="ant-close"')
  })

  it("preserves verdict labels", () => {
    expect(buildResult(makeData({ risk: "SAFE" }), SAMPLE_CA)).toContain("SAFE")
    expect(buildResult(makeData({ risk: "RUG" }), SAMPLE_CA)).toContain("RUG PULL")
    expect(buildResult(makeData({ risk: "CAUTION" }), SAMPLE_CA)).toContain("CAUTION")
    expect(buildResult(makeData({ risk: "DANGER" }), SAMPLE_CA)).toContain("DANGER")
  })

  it("preserves existing footer button labels", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain("Critical Flags")
    expect(html).toContain("Full Analysis")
    expect(html).toContain("AI Summary")
  })

  it("preserves the safety grid (Sell/Mint/Freeze/Liq)", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain("Sell")
    expect(html).toContain("Mint")
    expect(html).toContain("Freeze")
    expect(html).toContain("Liq")
  })
})
