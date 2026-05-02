import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { PaymentIntent } from "../api/_lib/solana-pay";

// vi.hoisted runs before any vi.mock calls — required because the mock
// factory functions reference these vi.fn() values, and without hoisting
// they're in a temporal-dead-zone when the mock setup runs.
const mocks = vi.hoisted(() => {
  return {
    redisGet: vi.fn() as ReturnType<typeof vi.fn>,
    redisSet: vi.fn().mockResolvedValue("OK") as ReturnType<typeof vi.fn>,
    redisSmembers: vi.fn() as ReturnType<typeof vi.fn>,
    redisSrem: vi.fn().mockResolvedValue(1) as ReturnType<typeof vi.fn>,
    listPending: vi.fn() as ReturnType<typeof vi.fn>,
    getIntent: vi.fn() as ReturnType<typeof vi.fn>,
    checkOnChain: vi.fn() as ReturnType<typeof vi.fn>,
    markConfirmed: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
    markExpired: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
    setUserTier: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  };
});

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = mocks.redisGet;
    set = mocks.redisSet;
    sadd = vi.fn().mockResolvedValue(1);
    smembers = mocks.redisSmembers;
    srem = mocks.redisSrem;
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/solana-pay", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/solana-pay")>(
    "../api/_lib/solana-pay",
  );
  return {
    ...actual,
    listPendingIntentReferences: mocks.listPending,
    getPaymentIntent: mocks.getIntent,
    checkIntentOnChain: mocks.checkOnChain,
    markIntentConfirmed: mocks.markConfirmed,
    markIntentExpired: mocks.markExpired,
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

const mockListPending = mocks.listPending;
const mockGetIntent = mocks.getIntent;
const mockCheckOnChain = mocks.checkOnChain;
const mockMarkConfirmed = mocks.markConfirmed;
const mockMarkExpired = mocks.markExpired;
const mockSetUserTier = mocks.setUserTier;

import handler from "../api/cron-check-payments";

const VALID_INSTALL = "install-test-aaaaaaaaaaaa";
const VALID_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    reference: "ref-aaa",
    installId: VALID_INSTALL,
    tier: "monthly",
    recipient: VALID_RECIPIENT,
    amount: 14.99,
    splTokenMint: USDC_MINT,
    payUrl: "solana:...",
    createdAt: Date.now() - 10000,
    expiresAt: Date.now() + 60 * 60 * 1000,
    status: "pending",
    ...over,
  };
}

function cronReq(headers: Record<string, string> = {}, method = "GET"): VercelRequest {
  return { method, headers, query: {}, socket: {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  process.env.HELIUS_API_KEY = "fake-helius";
  process.env.CRON_SECRET = "test-cron-secret";
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.HELIUS_API_KEY;
  delete process.env.CRON_SECRET;
});

describe("cron /api/cron-check-payments", () => {
  it("rejects unauthorized requests with 401", async () => {
    const req = cronReq({});
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("accepts requests carrying x-vercel-cron header", async () => {
    mockListPending.mockResolvedValueOnce([]);
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it("accepts manual requests with Bearer CRON_SECRET", async () => {
    mockListPending.mockResolvedValueOnce([]);
    const req = cronReq({ authorization: "Bearer test-cron-secret" });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it("rejects PUT/DELETE etc with 405", async () => {
    const req = cronReq({ "x-vercel-cron": "1" }, "DELETE");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("returns 503 if HELIUS_API_KEY is unset", async () => {
    delete process.env.HELIUS_API_KEY;
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns scanned=0 when no pending intents", async () => {
    mockListPending.mockResolvedValueOnce([]);
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { ok: boolean; outcome: { scanned: number } };
    expect(payload.outcome.scanned).toBe(0);
  });

  it("marks expired intents and increments expired counter", async () => {
    mockListPending.mockResolvedValueOnce(["ref-old"]);
    mockGetIntent.mockResolvedValueOnce(
      intent({ reference: "ref-old", expiresAt: Date.now() - 1000 }),
    );
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);
    expect(mockMarkExpired).toHaveBeenCalledOnce();
    expect(mockSetUserTier).not.toHaveBeenCalled();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { outcome: { expired: number } };
    expect(payload.outcome.expired).toBe(1);
  });

  it("flips user to Pro and marks intent confirmed when on-chain check passes", async () => {
    mockListPending.mockResolvedValueOnce(["ref-pay"]);
    mockGetIntent.mockResolvedValueOnce(intent({ reference: "ref-pay", tier: "monthly" }));
    mockCheckOnChain.mockResolvedValueOnce({
      confirmed: true,
      txSignature: "sig-fast",
    });
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);

    expect(mockSetUserTier).toHaveBeenCalledWith(
      VALID_INSTALL,
      "pro",
      expect.any(Number),
    );
    expect(mockMarkConfirmed).toHaveBeenCalled();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { outcome: { confirmed: number } };
    expect(payload.outcome.confirmed).toBe(1);
  });

  it("flips user to Lifetime without expiry when tier=lifetime", async () => {
    mockListPending.mockResolvedValueOnce(["ref-life"]);
    mockGetIntent.mockResolvedValueOnce(intent({ reference: "ref-life", tier: "lifetime" }));
    mockCheckOnChain.mockResolvedValueOnce({
      confirmed: true,
      txSignature: "sig-life",
    });
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);

    expect(mockSetUserTier).toHaveBeenCalledWith(VALID_INSTALL, "lifetime", undefined);
  });

  it("leaves still-pending intents alone (no setUserTier, no mark)", async () => {
    mockListPending.mockResolvedValueOnce(["ref-pending"]);
    mockGetIntent.mockResolvedValueOnce(intent({ reference: "ref-pending" }));
    mockCheckOnChain.mockResolvedValueOnce({ confirmed: false });
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);

    expect(mockSetUserTier).not.toHaveBeenCalled();
    expect(mockMarkConfirmed).not.toHaveBeenCalled();
    expect(mockMarkExpired).not.toHaveBeenCalled();
  });

  it("counts errors when an intent throws and continues with the rest", async () => {
    mockListPending.mockResolvedValueOnce(["ref-bad", "ref-ok"]);
    mockGetIntent
      .mockResolvedValueOnce(intent({ reference: "ref-bad" }))
      .mockResolvedValueOnce(intent({ reference: "ref-ok" }));
    mockCheckOnChain
      .mockRejectedValueOnce(new Error("helius timeout"))
      .mockResolvedValueOnce({ confirmed: false });
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { outcome: { errors: number; scanned: number } };
    expect(payload.outcome.scanned).toBe(2);
    expect(payload.outcome.errors).toBe(1);
  });

  it("skips stale index entries (intent missing in get)", async () => {
    mockListPending.mockResolvedValueOnce(["ref-dangling"]);
    mockGetIntent.mockResolvedValueOnce(null);
    const req = cronReq({ "x-vercel-cron": "1" });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { outcome: { errors: number } };
    expect(payload.outcome.errors).toBe(1);
    expect(mockSetUserTier).not.toHaveBeenCalled();
  });
});
