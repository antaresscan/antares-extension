// __tests__/nowpayments.test.ts — IPN HMAC verification + status mapping.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyIpnSignature, mapStatus } from "../api/_lib/nowpayments";

const SECRET = "test-ipn-secret-1234567890";

/**
 * Mirrors the canonical-form HMAC NOWPayments uses for IPN signatures:
 * sort keys alphabetically (recursive), JSON.stringify, HMAC-SHA512.
 * If our verifyIpnSignature doesn't match this, real callbacks fail.
 */
function sortObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortObject);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortObject(obj[key]);
  }
  return out;
}

function signPayload(payload: Record<string, unknown>): string {
  const sortedJson = JSON.stringify(sortObject(payload));
  return createHmac("sha512", SECRET).update(sortedJson).digest("hex");
}

beforeEach(() => {
  process.env.NOWPAYMENTS_IPN_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.NOWPAYMENTS_IPN_SECRET;
});

describe("verifyIpnSignature", () => {
  const payload = {
    payment_id: "abc123",
    payment_status: "finished",
    order_id: "ref-xyz",
    invoice_id: "inv-99",
    pay_amount: "0.001",
    price_amount: 24.99,
    nested: { foo: "bar", a: [1, 2, 3] },
  };

  it("accepts a payload signed with the same secret + canonical form", () => {
    const sig = signPayload(payload);
    expect(verifyIpnSignature(payload, sig)).toBe(true);
  });

  it("accepts the raw string body form too", () => {
    const sig = signPayload(payload);
    const raw = JSON.stringify(payload); // unsorted on the wire — that's fine
    expect(verifyIpnSignature(raw, sig)).toBe(true);
  });

  it("rejects when the body is tampered after signing", () => {
    const sig = signPayload(payload);
    const tampered = { ...payload, price_amount: 0.01 };
    expect(verifyIpnSignature(tampered, sig)).toBe(false);
  });

  it("rejects when the secret env var is missing (fail closed)", () => {
    delete process.env.NOWPAYMENTS_IPN_SECRET;
    const sig = signPayload(payload);
    expect(verifyIpnSignature(payload, sig)).toBe(false);
  });

  it("rejects when the signature header is empty", () => {
    expect(verifyIpnSignature(payload, "")).toBe(false);
    expect(verifyIpnSignature(payload, undefined)).toBe(false);
  });

  it("rejects malformed JSON in the raw-string form", () => {
    expect(verifyIpnSignature("{not json", "abcd")).toBe(false);
  });
});

describe("mapStatus", () => {
  it("maps confirmed/sending/finished to 'confirmed'", () => {
    expect(mapStatus("confirmed")).toBe("confirmed");
    expect(mapStatus("sending")).toBe("confirmed");
    expect(mapStatus("finished")).toBe("confirmed");
  });

  it("maps failed/refunded/expired to 'expired'", () => {
    expect(mapStatus("failed")).toBe("expired");
    expect(mapStatus("refunded")).toBe("expired");
    expect(mapStatus("expired")).toBe("expired");
  });

  it("maps waiting/confirming/partially_paid to 'pending'", () => {
    expect(mapStatus("waiting")).toBe("pending");
    expect(mapStatus("confirming")).toBe("pending");
    expect(mapStatus("partially_paid")).toBe("pending");
  });
});
