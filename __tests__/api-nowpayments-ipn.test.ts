// __tests__/api-nowpayments-ipn.test.ts — IPN webhook end-to-end.
//
// Drives the full /api/auth/nowpayments-ipn pipeline:
//   - HMAC-SHA512 signature verification
//   - Intent lookup by order_id / payment_id / invoice_id
//   - confirmIntent → license issuance + tier flip + idempotency
//   - Anti-underpay reject when reported amount < expected
//   - Rate limiting wired through
//
// Bypasses the actual NOWPayments REST client (we don't need it for IPN
// handling — the IPN payload itself is the source of truth).

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  setUserTier: vi.fn().mockResolvedValue(undefined),
  issueLicense: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../api/_lib/sentry", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/sentry")>("../api/_lib/sentry");
  return { ...actual, captureError: mocks.captureError };
});

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn(async (k: string, v: unknown) => {
      mocks.store.set(k, v);
      return "OK";
    });
    get = vi.fn(async (k: string) => mocks.store.get(k) ?? null);
    del = vi.fn(async (k: string) => {
      const had = mocks.store.delete(k);
      return had ? 1 : 0;
    });
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

import dispatcher from "../api/auth/[action]";

const ORIGIN_NONE = ""; // NOWPayments servers don't send Origin
const SECRET = "ipn-test-secret-1234567890abcdef";

const VALID_INSTALL = "install-test-aaaaaaaaaaaa";
const REFERENCE = "0".repeat(63) + "1"; // 64 hex chars (matches generateReference shape)

function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortObject);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortObject(obj[key]);
  }
  return out;
}

function signPayload(payload: Record<string, unknown>): string {
  const sortedJson = JSON.stringify(sortObject(payload));
  return createHmac("sha512", SECRET).update(sortedJson).digest("hex");
}

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

function mockIpnReq({
  method = "POST",
  headers = {},
  body,
}: MockReqOpts = {}): VercelRequest {
  const query = { action: "nowpayments-ipn" };
  return {
    method,
    headers,
    query,
    body,
    socket: {},
  } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

/**
 * Seed Redis with a pending intent for the canonical test scenario.
 * Returns the intent so individual tests can mutate before signing.
 */
function seedPendingIntent(opts: { amountUsd?: number; tier?: "monthly" | "yearly" } = {}) {
  const intent = {
    reference: REFERENCE,
    installId: VALID_INSTALL,
    email: "buyer@example.com",
    tier: opts.tier ?? "monthly",
    amountUsd: opts.amountUsd ?? 24.99,
    payUrl: "https://nowpayments.io/payment?iid=inv-123",
    npInvoiceId: "inv-123",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    status: "pending" as const,
  };
  mocks.store.set(`payment-intent:${REFERENCE}`, intent);
  mocks.store.set(`payment-intent-by-inv:inv-123`, REFERENCE);
  return intent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
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
  process.env.NOWPAYMENTS_API_KEY = "test-key";
  process.env.NOWPAYMENTS_IPN_SECRET = SECRET;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.NOWPAYMENTS_IPN_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("POST /api/auth/nowpayments-ipn", () => {
  it("rejects POST with missing signature header (401)", async () => {
    seedPendingIntent();
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };
    const req = mockIpnReq({ headers: { origin: ORIGIN_NONE }, body });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.setUserTier).not.toHaveBeenCalled();
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });

  it("rejects POST with tampered body (signature won't match)", async () => {
    seedPendingIntent();
    const original = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };
    const sig = signPayload(original);
    // Attacker changes status after signing — HMAC won't validate.
    const tampered = { ...original, price_amount: 0.01 };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": sig },
      body: tampered,
    });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.setUserTier).not.toHaveBeenCalled();
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });

  it("confirms the intent on a valid 'finished' IPN — flips tier + issues license", async () => {
    seedPendingIntent();
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
      payin_hash: "0xabcd",
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.setUserTier).toHaveBeenCalledOnce();
    expect(mocks.setUserTier.mock.calls[0][0]).toBe(VALID_INSTALL);
    expect(mocks.issueLicense).toHaveBeenCalledOnce();
    const issuedArgs = mocks.issueLicense.mock.calls[0][1] as {
      email: string;
      tier: string;
      intentReference: string;
    };
    expect(issuedArgs.email).toBe("buyer@example.com");
    expect(issuedArgs.tier).toBe("monthly");
    expect(issuedArgs.intentReference).toBe(REFERENCE);
  });

  it("auto-binds install→email on first confirm (so next scan resolves Pro without sync-token)", async () => {
    // Pre-condition: NO existing binding in Redis. Confirm should write
    // it from intent.email so the user is auto-synced even if they never
    // visit /account.html.
    seedPendingIntent();
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBeUndefined();

    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Binding should now exist with the intent's email value.
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBe(
      "buyer@example.com",
    );
  });

  it("does NOT overwrite an existing install→email binding (anti-hijack)", async () => {
    // Someone else's email is already bound to this install (e.g.
    // shared browser, prior owner). A confirm from a different payer
    // must NOT overwrite — that would let user B's payment claim
    // user A's install.
    seedPendingIntent();
    mocks.store.set(`account:install:${VALID_INSTALL}`, "owner@previous.example");

    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Binding stays as the original — payer's email DOES NOT clobber it.
    expect(mocks.store.get(`account:install:${VALID_INSTALL}`)).toBe(
      "owner@previous.example",
    );
  });

  it("does NOT bind for synthetic email-only installs (no real install_id to bind)", async () => {
    // Site-direct buyer: no extension installed, intent.installId is
    // 'email:<email>'. There's no install to bind, and writing
    // account:install:email:foo@bar would be useless.
    const syntheticInstall = "email:buyer@example.com";
    const intent = {
      reference: REFERENCE,
      installId: syntheticInstall,
      email: "buyer@example.com",
      tier: "monthly" as const,
      amountUsd: 24.99,
      payUrl: "https://nowpayments.io/payment?iid=inv-123",
      npInvoiceId: "inv-123",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
      status: "pending" as const,
    };
    mocks.store.set(`payment-intent:${REFERENCE}`, intent);
    mocks.store.set(`payment-intent-by-inv:inv-123`, REFERENCE);

    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // No binding written for the synthetic install.
    expect(mocks.store.get(`account:install:${syntheticInstall}`)).toBeUndefined();
  });

  it("REFUSES to confirm when the reported amount is below the expected (anti-underpay)", async () => {
    seedPendingIntent({ amountUsd: 24.99 });
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      // price_amount is the invoiced price, always echoed back: it says nothing about what was paid.
      price_amount: 24.99,
      pay_amount: 0.5,
      actually_paid: 0.1, // the buyer sent a fifth of what was asked — should reject
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { ok: boolean; status: string; reason: string };
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("amount_mismatch");
    expect(payload.reason).toBe("underpaid");
    expect(mocks.setUserTier).not.toHaveBeenCalled();
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });

  it("ignores tiny rounding diff (1% tolerance)", async () => {
    seedPendingIntent({ amountUsd: 100 });
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 100,
      pay_amount: 2,
      actually_paid: 1.99, // 0.5% under — within tolerance
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.issueLicense).toHaveBeenCalledOnce();
  });

  it("returns 200 ignored=true when the intent is not found (avoid retry storm)", async () => {
    // No seedPendingIntent() — store is empty.
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-doesnt-exist",
      price_amount: 24.99,
    };
    const req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { ok: boolean; ignored: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.ignored).toBe(true);
  });

  it("treats waiting/confirming/partially_paid as pending (no tier flip)", async () => {
    seedPendingIntent();
    for (const status of ["waiting", "confirming", "partially_paid"]) {
      mocks.setUserTier.mockClear();
      mocks.issueLicense.mockClear();
      const body = {
        payment_id: "pay-1",
        payment_status: status,
        order_id: REFERENCE,
        invoice_id: "inv-123",
        price_amount: 24.99,
      };
      const req = mockIpnReq({
        headers: { "x-nowpayments-sig": signPayload(body) },
        body,
      });
      const res = mockRes();
      await dispatcher(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mocks.setUserTier).not.toHaveBeenCalled();
      expect(mocks.issueLicense).not.toHaveBeenCalled();
    }
  });

  it("is idempotent on repeated 'finished' deliveries (replay-safe)", async () => {
    seedPendingIntent();
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };

    // First delivery — confirms + issues license.
    let req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    let res = mockRes();
    await dispatcher(req, res);
    expect(mocks.issueLicense).toHaveBeenCalledTimes(1);

    // Second delivery (NOWPayments retries) — should NOT issue a 2nd license.
    req = mockIpnReq({
      headers: { "x-nowpayments-sig": signPayload(body) },
      body,
    });
    res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenLastCalledWith(200);
    expect(mocks.issueLicense).toHaveBeenCalledTimes(1);
  });

  it("(A-04) a CONFIRMED payment whose intent is gone is reported to Sentry (nothing else will ever retry it), still answered 200", async () => {
    const body = {
      payment_id: "pay-orphan",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-gone",
      price_amount: 24.99,
    };
    const req = mockIpnReq({ headers: { "x-nowpayments-sig": signPayload(body) }, body });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.captureError).toHaveBeenCalledOnce();
    expect(mocks.captureError.mock.calls[0][1]).toMatchObject({ phase: "confirmedWithoutIntent", npPaymentId: "pay-orphan" });
  });

  it("(A-04) an unconfirmed payment (waiting) with no intent is NOT reported: only money received is an alert", async () => {
    const body = { payment_id: "pay-w", payment_status: "waiting", order_id: REFERENCE, invoice_id: "inv-gone", price_amount: 24.99 };
    const req = mockIpnReq({ headers: { "x-nowpayments-sig": signPayload(body) }, body });
    await dispatcher(req, mockRes());
    expect(mocks.captureError).not.toHaveBeenCalled();
  });

  it("(A-04) when the license cannot be issued the IPN answers 500 (NOWPayments retries) and the intent stays pending", async () => {
    seedPendingIntent();
    mocks.issueLicense.mockRejectedValueOnce(new Error("redis hiccup"));
    const body = {
      payment_id: "pay-1",
      payment_status: "finished",
      order_id: REFERENCE,
      invoice_id: "inv-123",
      price_amount: 24.99,
    };
    const req = mockIpnReq({ headers: { "x-nowpayments-sig": signPayload(body) }, body });
    const res = mockRes();
    await dispatcher(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect((mocks.store.get(`payment-intent:${REFERENCE}`) as { status: string }).status).toBe("pending");

    // The retry succeeds and confirms.
    const retry = mockRes();
    await dispatcher(mockIpnReq({ headers: { "x-nowpayments-sig": signPayload(body) }, body }), retry);
    expect(retry.status).toHaveBeenCalledWith(200);
    expect((mocks.store.get(`payment-intent:${REFERENCE}`) as { status: string }).status).toBe("confirmed");
  });

  it("(A-16) price_amount alone proves nothing: a full invoiced price with a tenth of the asked crypto sent is refused", async () => {
    seedPendingIntent({ amountUsd: 24.99 });
    const body = {
      payment_id: "pay-1", payment_status: "finished", order_id: REFERENCE, invoice_id: "inv-123",
      price_amount: 24.99, pay_amount: 100, actually_paid: 10,
    };
    const res = mockRes();
    await dispatcher(mockIpnReq({ headers: { "x-nowpayments-sig": signPayload(body) }, body }), res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { status: string; paidRatio: number };
    expect(payload.status).toBe("amount_mismatch");
    expect(payload.paidRatio).toBeCloseTo(0.1);
    expect(mocks.issueLicense).not.toHaveBeenCalled();
  });
});
