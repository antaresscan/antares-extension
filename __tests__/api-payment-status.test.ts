import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { PaymentIntent } from "../api/_lib/solana-pay";

const mockGet = vi.fn();

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = mockGet;
    set = vi.fn().mockResolvedValue("OK");
    sadd = vi.fn().mockResolvedValue(1);
    smembers = vi.fn().mockResolvedValue([]);
    srem = vi.fn().mockResolvedValue(1);
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return { ...actual };
});

import handler from "../api/payment-status";

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
    recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    amount: 14.99,
    splTokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payUrl: `solana:${VALID_REFERENCE}?amount=14.99`,
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
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
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
});
