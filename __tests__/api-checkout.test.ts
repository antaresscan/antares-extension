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
const SAMPLE_INVOICE_URL = "https://nowpayments.io/payment/?iid=fake-12345";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOWPAYMENTS_API_KEY = "test-api-key";
  // Stub global fetch so checkout.ts's createInvoice() hits a mock instead
  // of NowPayments' real API.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 1,
        invoice_url: SAMPLE_INVOICE_URL,
        order_id: `${VALID_INSTALL}:monthly`,
      }),
      text: async () => "",
    })),
  );
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_API_KEY;
  delete process.env.NOWPAYMENTS_PRICE_PRO;
  delete process.env.NOWPAYMENTS_PRICE_LIFETIME;
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
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { install_id: VALID_INSTALL },
    });
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

  it("rejects malformed install_id with 400", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: "short" },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 503 when NOWPAYMENTS_API_KEY is unset", async () => {
    delete process.env.NOWPAYMENTS_API_KEY;
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

  it("returns the NowPayments invoice URL for a valid monthly request", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { url: string; tier: string };
    expect(payload.tier).toBe("monthly");
    expect(payload.url).toBe(SAMPLE_INVOICE_URL);
  });

  it("posts to NowPayments with the right shape (price, currency, order_id, callback URLs)", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("nowpayments.io/v1/invoice");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-api-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.price_amount).toBe(14.99);
    expect(body.price_currency).toBe("usd");
    expect(body.order_id).toBe(`${VALID_INSTALL}:monthly`);
    expect(body.ipn_callback_url).toContain("/api/webhook-nowpayments");
  });

  it("uses the lifetime price when tier=lifetime", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "lifetime", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.price_amount).toBe(99);
    expect(body.order_id).toBe(`${VALID_INSTALL}:lifetime`);
  });

  it("treats 'pro' as alias for 'monthly'", async () => {
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "pro", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { tier: string };
    expect(payload.tier).toBe("monthly");
    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.price_amount).toBe(14.99);
  });

  it("honours NOWPAYMENTS_PRICE_PRO env override", async () => {
    process.env.NOWPAYMENTS_PRICE_PRO = "19.99";
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.price_amount).toBe(19.99);
  });

  it("returns 502 when NowPayments returns a malformed invoice (no invoice_url)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 1 }), // missing invoice_url
        text: async () => "",
      })),
    );
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it("returns 502 when NowPayments API call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "internal" }),
        text: async () => "internal error",
      })),
    );
    const req = mockReq({
      headers: { origin: ORIGIN },
      query: { tier: "monthly", install_id: VALID_INSTALL },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(502);
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
