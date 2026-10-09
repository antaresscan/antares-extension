import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

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

import handler from "../api/history";

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

const ORIGIN = "chrome-extension://noemghbbbgcpnocdcflcaccnhnfehpfa";
const INSTALL = "install-history-test-bbbb";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/history", () => {
  it("handles OPTIONS preflight with 204", async () => {
    const req = mockReq({ method: "OPTIONS", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("rejects POST with 405", async () => {
    const req = mockReq({
      method: "POST",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("returns 401 when install_id is missing", async () => {
    const req = mockReq({ headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 403 for disallowed origins", async () => {
    const req = mockReq({
      headers: { origin: "https://attacker.example.com", "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns history payload (empty by default) for valid GET", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as {
      items: unknown[];
      count: number;
      tier: string;
      retentionDays: number;
      limit: number;
    };
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.count).toBe(0);
    expect(payload.tier).toBe("free");
    expect(payload.retentionDays).toBeGreaterThan(0);
    expect(payload.limit).toBeGreaterThan(0);
  });

  it("clamps Free-tier limit to the smaller cap", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      query: { limit: "1000" },
    });
    const res = mockRes();
    await handler(req, res);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { limit: number };
    // Free is capped at 10 — even when client requests 1000
    expect(payload.limit).toBeLessThanOrEqual(10);
  });

  it("disables caching to avoid serving stale history", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    // Middleware sets "s-maxage=15, ..." first; history handler then overrides
    // with "no-store, max-age=0" because quota state is per-request. Assert
    // the *last* Cache-Control wins.
    const cacheControlCalls = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Cache-Control");
    expect(cacheControlCalls.length).toBeGreaterThan(0);
    const lastValue = cacheControlCalls[cacheControlCalls.length - 1][1];
    expect(lastValue).toContain("no-store");
  });

  it("accepts a custom since timestamp", async () => {
    const since = String(Date.now() - 60_000);
    const req = mockReq({
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      query: { since },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
  });
});
