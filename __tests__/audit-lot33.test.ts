/* @vitest-environment happy-dom */
// __tests__/audit-lot33.test.ts — Lot 33 of the file-by-file audit (2026-10-17): the Options page. Fails on the previous code.
//
// A signed-in customer whose plan cannot be read right now (/api/quota answers 503, or does not answer) was shown as Free: "You're signed
// in but no active Pro subscription found. Upgrade to Pro →", an invitation to pay a second time during an outage. The plan is now
// "unknown" until it can be read.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { default: Options } = await import("../options")

const json = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })
let quotaAnswer: () => Promise<unknown>
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  const store: Record<string, unknown> = { antares_session_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhQGIuYyJ9.c2ln" }
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (keys: string[], cb: (items: Record<string, unknown>) => void) => cb(Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))),
        set: vi.fn(),
        remove: vi.fn((_k: unknown, cb?: () => void) => cb?.()),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { lastError: undefined, getManifest: () => ({ version: "9.9.9" }) },
    tabs: { create: vi.fn() },
  })
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/api/auth/me")) return json(200, { ok: true, email: "buyer@example.com" })
    if (url.includes("/api/quota")) return quotaAnswer()
    return json(404, null)
  }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<string> {
  await act(async () => { root.render(createElement(Options)) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  return container.textContent ?? ""
}

describe("Options page — a plan that cannot be read is not shown as Free", () => {
  it("/api/quota answers 503: no \"no active Pro subscription found\", no upgrade offer (both were shown)", async () => {
    quotaAnswer = () => json(503, { error: "unavailable" })
    const text = await render()
    expect(text).toContain("buyer@example.com")
    expect(text).not.toContain("no active Pro subscription found")
    expect(text).not.toContain("Upgrade to Pro")
    expect(text).toContain("Plan unknown")
    expect(text).toContain("could not be checked right now")
  })

  it("/api/quota does not answer at all: same", async () => {
    quotaAnswer = () => Promise.reject(new TypeError("Failed to fetch"))
    const text = await render()
    expect(text).not.toContain("no active Pro subscription found")
    expect(text).toContain("Plan unknown")
  })

  it("a real Free answer still offers Pro, a real Pro answer shows Pro (non-regression)", async () => {
    quotaAnswer = () => json(200, { tier: "free" })
    expect(await render()).toContain("no active Pro subscription found")
    act(() => root.unmount())
    root = createRoot(container)
    quotaAnswer = () => json(200, { tier: "pro", tierExpiresAt: null })
    const text = await render()
    expect(text).toContain("Pro")
    expect(text).not.toContain("no active Pro subscription found")
  })
})
