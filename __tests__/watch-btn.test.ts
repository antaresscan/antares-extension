/* @vitest-environment happy-dom */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock getInstallId BEFORE importing components — the watch button reads
// it inside its click handler, so the mock has to be wired first.
vi.mock("../shared/install-id", () => ({
  getInstallId: vi.fn(),
}))

// Mock logger to silence warnings during error-path tests
vi.mock("../shared/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

import { attachWatchBtn, buildResult } from "../contents/modules/components"
import { state } from "../contents/modules/state"
import { getInstallId } from "../shared/install-id"
import type { ScanResponseData } from "../shared/types"

const VALID_INSTALL = "install-test-aaaaaaaaaaaa"
const SAMPLE_CA = "So11111111111111111111111111111111111111112"

function setupOverlayShadow(): void {
  document.body.innerHTML = ""
  const root = document.createElement("div")
  const btn = document.createElement("button")
  btn.id = "ant-watch"
  btn.textContent = "+ Watch"
  root.appendChild(btn)
  document.body.appendChild(root)
  state.shadow = root as unknown as ShadowRoot
}

/**
 * Trigger the click handler and wait for any pending microtasks to settle.
 * The handler is async (await getInstallId, await fetch, await res.json),
 * so a single Promise.resolve() isn't enough to drain the queue.
 */
async function clickAndSettle(): Promise<void> {
  const btn = document.getElementById("ant-watch")!
  btn.dispatchEvent(new Event("click", { bubbles: true }))
  // Drain microtasks until the handler can no longer schedule more
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getInstallId).mockResolvedValue(VALID_INSTALL)
  setupOverlayShadow()
})

// ─── Happy path: 200 + added ─────────────────────────────────────────────────

describe("attachWatchBtn — POST success", () => {
  it("flips the button to '✓ Watching' on a successful add", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ added: true, count: 1, max: 5, tier: "free" }),
      }),
    )

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    expect(btn.textContent).toBe("✓ Watching")
    expect(btn.classList.contains("watching")).toBe(true)
    expect(btn.disabled).toBe(true)
  })

  it("shows '✓ Watched' when the address was already in the list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ added: false, reason: "already_present" }),
      }),
    )

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    expect(btn.textContent).toBe("✓ Watched")
    expect(btn.classList.contains("watching")).toBe(true)
  })

  it("sends the contract address in the JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ added: true }),
    })
    vi.stubGlobal("fetch", fetchMock)

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("POST")
    const body = JSON.parse(String(init.body)) as { address: string }
    expect(body.address).toBe(SAMPLE_CA)
    const headers = init.headers as Record<string, string>
    expect(headers["X-Antares-Install"]).toBe(VALID_INSTALL)
  })
})

// ─── Limit reached: 402 → upgrade link ───────────────────────────────────────

describe("attachWatchBtn — 402 limit reached", () => {
  it("converts the button into a 'Limit → PRO' upgrade link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 402,
        json: async () => ({ added: false, reason: "limit_reached" }),
      }),
    )

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    expect(btn.textContent).toBe("Limit → PRO")
    expect(btn.classList.contains("limit")).toBe(true)
    expect(btn.disabled).toBe(false)
  })

  it("opens the pricing page on subsequent click", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 402,
        json: async () => ({ added: false, reason: "limit_reached" }),
      }),
    )
    const openSpy = vi.fn()
    vi.stubGlobal("window", { ...window, open: openSpy })

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    // Second click — should open pricing
    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    btn.dispatchEvent(new Event("click", { bubbles: true }))
    expect(openSpy).toHaveBeenCalledOnce()
    const [url] = openSpy.mock.calls[0] as [string]
    expect(url).toContain("pricing")
  })
})

// ─── Anonymous (no install_id) ───────────────────────────────────────────────

describe("attachWatchBtn — anonymous", () => {
  it("shows '✗ Anon' and resets when install_id is missing", async () => {
    vi.mocked(getInstallId).mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    expect(btn.textContent).toBe("✗ Anon")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─── Network/server error paths ──────────────────────────────────────────────

describe("attachWatchBtn — error paths", () => {
  it("shows '✗ Failed' on 5xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 500,
        json: async () => ({}),
      }),
    )

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    expect(btn.textContent).toBe("✗ Failed")
  })

  it("shows '✗ Net' on network failure (fetch throws)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))

    attachWatchBtn(SAMPLE_CA)
    await clickAndSettle()

    const btn = document.getElementById("ant-watch") as HTMLButtonElement
    expect(btn.textContent).toBe("✗ Net")
  })
})

// ─── Regression: existing overlay structure unchanged ────────────────────────

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

  it("preserves all 3 existing footer button IDs after watchlist addition", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain('id="ant-critical-flags-btn"')
    expect(html).toContain('id="ant-full-analysis"')
    expect(html).toContain('id="ant-ai-summary-btn"')
  })

  it("adds the watchlist button to the footer", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain('id="ant-watch"')
    expect(html).toContain("+ Watch")
  })

  it("preserves the brand and close button in the header", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain("ANTARES")
    expect(html).toContain('id="ant-close"')
  })

  it("preserves the verdict label in the score section", () => {
    expect(buildResult(makeData({ risk: "SAFE" }), SAMPLE_CA)).toContain("SAFE")
    expect(buildResult(makeData({ risk: "RUG" }), SAMPLE_CA)).toContain("RUG PULL")
    expect(buildResult(makeData({ risk: "CAUTION" }), SAMPLE_CA)).toContain("CAUTION")
    expect(buildResult(makeData({ risk: "DANGER" }), SAMPLE_CA)).toContain("DANGER")
  })

  it("preserves the existing footer button labels", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain("Critical Flags")
    expect(html).toContain("Full Analysis")
    expect(html).toContain("AI Summary")
  })

  it("preserves the safety grid (Sell/Mint/Freeze/LP/Liq)", () => {
    const html = buildResult(makeData(), SAMPLE_CA)
    expect(html).toContain("Sell")
    expect(html).toContain("Mint")
    expect(html).toContain("Freeze")
    expect(html).toContain("Liq")
  })
})
