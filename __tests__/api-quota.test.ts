import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── Mocks (must come before importing the handler) ───────────────────────────

vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    incr = vi.fn().mockResolvedValue(1);
    expire = vi.fn().mockResolvedValue(1);
  }
  return { Redis: MockRedis };
});

vi.mock("@upstash/ratelimit", () => {
  class MockRatelimit {
    limit = vi.fn().mockResolvedValue({ success: true, remaining: 29 });
    static slidingWindow = vi.fn();
  }
  return { Ratelimit: MockRatelimit };
});

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return {
    ...actual,
    initRateLimiters: vi.fn(),
    checkRateLimit: vi.fn().mockResolvedValue(true),
  };
});

// Import after mocks are wired
import handler from "../api/quota";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(
  headers: Record<string, string> = {},
  method = "GET",
): VercelRequest {
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

const VALID_INSTALL = "install-test-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/quota", () => {
  it("handles OPTIONS preflight with 204 No Content", async () => {
    const req = mockReq({ origin: "chrome-extension://abc" }, "OPTIONS");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });

  it("rejects POST with 405 Method Not Allowed", async () => {
    const req = mockReq({ origin: "chrome-extension://abc" }, "POST");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("returns 403 when origin is not allowed", async () => {
    const req = mockReq({ origin: "https://malicious.example.com" });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns quota status JSON for valid GET with install_id", async () => {
    const req = mockReq({
      origin: "chrome-extension://abc",
      "x-antares-install": VALID_INSTALL,
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledOnce();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      tier: string;
      limit: number;
      remaining: number;
      unlimited: boolean;
    };
    // Without Redis init in tests, falls back to permissive Free defaults
    expect(payload).toMatchObject({ tier: "free" });
    expect(typeof payload.limit).toBe("number");
    expect(typeof payload.remaining).toBe("number");
    expect(typeof payload.unlimited).toBe("boolean");
  });

  it("sets quota response headers and disables caching", async () => {
    const req = mockReq({
      origin: "chrome-extension://abc",
      "x-antares-install": VALID_INSTALL,
    });
    const res = mockRes();
    await handler(req, res);

    const headers = (res.setHeader as unknown as { mock: { calls: [string, string][] } }).mock
      .calls;
    const headerNames = headers.map(([name]) => name);
    expect(headerNames).toContain("X-Antares-Quota-Tier");
    expect(headerNames).toContain("X-Antares-Quota-Limit");
    expect(headerNames).toContain("X-Antares-Quota-Remaining");
    expect(headerNames).toContain("Cache-Control");
  });

  it("falls back to IP when install header is missing", async () => {
    const req = mockReq({
      origin: "chrome-extension://abc",
      "x-real-ip": "1.2.3.4",
    });
    const res = mockRes();
    await handler(req, res);
    // Should not 401 — anonymous traffic is allowed for /api/quota (read-only)
    expect(res.json).toHaveBeenCalledOnce();
  });
});
