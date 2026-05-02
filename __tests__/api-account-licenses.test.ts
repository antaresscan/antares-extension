import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  getLicensesByEmail: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue("OK");
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/license", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/license")>(
    "../api/_lib/license",
  );
  return { ...actual, getLicensesByEmail: mocks.getLicensesByEmail };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return {
    ...actual,
    // Disable rate-limit gate for unit tests so we focus on auth logic.
    checkRateLimit: vi.fn().mockResolvedValue(true),
    initRateLimiters: vi.fn(),
  };
});

import handler from "../api/account-licenses";

const ORIGIN = "https://antares-website.vercel.app";
const VALID_KEY = "ANT-AAAA-BBBB-CCCC-DDDD";

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
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

function makeLicense(overrides: Record<string, unknown> = {}) {
  return {
    key: VALID_KEY,
    email: "buyer@example.com",
    tier: "pro",
    intentReference: "ref-1",
    amountUsd: 24.99,
    createdAt: 1_000_000,
    redeemed: false,
    expiresAt: 2_000_000,
    ...overrides,
  };
}

describe("POST /api/account-licenses", () => {
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

  it("rejects missing email with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects missing license_key with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "buyer@example.com" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed license_key with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "buyer@example.com", license_key: "garbage" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 403 when email has no licenses (don't leak existence)", async () => {
    mocks.getLicensesByEmail.mockResolvedValueOnce([]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "nobody@nowhere.com", license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 403 when key doesn't belong to that email", async () => {
    mocks.getLicensesByEmail.mockResolvedValueOnce([
      makeLicense({ key: "ANT-XXXX-YYYY-ZZZZ-WWWW" }),
    ]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "buyer@example.com", license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns the license list when proof matches", async () => {
    const lic1 = makeLicense();
    const lic2 = makeLicense({
      key: "ANT-1111-2222-3333-4444",
      tier: "lifetime",
      intentReference: "ref-life",
      expiresAt: undefined,
    });
    mocks.getLicensesByEmail.mockResolvedValueOnce([lic1, lic2]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "buyer@example.com", license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      ok: boolean;
      email: string;
      licenses: Array<{ key: string; tier: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.email).toBe("buyer@example.com");
    expect(payload.licenses).toHaveLength(2);
    expect(payload.licenses.map((l) => l.key)).toContain(VALID_KEY);
  });

  it("strips intent references from response (private fields stay private)", async () => {
    mocks.getLicensesByEmail.mockResolvedValueOnce([makeLicense()]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "buyer@example.com", license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { licenses: Array<Record<string, unknown>> };
    expect(payload.licenses[0]).not.toHaveProperty("intentReference");
    expect(payload.licenses[0]).not.toHaveProperty("redeemedBy");
  });

  it("normalises email casing before lookup", async () => {
    mocks.getLicensesByEmail.mockResolvedValueOnce([makeLicense()]);
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "Buyer@Example.COM", license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mocks.getLicensesByEmail).toHaveBeenCalledWith(
      expect.anything(),
      "buyer@example.com",
    );
  });

  it("returns 503 when Redis unconfigured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { email: "buyer@example.com", license_key: VALID_KEY },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
