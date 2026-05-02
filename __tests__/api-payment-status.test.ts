import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { PaymentIntent } from "../api/_lib/solana-pay";

// vi.hoisted runs before vi.mock, required because mock factories reference
// the vi.fn() values below.
const mocks = vi.hoisted(() => ({
  redisGet: vi.fn() as ReturnType<typeof vi.fn>,
  redisSet: vi.fn().mockResolvedValue("OK") as ReturnType<typeof vi.fn>,
  redisSrem: vi.fn().mockResolvedValue(1) as ReturnType<typeof vi.fn>,
  checkOnChain: vi.fn() as ReturnType<typeof vi.fn>,
  markConfirmed: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
  setUserTier: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>,
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = mocks.redisGet;
    set = mocks.redisSet;
    sadd = vi.fn().mockResolvedValue(1);
    smembers = vi.fn().mockResolvedValue([]);
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
    checkIntentOnChain: mocks.checkOnChain,
    markIntentConfirmed: mocks.markConfirmed,
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

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return { ...actual };
});

import handler from "../api/payment-status";

const mockGet = mocks.redisGet;

const ORIGIN = "https://antares-website.vercel.app";
const VALID_REFERENCE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

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

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    reference: VALID_REFERENCE,
    installId: "install-test-aaaaaaaaaaaa",
    tier: "monthly",
    token: "usdc",
    recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: 24.99,
    amountUsd: 24.99,
    splTokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payUrl: `solana:${VALID_REFERENCE}?amount=24.99`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
    status: "pending",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  // Without HELIUS_API_KEY the lazy on-chain check is a no-op — tests
  // that don't care about confirmation default to skipping it.
  delete process.env.HELIUS_API_KEY;
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.HELIUS_API_KEY;
});

describe("GET /api/payment-status", () => {
  it("handles OPTIONS with 204", async () => {
    const req = mockReq({ method: "OPTIONS", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("rejects POST with 405", async () => {
    const req = mockReq({ method: "POST", headers: { origin: ORIGIN } });
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

  it("rejects missing reference with 400", async () => {
    const req = mockReq({ headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed reference with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: "0000" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 not_found when intent doesn't exist", async () => {
    mockGet.mockResolvedValueOnce(null);
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: VALID_REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns the pending status when intent is fresh", async () => {
    mockGet.mockResolvedValueOnce(intent());
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: VALID_REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { status: string };
    expect(payload.status).toBe("pending");
  });

  it("returns confirmed status with txSignature", async () => {
    mockGet.mockResolvedValueOnce(
      intent({
        status: "confirmed",
        txSignature: "sig-abcdef",
        confirmedAt: Date.now(),
      }),
    );
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: VALID_REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { status: string; txSignature: string };
    expect(payload.status).toBe("confirmed");
    expect(payload.txSignature).toBe("sig-abcdef");
  });

  it("flips pending → expired client-side when expiresAt is in the past", async () => {
    mockGet.mockResolvedValueOnce(
      intent({ status: "pending", expiresAt: Date.now() - 1000 }),
    );
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: VALID_REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { status: string };
    // The cron may not have visited it yet, but we surface "expired" so the
    // page UI shows the correct state immediately.
    expect(payload.status).toBe("expired");
  });

  it("disables HTTP caching for live status polling", async () => {
    mockGet.mockResolvedValueOnce(intent());
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { reference: VALID_REFERENCE },
    });
    const res = mockRes();
    await handler(req, res);
    const cacheControl = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Cache-Control");
    const lastValue = cacheControl[cacheControl.length - 1][1];
    expect(lastValue).toContain("no-store");
  });

  // ─── Lazy on-chain confirmation ────────────────────────────────────────────

  describe("lazy on-chain check", () => {
    beforeEach(() => {
      process.env.HELIUS_API_KEY = "fake-helius";
    });

    it("flips the user to Pro and updates the response when payment lands", async () => {
      mockGet.mockResolvedValueOnce(intent({ status: "pending" }));
      mocks.checkOnChain.mockResolvedValueOnce({
        confirmed: true,
        txSignature: "sig-fast",
      });

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      expect(mocks.setUserTier).toHaveBeenCalledWith(
        "install-test-aaaaaaaaaaaa",
        "pro",
        expect.any(Number),
      );
      expect(mocks.markConfirmed).toHaveBeenCalled();
      const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0][0] as { status: string; txSignature: string };
      expect(payload.status).toBe("confirmed");
      expect(payload.txSignature).toBe("sig-fast");
    });

    it("flips to Lifetime without expiry on lifetime tier", async () => {
      mockGet.mockResolvedValueOnce(intent({ status: "pending", tier: "lifetime" }));
      mocks.checkOnChain.mockResolvedValueOnce({
        confirmed: true,
        txSignature: "sig-life",
      });

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      expect(mocks.setUserTier).toHaveBeenCalledWith(
        "install-test-aaaaaaaaaaaa",
        "lifetime",
        undefined,
      );
    });

    it("does not run the on-chain check when intent is already confirmed", async () => {
      mockGet.mockResolvedValueOnce(
        intent({ status: "confirmed", txSignature: "old-sig" }),
      );

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      expect(mocks.checkOnChain).not.toHaveBeenCalled();
      expect(mocks.setUserTier).not.toHaveBeenCalled();
    });

    it("does not run the on-chain check when intent is past expiry", async () => {
      mockGet.mockResolvedValueOnce(
        intent({ status: "pending", expiresAt: Date.now() - 1000 }),
      );

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      expect(mocks.checkOnChain).not.toHaveBeenCalled();
    });

    it("returns pending unchanged when on-chain check finds no confirming tx", async () => {
      mockGet.mockResolvedValueOnce(intent({ status: "pending" }));
      mocks.checkOnChain.mockResolvedValueOnce({ confirmed: false });

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      expect(mocks.setUserTier).not.toHaveBeenCalled();
      const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0][0] as { status: string };
      expect(payload.status).toBe("pending");
    });

    it("doesn't break the polling response when Helius throws", async () => {
      mockGet.mockResolvedValueOnce(intent({ status: "pending" }));
      mocks.checkOnChain.mockRejectedValueOnce(new Error("helius timeout"));

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      // Helius failure shouldn't bubble — return the stored state and let
      // the next poll (or the cron) catch the confirmation.
      expect(mocks.setUserTier).not.toHaveBeenCalled();
      const payload = (res.json as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0][0] as { status: string };
      expect(payload.status).toBe("pending");
    });

    it("skips the check when HELIUS_API_KEY is unset", async () => {
      delete process.env.HELIUS_API_KEY;
      mockGet.mockResolvedValueOnce(intent({ status: "pending" }));

      const req = mockReq({
        headers: { origin: ORIGIN },
        query: { reference: VALID_REFERENCE },
      });
      const res = mockRes();
      await handler(req, res);

      expect(mocks.checkOnChain).not.toHaveBeenCalled();
    });
  });
});
