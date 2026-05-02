import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn().mockResolvedValue("OK");
    get = vi.fn().mockResolvedValue(null);
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

import handler from "../api/payment-intent";

const ORIGIN = "https://antares-website.vercel.app";
const VALID_INSTALL = "install-test-aaaaaaaaaaaa";
const VALID_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

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
  process.env.SOLANA_RECIPIENT_WALLET = VALID_RECIPIENT;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});

afterEach(() => {
  delete process.env.SOLANA_RECIPIENT_WALLET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("POST /api/payment-intent", () => {
  it("handles OPTIONS preflight with 204 + POST in allow-methods", async () => {
    const req = mockReq({ method: "OPTIONS", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    const allowMethods = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Access-Control-Allow-Methods");
    expect(allowMethods.at(-1)![1]).toContain("POST");
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

  it("rejects missing tier with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects unknown tier with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "yearly", install_id: VALID_INSTALL },
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

  it("returns 503 + checkout_not_configured when SOLANA_RECIPIENT_WALLET is unset", async () => {
    delete process.env.SOLANA_RECIPIENT_WALLET;
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

  it("returns 503 when SOLANA_RECIPIENT_WALLET has invalid format", async () => {
    process.env.SOLANA_RECIPIENT_WALLET = "not-a-real-address";
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("creates an intent and returns the Solana Pay URL for monthly tier", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      reference: string;
      payUrl: string;
      recipient: string;
      amount: number;
      tier: string;
      expiresAt: number;
    };
    expect(payload.tier).toBe("monthly");
    expect(payload.recipient).toBe(VALID_RECIPIENT);
    expect(payload.amount).toBe(14.99);
    expect(payload.payUrl.startsWith(`solana:${VALID_RECIPIENT}?`)).toBe(true);
    expect(payload.payUrl).toContain(`reference=${payload.reference}`);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it("uses lifetime price when tier=lifetime", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "lifetime", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { amount: number; tier: string };
    expect(payload.tier).toBe("lifetime");
    expect(payload.amount).toBe(99);
  });

  it("treats 'pro' as alias for 'monthly'", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { tier: "pro", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { tier: string; amount: number };
    expect(payload.tier).toBe("monthly");
    expect(payload.amount).toBe(14.99);
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
