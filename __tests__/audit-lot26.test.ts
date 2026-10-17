// __tests__/audit-lot26.test.ts — Lot 26 of the file-by-file audit (2026-10-17): the shared modules and the website bridge.
// Fails on the previous code.

/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMock = {
  set: vi.fn((_items: Record<string, unknown>, cb?: () => void) => { cb?.(); }),
  get: vi.fn((_keys: unknown, cb?: (items: Record<string, unknown>) => void) => { cb?.({}); return Promise.resolve({}); }),
  remove: vi.fn((_key: string, cb?: () => void) => { cb?.(); }),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = { storage: { local: storageMock }, runtime: { lastError: null as unknown } };

await import("../contents/antares-website-bridge");

function dispatch(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: "https://antaresscan.com", source: window }));
}

describe("website bridge — only something shaped like our session token is stored", () => {
  beforeEach(() => { storageMock.set.mockClear(); });

  it("a 2 MB string from a script of the page is not written to the extension's storage (it was, and sent on every scan)", async () => {
    dispatch({ type: "antares:set-session-token", token: "x".repeat(2_000_000) });
    await new Promise((r) => setTimeout(r, 0));
    expect(storageMock.set).not.toHaveBeenCalled();
  });

  it("a real JWT shape is still stored (non-regression)", async () => {
    dispatch({ type: "antares:set-session-token", token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhQGIuYyJ9.c2ln" });
    await new Promise((r) => setTimeout(r, 0));
    expect(storageMock.set).toHaveBeenCalledTimes(1);
  });
});
