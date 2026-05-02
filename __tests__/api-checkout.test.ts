import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>(
    "../api/_lib/middleware",
  );
  return { ...actual };
});

import handler from "../api/checkout";

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

const ORIGIN = "https://antares-website.vercel.app";
const VALID_INSTALL = "install-test-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LEMONSQUEEZY_STORE_DOMAIN = "antares-test.lemonsqueezy.com";
  process.env.LEMONSQUEEZY_VARIANT_PRO = "1234";
  process.env.LEMONSQUEEZY_VARIANT_LIFETIME = "9999";
});

afterEach(() => {
  delete process.env.LEMONSQUEEZY_STORE_DOMAIN;
  delete process.env.LEMONSQUEEZY_VARIANT_PRO;
  delete process.env.LEMONSQUEEZY_VARIANT_LIFETIME;
});

describe("GET /api/checkout", () => {
  it("handles OPTIONS preflight with 204", async () => {
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

  it("rejects missing tier with 400", async () => {
    const req = mockReq({ headers: { origin: ORIGIN }, query: { install_id: VALID_INSTALL } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects unknown tier with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "yearly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects missing install_id with 400", async () => {
    const req = mockReq({ headers: { origin: ORIGIN }, query: { tier: "monthly" } });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects malformed install_id with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: "short" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 503 when LEMONSQUEEZY_STORE_DOMAIN is unset", async () => {
    delete process.env.LEMONSQUEEZY_STORE_DOMAIN;
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { error: string };
    expect(payload.error).toBe("checkout_not_configured");
  });

  it("returns 503 when the requested variant is unset", async () => {
    delete process.env.LEMONSQUEEZY_VARIANT_LIFETIME;
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "lifetime", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("builds the LS checkout URL with install_id as custom data for monthly", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { url: string; tier: string; variant: string };
    expect(payload.tier).toBe("monthly");
    expect(payload.variant).toBe("1234");
    expect(payload.url).toContain("antares-test.lemonsqueezy.com/checkout/buy/1234");
    expect(payload.url).toContain(`checkout%5Bcustom%5D%5Binstall_id%5D=${VALID_INSTALL}`);
  });

  it("uses the lifetime variant when tier=lifetime", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "lifetime", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { variant: string; url: string };
    expect(payload.variant).toBe("9999");
    expect(payload.url).toContain("/buy/9999");
  });

  it("treats 'pro' as alias for 'monthly'", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "pro", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { variant: string };
    expect(payload.variant).toBe("1234");
  });

  it("normalises tier case (LIFETIME → lifetime)", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "LIFETIME", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("disables HTTP caching to prevent stale checkout URLs", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
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
