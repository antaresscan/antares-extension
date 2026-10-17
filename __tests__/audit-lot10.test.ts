// __tests__/audit-lot10.test.ts — Lot 10 of the file-by-file audit (2026-10-17): api/payment-intent.ts, api/payment-status.ts,
// api/cron-check-payments.ts. Each test fails on the previous code.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const REFERENCE = "9a".repeat(32);
const mocks = vi.hoisted(() => ({ failGets: new Set<string>(), srem: vi.fn(), smembers: vi.fn() }));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = vi.fn(async (k: string) => {
      if (mocks.failGets.has(k)) throw new Error("ECONNRESET (simulated)");
      return null;
    });
    set = vi.fn().mockResolvedValue("OK");
    srem = mocks.srem;
    smembers = mocks.smembers;
  }
  return { Redis: MockRedis };
});
vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return { ...actual, checkRateLimit: vi.fn().mockResolvedValue(true), initRateLimiters: vi.fn() };
});

import paymentStatus from "../api/payment-status";
import cron from "../api/cron-check-payments";

function res() {
  const out = { status: 200, body: {} as Record<string, unknown> };
  const r = {
    setHeader: () => r, status: (c: number) => { out.status = c; return r; },
    json: (b: Record<string, unknown>) => { out.body = b; return r; }, end: () => r,
  } as unknown as VercelResponse;
  return { r, out };
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.NOWPAYMENTS_API_KEY = "np-test-key";
  process.env.CRON_SECRET = "cron-secret-for-the-audit-test-0123456789";
  mocks.failGets.clear();
  mocks.srem.mockReset().mockResolvedValue(1);
  mocks.smembers.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.CRON_SECRET;
});

describe("payment-status — a Redis hiccup is not 'Payment not found'", () => {
  it("answers 503 (the website keeps polling), not 404 (the website says 'Payment not found — Try again' and stops)", async () => {
    mocks.failGets.add(`payment-intent:${REFERENCE}`);
    const { r, out } = res();
    await paymentStatus({ method: "GET", headers: { origin: "https://antaresscan.com" }, query: { reference: REFERENCE }, socket: {} } as unknown as VercelRequest, r);
    expect(out.status).toBe(503);
  });
});

describe("cron-check-payments — a Redis hiccup never drops a checkout from the safety net", () => {
  it("an intent that cannot be read is an error of this run and stays in the index (it was removed as 'gone')", async () => {
    mocks.smembers.mockResolvedValue([REFERENCE]);
    mocks.failGets.add(`payment-intent:${REFERENCE}`);
    const { r, out } = res();
    await cron({ method: "GET", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {} } as unknown as VercelRequest, r);
    expect(out.status).toBe(200);
    expect(mocks.srem).not.toHaveBeenCalled();
    expect((out.body.outcome as { errors: number; dropped: number })).toMatchObject({ errors: 1, dropped: 0 });
  });
});
