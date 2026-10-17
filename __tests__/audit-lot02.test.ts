// __tests__/audit-lot02.test.ts — Lot 2 of the file-by-file audit (2026-10-17): middleware.ts, logger.ts, log-ref.ts, sentry.ts,
// shared/sentry-scrub.ts (cron-auth.ts: nothing to fix; server-errors.ts: removed, nothing imported it). Each test pins a defect
// of the previous code.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- scrubEvent takes and returns `any` by design (it serves two Sentry SDKs) */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── middleware: the rate limiters fail OPEN on a Redis error ────────────────────────────────────────────────────────────────

const limiterBehaviour: { fail: Set<string>; deny: Set<string> } = { fail: new Set(), deny: new Set() };
vi.mock("@upstash/ratelimit", () => {
  class FakeRatelimit {
    private prefix: string;
    constructor(opts: { prefix: string }) {
      this.prefix = opts.prefix;
    }
    static slidingWindow() {
      return {};
    }
    async limit() {
      if (limiterBehaviour.fail.has(this.prefix)) throw new Error("UpstashError: ERR max requests limit exceeded");
      const ok = !limiterBehaviour.deny.has(this.prefix);
      return { success: ok, remaining: ok ? 10 : 0, reset: Date.now() + 42_000, limit: 60 };
    }
  }
  return { Ratelimit: FakeRatelimit };
});

import { initRateLimiters, checkRateLimit, setCorsHeaders, OFFICIAL_EXTENSION_ID } from "../api/_lib/middleware";
import { scrubEvent, scrubBreadcrumb, scrubText, redactSecretQueryParams } from "../shared/sentry-scrub";

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    status: vi.fn(function (this: { statusCode: number }, s: number) { this.statusCode = s; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
    end: vi.fn(),
  };
  return { res: res as unknown as VercelResponse & typeof res, headers };
}

describe("middleware.ts — checkRateLimit", () => {
  beforeEach(() => {
    limiterBehaviour.fail.clear();
    limiterBehaviour.deny.clear();
    initRateLimiters({} as never);
  });

  it.each(["antares_rl", "antares_burst", "antares_net"])("a Redis error in the %s window lets the request through (it used to throw: /api/scan answered 500)", async (prefix) => {
    limiterBehaviour.fail.add(prefix);
    const { res } = mockRes();
    await expect(checkRateLimit(res, "1.2.3.4", "install-abcdef12")).resolves.toBe(true);
  });

  it("a denied per-install window says when to come back (Retry-After), like the other two", async () => {
    limiterBehaviour.deny.add("antares_rl");
    const { res, headers } = mockRes();
    expect(await checkRateLimit(res, "1.2.3.4", "install-abcdef12")).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(Number(headers["Retry-After"])).toBeLessThanOrEqual(60);
  });
});

describe("middleware.ts — setCorsHeaders for the extension origin", () => {
  it("never lets the edge cache a preflight of the extension, and lets the browser keep it", () => {
    const { res, headers } = mockRes();
    const req = { method: "OPTIONS", headers: { origin: `chrome-extension://${OFFICIAL_EXTENSION_ID}` } } as unknown as VercelRequest;
    expect(setCorsHeaders(req, res)).toBe(true);
    expect(headers["Cache-Control"]).toBe("no-store, max-age=0");
    expect(headers["Access-Control-Max-Age"]).toBe("86400");
  });

  it("keeps the short edge window on a real request (unchanged)", () => {
    const { res, headers } = mockRes();
    const req = { method: "GET", headers: { origin: `chrome-extension://${OFFICIAL_EXTENSION_ID}` } } as unknown as VercelRequest;
    setCorsHeaders(req, res);
    expect(headers["Cache-Control"]).toBe("s-maxage=15, stale-while-revalidate=30");
  });
});

// ─── logger ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("logger.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function freshLogger(level?: string) {
    vi.resetModules();
    if (level !== undefined) vi.stubEnv("LOG_LEVEL", level);
    return (await import("../api/_lib/logger")).logger;
  }

  it("a LOG_LEVEL typo does not silence the errors (an unknown level used to make every comparison false)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = await freshLogger("debug");
    logger.error("m", "boom");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("never throws: a BigInt and a cycle in the data still give a JSON line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = await freshLogger("info");
    const cyclic: Record<string, unknown> = { n: 1n };
    cyclic.self = cyclic;
    expect(() => logger.warn("m", "x", { cyclic })).not.toThrow();
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line.data.cyclic.n).toBe("1");
    expect(line.data.cyclic.self).toBe("[Circular]");
  });

  it("the same object in two branches is not a cycle (it is written twice)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = await freshLogger("info");
    const shared = { v: 7 };
    logger.metric("e", { a: shared, b: shared });
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line.a).toEqual({ v: 7 });
    expect(line.b).toEqual({ v: 7 });
  });

  it("an Error in the data keeps its message (it serialised as {})", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = await freshLogger("info");
    logger.warn("m", "x", { error: new TypeError("socket hang up") });
    expect(JSON.parse(String(warn.mock.calls[0][0])).data.error).toEqual({ name: "TypeError", message: "socket hang up" });
  });

  it("a getter that throws loses the data, not the line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = await freshLogger("info");
    const evil = { get x() { throw new Error("no"); } };
    expect(() => logger.warn("m", "still here", { evil })).not.toThrow();
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line.message).toBe("still here");
    expect(line.dataUnserializable).toBe(true);
  });

  it("the value of a secret query parameter never reaches a log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = await freshLogger("info");
    logger.warn("m", "fetch failed https://mainnet.helius-rpc.com/?api-key=SECRET-123&x=1");
    const out = String(warn.mock.calls[0][0]);
    expect(out).not.toContain("SECRET-123");
    expect(out).toContain("api-key=[REDACTED]");
  });
});

// ─── Sentry scrubbing ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("shared/sentry-scrub.ts — scrubEvent", () => {
  it("drops request.query_string, which the SDK fills on its own (privacy.html: query strings are stripped)", () => {
    const e = scrubEvent({ request: { url: "https://x.test/api/payment-status?reference=abc", query_string: "reference=abc" } });
    expect(e.request.url).toBe("https://x.test/api/payment-status?[scrubbed]");
    expect(e.request.query_string).toBe("[scrubbed]");
  });

  it("drops a checkout reference passed as context (it reveals the licence key of a paid checkout)", () => {
    expect(scrubEvent({ extra: { reference: "f".repeat(64), endpoint: "payment-status" } }).extra).toEqual({ reference: "[scrubbed]", endpoint: "payment-status" });
  });

  it("drops the session header the extension sends", () => {
    expect(scrubEvent({ request: { headers: { "X-Antares-Session": "eyJhbGciOi..." } } }).request.headers["X-Antares-Session"]).toBe("[scrubbed]");
  });

  it("scrubs a transaction: its spans, their URLs and its name (transactions used to skip every scrub)", () => {
    const e = scrubEvent({
      type: "transaction",
      transaction: "GET https://antares-extension.vercel.app/api/scan?ca=MINT",
      spans: [
        { description: "GET https://api.nowpayments.io/v1/payment/?invoiceId=1&limit=50", data: { "url.full": "https://x.test/a?ca=MINT", "http.query": "?ca=MINT" } },
      ],
      contexts: { trace: { data: { "url.full": "https://x.test/a?reference=SECRET" } } },
    });
    expect(e.transaction).toBe("GET https://antares-extension.vercel.app/api/scan?[scrubbed]");
    expect(e.spans[0].description).not.toContain("invoiceId=1");
    expect(e.spans[0].data["url.full"]).toBe("https://x.test/a?[scrubbed]");
    expect(JSON.stringify(e.contexts)).not.toContain("SECRET");
  });

  it("scrubs the message and the exception text: no address, no whole licence key, no query", () => {
    const e = scrubEvent({
      message: "user bob@example.com failed",
      exception: { values: [{ type: "Error", value: "license ANT-ABCD-EFGH-JKMN-PQRS for bob@example.com at https://x.test/?ca=MINT" }] },
    });
    expect(e.message).toBe("user [email] failed");
    const v = e.exception.values[0].value;
    expect(v).not.toContain("bob@example.com");
    expect(v).not.toContain("ANT-ABCD-EFGH-JKMN-PQRS");
    expect(v).toContain("ANT-ABCD…");
    expect(v).not.toContain("ca=MINT");
  });

  it("scrubs the breadcrumbs that travel inside the event", () => {
    const e = scrubEvent({ breadcrumbs: [{ category: "fetch", data: { url: "https://x.test/api/scan?ca=MINT" } }] });
    expect(e.breadcrumbs[0].data.url).toBe("https://x.test/api/scan?[scrubbed]");
  });

  it("one malformed part does not leave the others unscrubbed", () => {
    const tags = {};
    Object.defineProperty(tags, "boom", { enumerable: true, get() { throw new Error("no"); } });
    const e = scrubEvent({ tags, user: { email: "a@b.co" }, request: { url: "https://x.test/?ca=1" } });
    expect(e.user.email).toBe("[scrubbed]");
    expect(e.request.url).toBe("https://x.test/?[scrubbed]");
  });

  it("a navigation breadcrumb with a relative URL loses its query too", () => {
    expect(scrubBreadcrumb({ category: "navigation", message: "/api/scan?ca=MINT" }).message).toBe("/api/scan?[scrubbed]");
  });

  it("text redactors", () => {
    expect(scrubText("see https://a.test/p?x=1#frag")).toBe("see https://a.test/p?[scrubbed]#frag");
    expect(redactSecretQueryParams("https://a.test/?access_token=zz&q=1")).toBe("https://a.test/?access_token=[REDACTED]&q=1");
  });
});

// ─── sentry.ts wires the scrub on transactions and breadcrumbs ─────────────────────────────────────────────────────────────────

describe("sentry.ts — initSentry", () => {
  it("scrubs transactions (beforeSendTransaction) and breadcrumbs (beforeBreadcrumb), not only errors", async () => {
    vi.resetModules();
    const init = vi.fn();
    vi.doMock("@sentry/node", () => ({ init, withScope: vi.fn(), captureException: vi.fn() }));
    vi.stubEnv("SENTRY_DSN", "https://key@o0.ingest.sentry.io/0");
    const { initSentry } = await import("../api/_lib/sentry");
    initSentry();
    const opts = init.mock.calls[0][0];
    expect(typeof opts.beforeSendTransaction).toBe("function");
    expect(opts.beforeSendTransaction({ transaction: "GET https://x.test/a?ca=1" }).transaction).toBe("GET https://x.test/a?[scrubbed]");
    expect(opts.beforeBreadcrumb({ data: { url: "https://x.test/a?ca=1" } }).data.url).toBe("https://x.test/a?[scrubbed]");
    vi.doUnmock("@sentry/node");
    vi.unstubAllEnvs();
  });
});
