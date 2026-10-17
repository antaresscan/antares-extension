/* @vitest-environment happy-dom */
// __tests__/options-settings.test.ts — the settings the Options page offers are settings the Extension reads.
//
// The page offered "Stealth Mode (hide overlay on pages)": it saved `antares_stealth`, and nothing in the Extension ever read it (the overlay is
// switched off with the toolbar icon). A switch that does nothing is a promise that is not kept, and the privacy policy and the Chrome Web Store
// justification listed it. It is gone. "Auto-rescan on price crash" stays: contents/modules/scanner.ts reads `autoRescan`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

vi.mock("../shared/install-id", () => ({ getInstallId: () => Promise.resolve("install-test-aaaaaaaaaaaa") }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { default: Options } = await import("../options")

const set = vi.fn()
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  set.mockReset()
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (keys: string[], cb: (items: Record<string, unknown>) => void) => cb(Object.fromEntries(keys.map((k) => [k, undefined]))),
        set,
        remove: vi.fn((_k: unknown, cb?: () => void) => cb?.()),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { lastError: undefined, getManifest: () => ({ version: "9.9.9" }) },
    tabs: { create: vi.fn() },
  })
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve(null) })))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => { root.render(createElement(Options)) })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe("Options page — no setting that nothing reads", () => {
  it("shows no Stealth Mode, and asks the storage for no antares_stealth", async () => {
    const asked: string[][] = []
    const original = (globalThis as unknown as { chrome: { storage: { local: { get: (k: string[], cb: (i: Record<string, unknown>) => void) => void } } } }).chrome.storage.local.get
    ;(globalThis as unknown as { chrome: { storage: { local: { get: unknown } } } }).chrome.storage.local.get = (keys: string[], cb: (i: Record<string, unknown>) => void) => { asked.push(keys); original(keys, cb) }
    await render()
    expect(container.textContent).not.toMatch(/stealth/i)
    expect(asked.flat()).not.toContain("antares_stealth")
  })

  it("witness: the auto-rescan checkbox is there, on by default, and saves what the scanner reads", async () => {
    await render()
    const boxes = [...container.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[]
    const rescan = boxes.find((b) => b.parentElement?.textContent?.includes("Auto-rescan"))
    expect(rescan, "the auto-rescan checkbox").toBeDefined()
    expect(rescan!.checked).toBe(true)
    await act(async () => { rescan!.click() })
    expect(set).toHaveBeenCalledWith({ autoRescan: false })
    expect(readFileSync(resolve(process.cwd(), "contents/modules/scanner.ts"), "utf8")).toContain("autoRescan")
  })

  it("nothing in the Extension's code reads or writes antares_stealth", () => {
    const files = [
      "options.tsx",
      "background.ts",
      ...(readdirSync(resolve(process.cwd(), "contents"), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `contents/${f}`),
      ...(readdirSync(resolve(process.cwd(), "shared")) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `shared/${f}`),
    ]
    for (const file of files) expect(readFileSync(resolve(process.cwd(), file), "utf8"), file).not.toContain("antares_stealth")
  })
})
