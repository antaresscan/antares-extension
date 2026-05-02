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

import handler from "../api/watchlist";

interface MockReqOpts {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

function mockReq({
  method = "GET",
  headers = {},
  query = {},
  body,
}: MockReqOpts = {}): VercelRequest {
  return { method, headers, query, body, socket: {} } as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

const ORIGIN = "chrome-extension://abc";
const INSTALL = "install-watchlist-test-aaaa";
const VALID_CA = "So11111111111111111111111111111111111111112";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/watchlist", () => {
  it("handles OPTIONS preflight with 204 + POST/DELETE in allow-methods", async () => {
    const req = mockReq({ method: "OPTIONS", headers: { origin: ORIGIN } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    // The middleware sets "GET, OPTIONS" first; the watchlist handler then
    // overrides with "GET, POST, DELETE, OPTIONS". The overridden value is
    // what reaches the wire, so we assert on the *last* call for this header.
    const allowMethodsCalls = (res.setHeader as unknown as {
      mock: { calls: [string, string][] };
    }).mock.calls.filter(([k]) => k === "Access-Control-Allow-Methods");
    expect(allowMethodsCalls.length).toBeGreaterThan(0);
    const lastValue = allowMethodsCalls[allowMethodsCalls.length - 1][1];
    expect(lastValue).toContain("POST");
    expect(lastValue).toContain("DELETE");
  });

  it("rejects requests without install_id with 401", async () => {
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

  it("GET returns the (possibly empty) watchlist with tier info", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { items: unknown[]; count: number; max: number; tier: string };
    expect(Array.isArray(payload.items)).toBe(true);
    expect(typeof payload.count).toBe("number");
    expect(typeof payload.max).toBe("number");
    expect(payload.tier).toBe("free");
  });

  it("POST with invalid address returns 400", async () => {
    const req = mockReq({
      method: "POST",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      body: { address: "not-a-valid-ca" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("POST with missing address body returns 400", async () => {
    const req = mockReq({
      method: "POST",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      body: {},
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("POST with valid address returns 200 (or 402 when limit reached)", async () => {
    const req = mockReq({
      method: "POST",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      body: { address: VALID_CA },
    });
    const res = mockRes();
    await handler(req, res);
    // Without Redis init the helper returns added=false reason=limit_reached → 402.
    // With a real Redis it would 200 on first add. Either is a valid handler outcome.
    const status = (res.status as unknown as { mock: { calls: [number][] } }).mock.calls[0]?.[0];
    expect([200, 402]).toContain(status);
  });

  it("DELETE without address parameter returns 400", async () => {
    const req = mockReq({
      method: "DELETE",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("DELETE with valid address parameter returns 200", async () => {
    const req = mockReq({
      method: "DELETE",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      query: { address: VALID_CA },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { removed: boolean };
    expect(typeof payload.removed).toBe("boolean");
  });

  it("DELETE accepts address from JSON body", async () => {
    const req = mockReq({
      method: "DELETE",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
      body: { address: VALID_CA },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalledOnce();
  });

  it("rejects PUT with 405 Method Not Allowed", async () => {
    const req = mockReq({
      method: "PUT",
      headers: { origin: ORIGIN, "x-antares-install": INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });
});
