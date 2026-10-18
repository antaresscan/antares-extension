/* @vitest-environment happy-dom */
// __tests__/audit-lot49.test.ts — Lot 49 of the file-by-file audit (2026-10-17): the account tests (2/2).
//
// A mutation probe showed that the bridge's FIRST guard, `event.source !== window` (a message must come from the page itself, not from an
// iframe of it, a worker or another window), was checked by no test: removing it left every test green. The second guard (the origin
// allowlist) was tested. This pins the first one: a message with an allowed origin but another source is ignored.
// It fails on a bridge without that guard (checked by removing the line, then restoring it: audit-lots/mutate.cjs).

import { beforeEach, describe, expect, it, vi } from "vitest"

const storageMock = {
  set: vi.fn((_items: Record<string, unknown>, cb?: () => void) => { cb?.() }),
  get: vi.fn((_keys: unknown, cb?: (items: Record<string, unknown>) => void) => { cb?.({}); return Promise.resolve({}) }),
  remove: vi.fn((_key: string, cb?: () => void) => { cb?.() }),
}
;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: storageMock }, runtime: { lastError: null } }

await import("../contents/antares-website-bridge")

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhQGIuYyJ9.c2ln"
const ALLOWED = "https://antaresscan.com"
const send = (source: MessageEventSource | null) =>
  window.dispatchEvent(new MessageEvent("message", { data: { type: "antares:set-session-token", token: TOKEN }, origin: ALLOWED, source }))
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("website bridge — only the page itself may talk to it", () => {
  beforeEach(() => { storageMock.set.mockClear(); storageMock.remove.mockClear() })

  it("a message from the page (source = window, allowed origin) is handled (the guard is not blind)", async () => {
    send(window)
    await flush()
    expect(storageMock.set).toHaveBeenCalledTimes(1)
  })

  it("the same message with no source window (a worker, a port) is ignored", async () => {
    send(null)
    await flush()
    expect(storageMock.set).not.toHaveBeenCalled()
  })

  it("the same message from an iframe of the page (its own window) is ignored", async () => {
    const frame = document.createElement("iframe")
    document.body.appendChild(frame)
    const other = frame.contentWindow
    expect(other, "happy-dom gives the iframe its own window").not.toBeNull()
    expect(other).not.toBe(window)
    send(other as unknown as MessageEventSource)
    await flush()
    expect(storageMock.set).not.toHaveBeenCalled()
    frame.remove()
  })
})
