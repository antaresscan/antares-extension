// __tests__/api-payment-intent.test.ts — NOWPayments invoice creation flow.
//
// Covers the new contract after the Solana-Pay → NOWPayments migration:
// invoice URL bubbles through, env-gating, input validation, tier mapping.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  redisSet: vi.fn().mockResolvedValue("OK") as ReturnType<typeof vi.fn>,
  redisSadd: vi.fn().mockResolvedValue(1) as ReturnType<typeof vi.fn>,
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = mocks.redisSet;
    get = vi.fn().mockResolvedValue(null);
    sadd = mocks.redisSadd;
    smembers = vi.fn().mockResolvedValue([]);
    srem = vi.fn().mockResolvedValue(1);
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/nowpayments", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/nowpayments")>(
    "../api/_lib/nowpayments",
  );
  return {
    ...actual,
    createInvoice: mocks.createInvoice,
  };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return {
    ...actual,
    // The real `checkRateLimit` calls `redis.evalsha` for an atomic Lua
    // script, which our MockRedis doesn't expose. Bypass for tests so we
    // exercise the validation + invoice paths, not the limiter itself
    // (which has its own coverage in the full middleware tests).
    checkRateLimit: vi.fn().mockResolvedValue(true),
    initRateLimiters: vi.fn(),
  };
});

import handler from "../api/payment-intent";

const ORIGIN = "https://antares-website.vercel.app";
const VALID_INSTALL = "install-test-aaaaaaaaaaaa";

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function mockReq({
  method = "POST",
  headers = {},
  body,
}: MockReqOpts = {}): VercelRequest {
  return { method, headers, query: {}, body, socket: {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOWPAYMENTS_API_KEY = "test-api-key";
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.ANTARES_PUBLIC_BASE_URL = "https://antares-extension.vercel.app";
  // Default invoice mock — individual tests can override.
  mocks.createInvoice.mockResolvedValue({
    id: "np-invoice-1",
    invoice_url: "https://nowpayments.io/payment?iid=np-invoice-1",
    order_id: "ignored-server-side",
    price_amount: "24.99",
    price_currency: "usd",
    created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.ANTARES_PUBLIC_BASE_URL;
});

describe("POST /api/payment-intent (NOWPayments)", () => {
  it("handles OPTIONS preflight with 204", async () => {
    const req = mockReq({ method: "OPTIONS", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("rejects GET with 405", async () => {
    const req = mockReq({ method: "GET", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects disallowed origins with 403", async () => {
    const req = mockReq({ headers: { origin: "https://attacker.example.com" } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 503 + checkout_not_configured when NOWPAYMENTS_API_KEY is unset", async () => {
    delete process.env.NOWPAYMENTS_API_KEY;
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { error: string };
    expect(payload.error).toBe("checkout_not_configured");
  });

  it("rejects unknown tier with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "premium-platinum", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects when neither email nor install_id is provided", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed install_id with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: "x" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed email even when install_id is present", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: {
        tier: "monthly",
        install_id: VALID_INSTALL,
        email: "not-an-email",
      },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("creates an invoice and returns the NOWPayments hosted URL for monthly tier", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mocks.createInvoice).toHaveBeenCalledOnce();
    const invoiceArgs = mocks.createInvoice.mock.calls[0][0] as {
      orderId: string;
      priceAmountUsd: number;
      ipnCallbackUrl: string;
      successUrl: string;
      cancelUrl: string;
    };
    expect(invoiceArgs.priceAmountUsd).toBe(24.99);
    expect(invoiceArgs.ipnCallbackUrl).toContain("/api/auth/nowpayments-ipn");
    expect(invoiceArgs.orderId).toMatch(/^[0-9a-f]{64}$/);

    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      reference: string;
      payUrl: string;
      tier: string;
      amountUsd: number;
      expiresAt: number;
    };
    expect(payload.tier).toBe("monthly");
    expect(payload.amountUsd).toBe(24.99);
    expect(payload.payUrl).toBe("https://nowpayments.io/payment?iid=np-invoice-1");
    expect(payload.reference).toBe(invoiceArgs.orderId);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it("uses yearly price when tier=yearly", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "yearly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { tier: string; amountUsd: number };
    expect(payload.tier).toBe("yearly");
    expect(payload.amountUsd).toBe(149.99);
  });

  it("legacy tier=lifetime in body still mints a yearly invoice", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "lifetime", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { tier: string };
    expect(payload.tier).toBe("yearly");
  });

  it("treats 'pro' as alias for 'monthly'", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "pro", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { tier: string; amountUsd: number };
    expect(payload.tier).toBe("monthly");
    expect(payload.amountUsd).toBe(24.99);
  });

  it("accepts an email + no install_id (site-direct buyer)", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", email: "buyer@example.com" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it("returns 502 when NOWPayments invoice creation fails", async () => {
    mocks.createInvoice.mockRejectedValueOnce(new Error("upstream 500"));
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it("disables HTTP caching", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const cacheControl = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Cache-Control");
    const lastValue = cacheControl[cacheControl.length - 1][1];
    expect(lastValue).toContain("no-store");
  });

  it("parses string-body JSON (some clients send raw string)", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: JSON.stringify({ tier: "monthly", install_id: VALID_INSTALL }),
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
  });
});
