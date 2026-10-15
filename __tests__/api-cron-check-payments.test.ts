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

// Vercel starts the sweep with `Authorization: Bearer <CRON_SECRET>` (audit A-28): that is how these tests ask, unless they say otherwise.
const CRON_SECRET = "test-cron-secret-0123456789abcdef";

function mockReq({
  method = "GET",
  headers = { authorization: `Bearer ${CRON_SECRET}` },
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
  process.env.CRON_SECRET = CRON_SECRET;
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
        price_amount: 24.99, // the invoiced price, always echoed back: NOT what was paid
        pay_amount: 100,
        actually_paid: 10, // the buyer sent a tenth of what was asked
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

  it("(A-04) confirms a payment that finished AFTER the window (the daily run could never do this when it expired on the clock first)", async () => {
    seedPendingIntent({ expiresIn: -23 * 60 * 60 * 1000 }); // the 1 h window ended 23 h ago
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      { payment_id: "pay-late", payment_status: "finished", invoice_id: "inv-1", price_amount: 24.99, pay_amount: 0.4, actually_paid: 0.4, payin_hash: "0xlate" },
    ]);
    const res = mockRes();
    await handler(mockReq(), res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { outcome: { confirmed: number; expired: number } };
    expect(payload.outcome.confirmed).toBe(1);
    expect(payload.outcome.expired).toBe(0);
    expect(mocks.issueLicense).toHaveBeenCalledOnce();
  });

  it("(A-04) keeps an intent pending when its payment is still in flight past the window", async () => {
    seedPendingIntent({ expiresIn: -2 * 60 * 60 * 1000 });
    mocks.listPaymentsForInvoice.mockResolvedValueOnce([
      { payment_id: "pay-slow", payment_status: "confirming", invoice_id: "inv-1", price_amount: 24.99 },
    ]);
    const res = mockRes();
    await handler(mockReq(), res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { outcome: { pending: number; expired: number } };
    expect(payload.outcome.expired).toBe(0);
    expect(payload.outcome.pending).toBe(1);
    expect(mocks.pending.has(REFERENCE)).toBe(true);
  });

  it("(A-04) a reference whose intent is gone is removed from the pending index (it used to stay forever, counted as an error)", async () => {
    mocks.pending.add("a".repeat(64)); // in the index, but no intent behind it
    const res = mockRes();
    await handler(mockReq(), res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { outcome: { scanned: number; dropped: number; errors: number } };
    expect(payload.outcome).toMatchObject({ scanned: 1, dropped: 1, errors: 0 });
    expect(mocks.pending.size).toBe(0);
  });

  it("(A-04) NOWPayments unreachable: the intent is left pending and counted as an error, never expired", async () => {
    seedPendingIntent({ expiresIn: -2 * 60 * 60 * 1000 });
    mocks.listPaymentsForInvoice.mockRejectedValueOnce(new Error("NOWPayments /payment/ failed: 503"));
    const res = mockRes();
    await handler(mockReq(), res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { outcome: { errors: number; expired: number } };
    expect(payload.outcome.errors).toBe(1);
    expect(payload.outcome.expired).toBe(0);
    expect(mocks.pending.has(REFERENCE)).toBe(true);
  });
});


// ── (A-28) who may start the sweep ─────────────────────────────────────────────────────────────────
// The sweep asks NOWPayments about every pending checkout, so it must not start for a stranger. `x-vercel-cron: 1` used to be enough on its own:
// anybody can type it. Now only `Authorization: Bearer <CRON_SECRET>` opens it, which is what Vercel sends itself (documented), and the owner can
// send by hand. Nothing must be read or asked before that gate.
describe("(A-28) the sweep opens for the secret and for nothing else", () => {
  /** What the sweep must NOT do for a caller who is refused: ask NOWPayments, confirm, expire, or even look at the pending checkouts. */
  function untouched() {
    expect(mocks.getPayment).not.toHaveBeenCalled();
    expect(mocks.listPaymentsForInvoice).not.toHaveBeenCalled();
    expect(mocks.issueLicense).not.toHaveBeenCalled();
    expect(mocks.setUserTier).not.toHaveBeenCalled();
    expect(mocks.pending.has(REFERENCE)).toBe(true); // still waiting, not processed
  }
  const refused = async (headers: Record<string, string>) => {
    seedPendingIntent({ expiresIn: -2 * 60 * 60 * 1000 }); // a checkout the sweep WOULD expire if it ran
    const res = mockRes();
    await handler(mockReq({ headers }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    untouched();
  };

  it("the header a stranger can type, alone: refused, and nothing is asked of NOWPayments", async () => {
    await refused({ "x-vercel-cron": "1" });
  });

  it("the forged header with a CRON_SECRET on the deployment but no Authorization: refused", async () => {
    await refused({ "x-vercel-cron": "1", "x-vercel-cron-schedule": "0 0 * * *", "user-agent": "vercel-cron/1.0" });
  });

  it("a wrong secret is refused, even with the forged header", async () => {
    await refused({ authorization: "Bearer not-the-secret", "x-vercel-cron": "1" });
  });

  it("a secret of another length (shorter, longer, empty) is refused and nothing is thrown", async () => {
    for (const given of ["Bearer a", `Bearer ${CRON_SECRET}-and-more`, "Bearer ", "Bearer"]) {
      mocks.pending.clear();
      await refused({ authorization: given });
    }
  });

  it("the secret without the Bearer word, or with another case, is refused: Vercel sends 'Bearer <secret>'", async () => {
    await refused({ authorization: CRON_SECRET });
    mocks.pending.clear();
    await refused({ authorization: `bearer ${CRON_SECRET}` });
    mocks.pending.clear();
    await refused({ authorization: `Basic ${CRON_SECRET}` });
  });

  it("no CRON_SECRET on the deployment: NOTHING opens it, not the forged header, not an empty Bearer, not 'Bearer undefined'", async () => {
    delete process.env.CRON_SECRET;
    for (const headers of [
      { "x-vercel-cron": "1" },
      { authorization: "Bearer " },
      { authorization: "Bearer undefined" },
      { authorization: "Bearer" },
      { authorization: "" },
    ] as Array<Record<string, string>>) {
      mocks.pending.clear();
      await refused(headers);
    }
  });

  it("exactly what Vercel sends (the secret as Bearer, its user agent, its schedule header): the sweep runs", async () => {
    seedPendingIntent({ expiresIn: -2 * 60 * 60 * 1000 });
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: `Bearer ${CRON_SECRET}`, "user-agent": "vercel-cron/1.0", "x-vercel-cron-schedule": "0 0 * * *" } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { outcome: { scanned: number; expired: number } };
    expect(payload.outcome.scanned).toBe(1);
    expect(payload.outcome.expired).toBe(1);
  });

  it("the owner starting it by hand with the same secret works too", async () => {
    const res = mockRes();
    await handler(mockReq({ method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("the forged header next to the right secret changes nothing: the secret decides", async () => {
    const res = mockRes();
    await handler(mockReq({ headers: { authorization: `Bearer ${CRON_SECRET}`, "x-vercel-cron": "1" } }), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("the gate comes before everything else: a refused caller gets 401, not a hint about NOWPayments or the storage", async () => {
    delete process.env.NOWPAYMENTS_API_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    const res = mockRes();
    await handler(mockReq({ headers: { "x-vercel-cron": "1" } }), res);
    expect(res.status).toHaveBeenCalledWith(401); // not 503: a stranger learns nothing about how the deployment is configured
  });
});
