import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const mocks = vi.hoisted(() => ({
  redeem: vi.fn() as ReturnType<typeof vi.fn>,
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
  return { ...actual, redeemLicense: mocks.redeem };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return { ...actual };
});

import handler from "../api/redeem";

const ORIGIN = "https://antares-website.vercel.app";
const VALID_INSTALL = "install-test-aaaaaaaaaaaa";
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

describe("POST /api/redeem", () => {
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

  it("rejects invalid license-key format with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: "not-a-key", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed install_id with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY, install_id: "x" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 200 + tier on successful redemption", async () => {
    mocks.redeem.mockResolvedValueOnce({
      ok: true,
      license: {
        key: VALID_KEY,
        email: "buyer@example.com",
        tier: "pro",
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        redeemed: true,
        redeemedBy: VALID_INSTALL,
        redeemedAt: Date.now(),
        amountUsd: 24.99,
        intentReference: "ref-1",
        createdAt: Date.now(),
      },
    });
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY, install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { ok: boolean; tier: string };
    expect(payload.ok).toBe(true);
    expect(payload.tier).toBe("pro");
  });

  it("returns 404 when license not found", async () => {
    mocks.redeem.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY, install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 409 when license already redeemed by someone else", async () => {
    mocks.redeem.mockResolvedValueOnce({ ok: false, reason: "already_redeemed" });
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY, install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("uppercases the license key before validation (UX: don't make users care about case)", async () => {
    mocks.redeem.mockResolvedValueOnce({
      ok: true,
      license: {
        key: VALID_KEY,
        email: "buyer@example.com",
        tier: "pro",
        expiresAt: Date.now(),
        redeemed: true,
        amountUsd: 24.99,
        intentReference: "x",
        createdAt: Date.now(),
      },
    });
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY.toLowerCase(), install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(mocks.redeem).toHaveBeenCalledWith(
      expect.anything(),
      VALID_KEY,
      VALID_INSTALL,
    );
  });

  it("returns 503 when Redis is unconfigured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY, install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("disables HTTP caching", async () => {
    mocks.redeem.mockResolvedValueOnce({
      ok: true,
      license: {
        key: VALID_KEY,
        email: "x@y.co",
        tier: "pro",
        expiresAt: Date.now(),
        redeemed: true,
        amountUsd: 24.99,
        intentReference: "x",
        createdAt: Date.now(),
      },
    });
    const req = mockReq({
      headers: { origin: ORIGIN },
      body: { license_key: VALID_KEY, install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    const cacheControl = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Cache-Control");
    expect(cacheControl[cacheControl.length - 1][1]).toContain("no-store");
  });
});
