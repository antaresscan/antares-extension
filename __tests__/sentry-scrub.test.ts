// __tests__/sentry-scrub.test.ts
//
// Pins the behaviour of the PII scrubber wired into Sentry's
// `beforeSend`. Privacy.html promises that no PII reaches our error
// telemetry; this test makes that claim falsifiable.
//
// Test surface is the exported `_scrubObjectForTests` (the same code
// the production `beforeSend` runs). Mocks the Sentry SDK so we don't
// need a DSN and the test runs offline.

import { describe, it, expect, vi } from "vitest";

// We never actually init Sentry in this test — but the import chain
// loads @sentry/node which probes the runtime. Mock it to a no-op so
// the import doesn't hang on edge-case environments.
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn(),
}));

import { _scrubObjectForTests, _scrubEventForTests } from "../api/_lib/sentry";

describe("Sentry PII scrubber", () => {
  it("scrubs `email` at the top level", () => {
    const out = _scrubObjectForTests({
      email: "user@example.com",
      reference: "ref-123",
    });
    expect(out).toEqual({ email: "[scrubbed]", reference: "ref-123" });
  });

  it("is case-insensitive on key names", () => {
    const out = _scrubObjectForTests({
      Email: "user@example.com",
      EMAIL: "user2@example.com",
      EmAiL: "user3@example.com",
    });
    expect(out).toEqual({
      Email: "[scrubbed]",
      EMAIL: "[scrubbed]",
      EmAiL: "[scrubbed]",
    });
  });

  it("scrubs nested objects", () => {
    const out = _scrubObjectForTests({
      request: {
        body: {
          email: "user@example.com",
          password: "supersecret",
        },
      },
      reference: "ref-123",
    });
    expect(out).toEqual({
      request: { body: { email: "[scrubbed]", password: "[scrubbed]" } },
      reference: "ref-123",
    });
  });

  it("scrubs entries inside arrays of objects", () => {
    const out = _scrubObjectForTests({
      users: [
        { email: "a@example.com", id: 1 },
        { email: "b@example.com", id: 2 },
      ],
    });
    expect(out).toEqual({
      users: [
        { email: "[scrubbed]", id: 1 },
        { email: "[scrubbed]", id: 2 },
      ],
    });
  });

  it("handles all the auth + payment-flavoured keys we capture", () => {
    const out = _scrubObjectForTests({
      email: "x",
      emailLc: "x",
      password: "x",
      passwordHash: "x",
      password_hash: "x",
      token: "x",
      session_token: "x",
      sessionToken: "x",
      // Added 2026-05-19 after audit V3 flagged that the session
      // cookie name itself (`antares_session`) and license keys were
      // captured in cookies / breadcrumbs / extras without scrubbing.
      antares_session: "x",
      antares_session_token: "x",
      licenseKey: "x",
      license_key: "x",
      jwt: "x",
      authorization: "Bearer xxx",
      cookie: "antares_session=xxx",
      apiKey: "x",
      api_key: "x",
      ipnSecret: "x",
      session_secret: "x",
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) {
      expect(v).toBe("[scrubbed]");
    }
  });

  it("leaves non-sensitive keys intact", () => {
    const out = _scrubObjectForTests({
      reference: "ref-123",
      install_id: "uuid-here",
      endpoint: "payment-intent",
      status: 500,
      ca: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
    });
    expect(out).toEqual({
      reference: "ref-123",
      install_id: "uuid-here",
      endpoint: "payment-intent",
      status: 500,
      ca: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
    });
  });

  it("does not crash on null / undefined / primitives", () => {
    expect(_scrubObjectForTests(null)).toBe(null);
    expect(_scrubObjectForTests(undefined)).toBe(undefined);
    expect(_scrubObjectForTests(42)).toBe(42);
    expect(_scrubObjectForTests("plain string")).toBe("plain string");
  });

  it("bounds recursion on adversarially deep nesting", () => {
    // Build a chain `{ a: { a: { a: ... } } }` 12 levels deep. The
    // scrubber gives up at depth 6 — the deepest level keeps whatever
    // structure was there. The point is "no stack overflow", not
    // "scrub every level no matter how deep".
    let nested: unknown = { email: "deep@example.com" };
    for (let i = 0; i < 12; i++) nested = { a: nested };
    expect(() => _scrubObjectForTests(nested)).not.toThrow();
  });
});

// New scope: the full event-level scrubber wired into beforeSend.
// Pins the GDPR-claim-preserving behaviour added 2026-05-19 after the
// security audit flagged that privacy.html's "no PII / no contract
// address" claim wasn't actually held by the code (Sentry default IP
// capture + URL-with-query weren't scrubbed).
describe("Sentry event scrubber (beforeSend)", () => {
  it("strips ?ca=<contract> from request.url while preserving path", () => {
    const event = {
      request: {
        url: "https://antares-extension.vercel.app/api/scan?ca=ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82&t=123",
      },
    };
    const out = _scrubEventForTests(event);
    expect(out.request.url).toBe(
      "https://antares-extension.vercel.app/api/scan?[scrubbed]",
    );
  });

  it("leaves a query-less URL untouched", () => {
    const event = {
      request: { url: "https://antares-extension.vercel.app/api/health" },
    };
    const out = _scrubEventForTests(event);
    expect(out.request.url).toBe(
      "https://antares-extension.vercel.app/api/health",
    );
  });

  it("scrubs user.email and user.ip_address", () => {
    const event = {
      user: {
        email: "buyer@example.com",
        ip_address: "203.0.113.42",
        id: "install-abc",
      },
    };
    const out = _scrubEventForTests(event);
    expect(out.user.email).toBe("[scrubbed]");
    expect(out.user.ip_address).toBe("[scrubbed]");
    // id is not PII per privacy policy (opaque install-id), keep it.
    expect(out.user.id).toBe("install-abc");
  });

  it("scrubs request.data, headers, cookies via key allowlist", () => {
    const event = {
      request: {
        data: { email: "x@y.z", reference: "ref-1" },
        headers: { authorization: "Bearer xxx", "user-agent": "Mozilla" },
        cookies: { antares_session: "jwt-here", theme: "dark" },
      },
    };
    const out = _scrubEventForTests(event);
    expect(out.request.data.email).toBe("[scrubbed]");
    expect(out.request.data.reference).toBe("ref-1");
    expect(out.request.headers.authorization).toBe("[scrubbed]");
    expect(out.request.headers["user-agent"]).toBe("Mozilla");
    expect(out.request.cookies.theme).toBe("dark");
  });

  it("returns the event even when malformed (no throw)", () => {
    // Adversarial shape — a getter that throws partway through scrubbing.
    const event = {
      request: {
        get url() {
          throw new Error("boom");
        },
      },
    };
    expect(() => _scrubEventForTests(event)).not.toThrow();
  });
});
