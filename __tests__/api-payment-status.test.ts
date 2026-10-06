// __tests__/api-payment-status.test.ts — NOWPayments status polling endpoint.
//
// Covers: input validation, intent lookup, lazy-confirm via NOWPayments
// REST API, expiry on TTL hit, license-key surfacing, and the underpay
// short-circuit (delegated to confirmIntent — verified end-to-end here
// to catch any wiring regression).

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
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
    sadd = vi.fn().mockResolvedValue(1);
    smembers = vi.fn().mockResolvedValue([]);
    srem = vi.fn().mockResolvedValue(1);
    hset = vi.fn().mockResolvedValue(1);
    hgetall = vi.fn().mockResolvedValue(null);
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return {
    ...actual,
    checkRateLimit: vi.fn().mockResolvedValue(true),
    initRateLimiters: vi.fn(),
  };
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

import handler from "../api/payment-status";

const ORIGIN = "https://antares-website.vercel.app";
const REFERENCE = "a".repeat(64);

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

function mockReq({
  method = "GET",
  headers = {},
  query = {},
}: MockReqOpts = {}): VercelRequest {
  return { method, headers, query, socket: {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

function seedPendingIntent(
  opts: { amountUsd?: number; npPaymentId?: string; expiresIn?: number } = {},
) {
  const intent = {
    reference: REFERENCE,
    installId: "install-test-aaaaaaaaaaaa",
    email: "buyer@example.com",
    tier: "monthly" as const,
    amountUsd: opts.amountUsd ?? 24.99,
    payUrl: "https://nowpayments.io/payment?iid=inv-1",
    npInvoiceId: "inv-1",
    ...(opts.npPaymentId ? { npPaymentId: opts.npPaymentId } : {}),
    createdAt: Date.now(),
    expiresAt: Date.now() + (opts.expiresIn ?? 60 * 60 * 1000),
    status: "pending" as const,
  };
  mocks.store.set(`payment-intent:${REFERENCE}`, intent);
  return intent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
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
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("GET /api/payment-status (NOWPayments)", () => {
  it("rejects POST with 405", async () => {
    const req = mockReq({ method: "POST", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects disallowed origins with 403", async () => {
    const req = mockReq({ headers: { origin: "https://attacker.example" } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // These endpoints read or change account state: being on the general CORS
  // allowlist (a trading site, a website preview) is not enough.
  it("rejects an origin that is only on the general CORS allowlist with 403", async () => {
    const req = mockReq({ headers: { origin: "https://dexscreener.com" } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects a website preview origin with 403 (anyone can register antares-website-*)", async () => {
    const req = mockReq({
      headers: { origin: "https://antares-website-evil-comealamaisongroupes-projects.vercel.app" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects missing reference query param with 400", async () => {
    const req = mockReq({ headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed reference with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: "not-hex-not-64-chars" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when the intent is not in storage", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 'pending' when NOWPayments has no payment yet", async () => {
    seedPendingIntent();
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string };
    expect(payload.status).toBe("pending");
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });

  it("flips to 'expired' on TTL hit", async () => {
    seedPendingIntent({ expiresIn: -1000 }); // already past expiry
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string };
    expect(payload.status).toBe("expired");
  });

  it("confirms intent + issues license when NOWPayments returns 'finished'", async () => {
    seedPendingIntent();
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      {
        payment_id: "pay-1",
        payment_status: "finished",
        invoice_id: "inv-1",
        order_id: REFERENCE,
        price_amount: 24.99,
        payin_hash: "0xabc",
      },
    ]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mocks.setUserTier).toHaveBeenCalledOnce();
    expect(mocks.issueLicense).toHaveBeenCalledOnce();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string; licenseKey: string | null };
    expect(payload.status).toBe("confirmed");
    expect(payload.licenseKey).toBe("ANT-AAAA-BBBB-CCCC-DDDD");
  });

  it("uses npPaymentId fast path when bound on the intent", async () => {
    seedPendingIntent({ npPaymentId: "pay-fast" });
    mocks.getPayment.mockResolvedValueOnce({
      payment_id: "pay-fast",
      payment_status: "finished",
      invoice_id: "inv-1",
      order_id: REFERENCE,
      price_amount: 24.99,
    });
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mocks.getPayment).toHaveBeenCalledWith("pay-fast");
    expect(mocks.listPaymentsForInvoice).not.toHaveBeenCalled();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string };
    expect(payload.status).toBe("confirmed");
  });

  it("does NOT confirm when underpaid (anti-tamper via confirmIntent)", async () => {
    seedPendingIntent({ amountUsd: 24.99 });
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      {
        payment_id: "pay-underpaid",
        payment_status: "finished",
        invoice_id: "inv-1",
        order_id: REFERENCE,
        price_amount: 1, // way below 24.99 — should reject
      },
    ]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mocks.issueLicense).not.toHaveBeenCalled();
    expect(mocks.setUserTier).not.toHaveBeenCalled();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string; licenseKey: string | null };
    expect(payload.status).toBe("pending");
    expect(payload.licenseKey).toBeNull();
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
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string };
    expect(payload.status).toBe("expired");
  });

  it("picks the most-progressed payment when invoice has multiple", async () => {
    seedPendingIntent();
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      {
        payment_id: "pay-stale",
        payment_status: "waiting",
        invoice_id: "inv-1",
        price_amount: 24.99,
      },
      {
        payment_id: "pay-good",
        payment_status: "finished",
        invoice_id: "inv-1",
        order_id: REFERENCE,
        price_amount: 24.99,
      },
    ]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { status: string };
    expect(payload.status).toBe("confirmed");
  });

  it("disables HTTP caching", async () => {
    seedPendingIntent();
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const cacheControl = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Cache-Control");
    expect(cacheControl.some(([, v]) => v.includes("no-store"))).toBe(true);
  });
});
