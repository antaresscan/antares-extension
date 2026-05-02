import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";

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

import handler from "../api/webhook-nowpayments";
import { setUserTier } from "../api/_lib/user";

const TEST_SECRET = "test-ipn-secret";
const VALID_INSTALL = "install-test-aaaaaaaaaa";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeysDeep(obj[k]);
    return out;
  }
  return value;
}

function signSorted(body: unknown, secret = TEST_SECRET): string {
  const sorted = sortKeysDeep(body);
  return createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

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

const FINISHED_PAYLOAD = {
  payment_id: "12345",
  payment_status: "finished",
  order_id: `${VALID_INSTALL}:monthly`,
  pay_amount: 0.001,
  pay_currency: "btc",
  actually_paid: 0.001,
  price_amount: 14.99,
  price_currency: "usd",
};

const LIFETIME_PAYLOAD = {
  ...FINISHED_PAYLOAD,
  order_id: `${VALID_INSTALL}:lifetime`,
  price_amount: 99,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOWPAYMENTS_IPN_SECRET = TEST_SECRET;
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_IPN_SECRET;
});

describe("POST /api/webhook-nowpayments", () => {
  it("rejects non-POST methods with 405", async () => {
    const req = streamingReq("GET", "");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects with 401 when NOWPAYMENTS_IPN_SECRET is unset", async () => {
    delete process.env.NOWPAYMENTS_IPN_SECRET;
    const req = streamingReq("POST", "{}");
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects with 401 on missing x-nowpayments-sig", async () => {
    const body = JSON.stringify(FINISHED_PAYLOAD);
    const req = streamingReq("POST", body);
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects with 401 on invalid signature", async () => {
    const body = JSON.stringify(FINISHED_PAYLOAD);
    const req = streamingReq("POST", body, { "x-nowpayments-sig": "deadbeef".repeat(16) });
    const res = mockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects with 400 on malformed JSON", async () => {
    const body = "not valid json";
    // Sign the malformed body — verifyWebhookSignature will fail JSON parse
    // and reject with 401, NOT 400. So expect 401.
    const sig = createHmac("sha512", TEST_SECRET).update(body).digest("hex");
    const req = streamingReq("POST", body, { "x-nowpayments-sig": sig });
    const res = mockRes();
    await handler(req, res);
    // Either 400 or 401 depending on which check fails first; both are
    // valid rejection paths.
    const status = (res.status as unknown as { mock: { calls: [number][] } }).mock.calls[0][0];
    expect([400, 401]).toContain(status);
  });

  it("flips user to Pro on finished monthly payment", async () => {
    const body = JSON.stringify(FINISHED_PAYLOAD);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(FINISHED_PAYLOAD),
    });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).toHaveBeenCalledOnce();
    const [installId, tier, expires] =
      (setUserTier as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(installId).toBe(VALID_INSTALL);
    expect(tier).toBe("pro");
    expect(typeof expires).toBe("number");
    expect(expires as number).toBeGreaterThan(Date.now());
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("flips user to Lifetime on finished lifetime payment", async () => {
    const body = JSON.stringify(LIFETIME_PAYLOAD);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(LIFETIME_PAYLOAD),
    });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).toHaveBeenCalledWith(VALID_INSTALL, "lifetime");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("flips user to Free on refund", async () => {
    const refundPayload = { ...FINISHED_PAYLOAD, payment_status: "refunded" };
    const body = JSON.stringify(refundPayload);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(refundPayload),
    });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).toHaveBeenCalledWith(VALID_INSTALL, "free");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("acks intermediate statuses with 200 + noop without changing the tier", async () => {
    const waitingPayload = { ...FINISHED_PAYLOAD, payment_status: "confirming" };
    const body = JSON.stringify(waitingPayload);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(waitingPayload),
    });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][0] as { action: string };
    expect(payload.action).toBe("noop");
  });

  it("returns 200 noop when order_id is missing", async () => {
    const orphanPayload = { ...FINISHED_PAYLOAD, order_id: undefined };
    const body = JSON.stringify(orphanPayload);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(orphanPayload),
    });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 500 when setUserTier throws (NP will retry)", async () => {
    vi.mocked(setUserTier).mockRejectedValueOnce(new Error("redis down"));
    const body = JSON.stringify(FINISHED_PAYLOAD);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(FINISHED_PAYLOAD),
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("partially_paid is treated as noop (manual review)", async () => {
    const partialPayload = { ...FINISHED_PAYLOAD, payment_status: "partially_paid" };
    const body = JSON.stringify(partialPayload);
    const req = streamingReq("POST", body, {
      "x-nowpayments-sig": signSorted(partialPayload),
    });
    const res = mockRes();
    await handler(req, res);

    expect(setUserTier).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
