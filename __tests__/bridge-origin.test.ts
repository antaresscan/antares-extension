// __tests__/bridge-origin.test.ts
//
// Regression test for the antares-website-bridge origin allowlist.
//
// The bridge accepts postMessage traffic from the page it's injected on
// (matches list) and stores the resulting JWT into chrome.storage.local.
// Before the origin check landed, any same-origin script could spoof a
// `antares:set-session-token` and plant a forged Pro/Lifetime token.
//
// This test pins the allowlist behaviour: messages from unlisted origins
// are dropped silently, messages from listed origins still flow.
//
// We use happy-dom so `window.dispatchEvent(new MessageEvent(...))` works.

/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal chrome.storage.local mock — bridge writes the token here, we
// assert against the calls. Done before importing the bridge so the
// content-script's load-time side effects pick this up.
const storageMock = {
  set: vi.fn((_items: Record<string, unknown>, cb?: () => void) => {
    cb?.();
  }),
  get: vi.fn(
    (
      _keys: string | string[] | null,
      cb?: (items: Record<string, unknown>) => void,
    ) => {
      cb?.({});
      return Promise.resolve({});
    },
  ),
  remove: vi.fn((_key: string, cb?: () => void) => {
    cb?.();
  }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = {
  storage: { local: storageMock },
  runtime: { lastError: null as unknown },
};

// Side-effect import: registers the window message listener.
await import("../contents/antares-website-bridge");

describe("antares-website-bridge origin allowlist", () => {
  beforeEach(() => {
    storageMock.set.mockClear();
    storageMock.remove.mockClear();
  });

  function dispatch(data: unknown, origin: string) {
    const event = new MessageEvent("message", {
      data,
      origin,
      source: window,
    });
    window.dispatchEvent(event);
  }

  it("drops set-session-token from a non-allowlisted origin", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "forged.jwt.here" },
      "https://evil.example.com",
    );
    // postMessage processing is sync; storage callback is sync via mock.
    expect(storageMock.set).not.toHaveBeenCalled();
  });

  it("accepts set-session-token from https://antaresscan.com", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "legit.jwt.here" },
      "https://antaresscan.com",
    );
    expect(storageMock.set).toHaveBeenCalledTimes(1);
    expect(storageMock.set.mock.calls[0]?.[0]).toEqual({
      antares_session_token: "legit.jwt.here",
    });
  });

  it("accepts set-session-token from https://www.antaresscan.com", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "legit.jwt.here" },
      "https://www.antaresscan.com",
    );
    expect(storageMock.set).toHaveBeenCalledTimes(1);
  });

  it("accepts set-session-token from the legacy vercel.app origin", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "legit.jwt.here" },
      "https://antares-website.vercel.app",
    );
    expect(storageMock.set).toHaveBeenCalledTimes(1);
  });

  it("accepts set-session-token from the github.io mirror", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "legit.jwt.here" },
      "https://comealamaisongroupe.github.io",
    );
    expect(storageMock.set).toHaveBeenCalledTimes(1);
  });

  it("drops clear-session-token from a non-allowlisted origin", async () => {
    dispatch(
      { type: "antares:clear-session-token" },
      "https://attacker.example",
    );
    expect(storageMock.remove).not.toHaveBeenCalled();
  });

  it("accepts clear-session-token from the production origin", async () => {
    dispatch(
      { type: "antares:clear-session-token" },
      "https://antaresscan.com",
    );
    expect(storageMock.remove).toHaveBeenCalledTimes(1);
  });

  it("rejects an HTTP variant of the production origin", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "forged.jwt.here" },
      "http://antaresscan.com",
    );
    expect(storageMock.set).not.toHaveBeenCalled();
  });

  it("rejects a subdomain that is not on the allowlist", async () => {
    dispatch(
      { type: "antares:set-session-token", token: "forged.jwt.here" },
      "https://attacker.antaresscan.com",
    );
    expect(storageMock.set).not.toHaveBeenCalled();
  });
});
