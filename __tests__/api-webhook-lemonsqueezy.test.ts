import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";

// Mock external deps before importing handler

vi.mock("@upstash/redis", () => {
  class MockRedis {
    set = vi.fn().mockResolvedValue("OK");
    get = vi.fn().mockResolvedValue(null);
    del = vi.fn().mockResolvedValue(1);
  }
  return { Redis: MockRedis };
});

vi.mock("../api/_lib/user", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/user")>(
    "../api/_lib/user",
  );
  return {
    ...actual,
    initUserStorage: vi.fn(),
    setUserTier: vi.fn().mockResolvedValue(undefined),
  };
});

import handler from "../api/webhook-lemonsqueezy";
import { setUserTier } from "../api/_lib/user";

const TEST_SECRET = "test-signing-secret";
const VALID_INSTALL = "install-test-aaaaaaaaaa";

// Build a request-like object that streams a body via EventEmitter — mirrors
// how Vercel hands the raw body to the handler when bodyParser is disabled.
function streamingReq(
  method: string,
  body: string,
  headers: Record<string, string> = {},
): VercelRequest {
  const emitter = new EventEmitter() as EventEmitter & {
    method?: string;
    headers?: Record<string, string>;
  };
  emitter.method = method;
  emitter.headers = headers;
  // Defer emission so the handler can attach listeners first
  setTimeout(() => {
    if (body) emitter.emit("data", Buffer.from(body, "utf8"));
    emitter.emit("end");
  }, 0);
  return emitter as unknown as VercelRequest;
}

function mockRes(): VercelResponse {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as VercelResponse;
}

function sign(body: string, secret = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const SAMPLE_PAYLOAD = {
  meta: {
    event_name: "subscription_created",
    custom_data: { install_id: VALID_INSTALL },
  },
  data: {
    id: "1",
    type: "subscriptions",
    attributes: {
      status: "active",
      renews_at: "2026-06-01T00:00:00.000Z",
      variant_id: "1234",
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = TEST_SECRET;
  process.env.LEMONSQUEEZY_VARIANT_LIFETIME = "9999";
});

afterEach(() => {
  delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  delete process.env.LEMONSQUEEZY_VARIANT_LIFETIME;
});

describe("POST /api/webhook-lemonsqueezy", () => {
  it("rejects non-POST methods with 405", async () => {
    const req = streamingReq("GET", "");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects with 401 when LEMONSQUEEZY_WEBHOOK_SECRET is unset", async () => {
    delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const req = streamingReq("POST", "{}");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects with 401 on missing X-Signature", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = streamingReq("POST", body);
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects with 401 on invalid signature", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = streamingReq("POST", body, { "x-signature": "deadbeef".repeat(8) });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects with 400 on malformed JSON", async () => {
    const body = "not valid json";
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("flips user to Pro on subscription_created with active status", async () => {
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).toHaveBeenCalledWith(
      VALID_INSTALL,
      "pro",
      Date.parse("2026-06-01T00:00:00.000Z"),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("flips user to Lifetime on order_created matching the lifetime variant", async () => {
    const lifetimePayload = {
      ...SAMPLE_PAYLOAD,
      meta: {
        event_name: "order_created",
        custom_data: { install_id: VALID_INSTALL },
      },
      data: {
        ...SAMPLE_PAYLOAD.data,
        attributes: { variant_id: "9999" },
      },
    };
    const body = JSON.stringify(lifetimePayload);
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).toHaveBeenCalledWith(VALID_INSTALL, "lifetime");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("flips user to Free on subscription_expired", async () => {
    const expiredPayload = {
      ...SAMPLE_PAYLOAD,
      meta: {
        event_name: "subscription_expired",
        custom_data: { install_id: VALID_INSTALL },
      },
    };
    const body = JSON.stringify(expiredPayload);
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).toHaveBeenCalledWith(VALID_INSTALL, "free");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("acks unhandled events with 200 + handled:false", async () => {
    const noisyPayload = {
      ...SAMPLE_PAYLOAD,
      meta: {
        event_name: "subscription_payment_success",
        custom_data: { install_id: VALID_INSTALL },
      },
    };
    const body = JSON.stringify(noisyPayload);
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(payload).toMatchObject({ handled: false });
  });

  it("returns 200 noop when install_id is missing from custom_data", async () => {
    const orphanPayload = {
      ...SAMPLE_PAYLOAD,
      meta: { event_name: "subscription_created", custom_data: {} },
    };
    const body = JSON.stringify(orphanPayload);
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);

    // Resolves to noop, handler responds 200 — we don't fail the webhook
    // for malformed custom data, just log and move on.
    expect(setUserTier).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 500 when setUserTier throws (LS will retry)", async () => {
    vi.mocked(setUserTier).mockRejectedValueOnce(new Error("redis down"));
    const body = JSON.stringify(SAMPLE_PAYLOAD);
    const req = streamingReq("POST", body, { "x-signature": sign(body) });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
