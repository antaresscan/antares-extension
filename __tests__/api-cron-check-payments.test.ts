// __tests__/api-cron-check-payments.test.ts — NOWPayments reconciliation cron.
//
// Covers: auth gate, env-config gate, pending iteration, confirm path,
// expire path, underpay-skip path, and the empty-pending-set short-circuit.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  pending: new Set<string>(),
  getPayment: vi.fn(),
  listPaymentsForInvoice: vi.fn().mockResolvedValue([]),
  setUserTier: vi.fn().mockResolvedValue(undefined),
  issueLicense: vi.fn(),
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown) => {
      mocks.store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
    sadd = vi.fn(async (_k: string, ...members: string[]) => {
      for (const m of members) mocks.pending.add(m);
      return members.length;
    });
    smembers = vi.fn(async () => Array.from(mocks.pending));
    srem = vi.fn(async (_k: string, ...members: string[]) => {
      let n = 0;
      for (const m of members) {
        if (mocks.pending.delete(m)) n++;
      }
      return n;
    });
    hset = vi.fn().mockResolvedValue(1);
    hgetall = vi.fn().mockResolvedValue(null);
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/nowpayments", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/nowpayments")>(
    "../api/_lib/nowpayments",
  );
  return {
    ...actual,
    getPayment: mocks.getPayment,
    listPaymentsForInvoice: mocks.listPaymentsForInvoice,
  };
});

vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>(
    "../api/_lib/user",
  );
  return {
    ...actual,
    initUserStorage: vi.fn(),
    setUserTier: mocks.setUserTier,
  };
});

vi.mock("../api/_lib/license", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/license")>(
    "../api/_lib/license",
  );
  return {
    ...actual,
    issueLicense: mocks.issueLicense,
  };
});

import handler from "../api/cron-check-payments";

const REFERENCE = "b".repeat(64);

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
}

function mockReq({
  method = "GET",
  headers = { "x-vercel-cron": "1" },
}: MockReqOpts = {}): VercelRequest {
  return { method, headers, query: {}, socket: {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

function seedPendingIntent(opts: { amountUsd?: number; expiresIn?: number } = {}) {
  const intent = {
    reference: REFERENCE,
    installId: "install-test-aaaaaaaaaaaa",
    email: "buyer@example.com",
    tier: "monthly" as const,
    amountUsd: opts.amountUsd ?? 24.99,
    payUrl: "https://nowpayments.io/payment?iid=inv-1",
    npInvoiceId: "inv-1",
    createdAt: Date.now(),
    expiresAt: Date.now() + (opts.expiresIn ?? 60 * 60 * 1000),
    status: "pending" as const,
  };
  mocks.store.set(`payment-intent:${REFERENCE}`, intent);
  mocks.pending.add(REFERENCE);
  return intent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  mocks.pending.clear();
  mocks.getPayment.mockReset();
  mocks.listPaymentsForInvoice.mockReset().mockResolvedValue([]);
  mocks.issueLicense.mockResolvedValue({
    key: "ANT-AAAA-BBBB-CCCC-DDDD",
    email: "buyer@example.com",
    tier: "pro",
    intentReference: REFERENCE,
    amountUsd: 24.99,
    createdAt: Date.now(),
    redeemed: false,
  });
  process.env.NOWPAYMENTS_API_KEY = "test-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.CRON_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("GET /api/cron-check-payments", () => {
  it("rejects unauthorized requests with 401", async () => {
    const req = mockReq({ headers: {} });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("accepts Bearer token via CRON_SECRET", async () => {
    process.env.CRON_SECRET = "my-secret";
    const req = mockReq({ headers: { authorization: "Bearer my-secret" } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects PUT/DELETE methods with 405", async () => {
    const req = mockReq({ method: "DELETE" });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("returns 503 when NOWPAYMENTS_API_KEY is missing", async () => {
    delete process.env.NOWPAYMENTS_API_KEY;
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("scans 0 when pending index is empty", async () => {
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { ok: boolean; outcome: { scanned: number } };
    expect(payload.ok).toBe(true);
    expect(payload.outcome.scanned).toBe(0);
  });

  it("expires intents past TTL", async () => {
    seedPendingIntent({ expiresIn: -1000 });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { outcome: { expired: number } };
    expect(payload.outcome.expired).toBe(1);
  });

  it("confirms intent + issues license when NOWPayments returns 'finished'", async () => {
    seedPendingIntent();
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      {
        payment_id: "pay-1",
        payment_status: "finished",
        invoice_id: "inv-1",
        price_amount: 24.99,
        payin_hash: "0xabc",
      },
    ]);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { outcome: { confirmed: number } };
    expect(payload.outcome.confirmed).toBe(1);
    expect(mocks.issueLicense).toHaveBeenCalledOnce();
    expect(mocks.setUserTier).toHaveBeenCalledOnce();
  });

  it("expires intent when NOWPayments reports 'failed'", async () => {
    seedPendingIntent();
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      {
        payment_id: "pay-fail",
        payment_status: "failed",
        invoice_id: "inv-1",
        price_amount: 24.99,
      },
    ]);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { outcome: { expired: number } };
    expect(payload.outcome.expired).toBe(1);
  });

  it("skips underpaid intents (does NOT confirm)", async () => {
    seedPendingIntent({ amountUsd: 24.99 });
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      {
        payment_id: "pay-low",
        payment_status: "finished",
        invoice_id: "inv-1",
        price_amount: 1, // way below 24.99
      },
    ]);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { outcome: { confirmed: number; expired: number } };
    expect(payload.outcome.confirmed).toBe(0);
    expect(payload.outcome.expired).toBe(0);
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });

  it("leaves pending intents untouched when no provider payment yet", async () => {
    seedPendingIntent();
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([]);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { outcome: { confirmed: number; expired: number } };
    expect(payload.outcome.confirmed).toBe(0);
    expect(payload.outcome.expired).toBe(0);
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });
});
