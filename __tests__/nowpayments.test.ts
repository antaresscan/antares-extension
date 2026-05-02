import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildOrderId,
  parseOrderId,
  verifyWebhookSignature,
  resolveTierAction,
  tryParseIpn,
  TERMINAL_STATUSES,
  type NowPaymentsIpnPayload,
} from "../api/_lib/nowpayments";

const SECRET = "test-ipn-secret-do-not-use-in-prod";
const VALID_INSTALL = "install-test-aaaaaaaaaa";

// Helper: replicate NP's signature-over-sorted-keys-JSON algorithm.
function signSortedJson(body: unknown, secret: string = SECRET): string {
  const sorted = sortKeysDeep(body);
  return createHmac("sha512", secret).update(JSON.stringify(sorted)).digest("hex");
}

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

// ─── buildOrderId / parseOrderId ──────────────────────────────────────────────

describe("buildOrderId", () => {
  it("packs install_id + tier with the colon delimiter", () => {
    expect(buildOrderId(VALID_INSTALL, "monthly")).toBe(`${VALID_INSTALL}:monthly`);
    expect(buildOrderId(VALID_INSTALL, "lifetime")).toBe(`${VALID_INSTALL}:lifetime`);
  });
});

describe("parseOrderId", () => {
  it("round-trips with buildOrderId", () => {
    const orderId = buildOrderId(VALID_INSTALL, "monthly");
    const parsed = parseOrderId(orderId);
    expect(parsed).toEqual({ installId: VALID_INSTALL, tier: "monthly" });
  });

  it("returns null on missing input", () => {
    expect(parseOrderId(undefined)).toBeNull();
    expect(parseOrderId("")).toBeNull();
  });

  it("returns null on malformed install_id", () => {
    expect(parseOrderId("short:monthly")).toBeNull();
    expect(parseOrderId("contains spaces:monthly")).toBeNull();
  });

  it("returns null on unknown tier", () => {
    expect(parseOrderId(`${VALID_INSTALL}:yearly`)).toBeNull();
    expect(parseOrderId(`${VALID_INSTALL}:premium`)).toBeNull();
  });

  it("returns null on missing delimiter", () => {
    expect(parseOrderId(VALID_INSTALL)).toBeNull();
  });

  it("returns null on extra delimiters (defensive)", () => {
    expect(parseOrderId(`${VALID_INSTALL}:monthly:extra`)).toBeNull();
  });
});

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  const samplePayload = {
    payment_id: "12345",
    payment_status: "finished",
    order_id: `${VALID_INSTALL}:monthly`,
    pay_amount: 0.001,
    pay_currency: "btc",
  };

  it("accepts a correctly-signed body", () => {
    const body = JSON.stringify(samplePayload);
    const sig = signSortedJson(samplePayload);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("accepts the same body regardless of key ordering (sort-key normalisation)", () => {
    // Construct two bodies with identical content but different key order
    const reordered = {
      pay_currency: "btc",
      payment_id: "12345",
      pay_amount: 0.001,
      payment_status: "finished",
      order_id: `${VALID_INSTALL}:monthly`,
    };
    const body = JSON.stringify(reordered);
    // The signature was computed against the same logical content
    const sig = signSortedJson(samplePayload);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const original = JSON.stringify(samplePayload);
    const tampered = original.replace("monthly", "lifetime");
    const sig = signSortedJson(samplePayload);
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const body = JSON.stringify(samplePayload);
    const sig = signSortedJson(samplePayload, "other-secret");
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects when signature is missing", () => {
    expect(verifyWebhookSignature("{}", undefined, SECRET)).toBe(false);
  });

  it("rejects when secret is empty", () => {
    const body = JSON.stringify(samplePayload);
    expect(verifyWebhookSignature(body, signSortedJson(samplePayload), "")).toBe(false);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(verifyWebhookSignature("{not json", "0".repeat(128), SECRET)).toBe(false);
  });

  it("rejects mismatched signature length without crashing", () => {
    expect(verifyWebhookSignature(JSON.stringify(samplePayload), "tooshort", SECRET)).toBe(false);
  });
});

// ─── tryParseIpn ──────────────────────────────────────────────────────────────

describe("tryParseIpn", () => {
  it("parses a valid IPN payload", () => {
    const body = JSON.stringify({ payment_status: "finished", order_id: "x" });
    const result = tryParseIpn(body);
    expect(result?.payment_status).toBe("finished");
  });

  it("returns null on malformed JSON", () => {
    expect(tryParseIpn("{not json")).toBeNull();
  });

  it("returns null on a JSON primitive (not object)", () => {
    expect(tryParseIpn("42")).toBeNull();
    expect(tryParseIpn('"hello"')).toBeNull();
  });
});

// ─── resolveTierAction ────────────────────────────────────────────────────────

function payload(over: Partial<NowPaymentsIpnPayload> = {}): NowPaymentsIpnPayload {
  return {
    payment_status: "finished",
    order_id: buildOrderId(VALID_INSTALL, "monthly"),
    payment_id: "1",
    ...over,
  };
}

describe("resolveTierAction", () => {
  it("returns noop when order_id is missing", () => {
    const action = resolveTierAction(payload({ order_id: undefined }));
    expect(action.kind).toBe("noop");
  });

  it("returns noop when order_id is malformed", () => {
    const action = resolveTierAction(payload({ order_id: "garbage" }));
    expect(action.kind).toBe("noop");
  });

  describe("payment_status=finished", () => {
    it("flips to Pro with +30 days expiry for monthly tier", () => {
      const now = Date.UTC(2026, 4, 1, 12, 0, 0);
      const action = resolveTierAction(payload(), now);
      expect(action.kind).toBe("set_pro");
      if (action.kind === "set_pro") {
        expect(action.installId).toBe(VALID_INSTALL);
        expect(action.expiresAtMs).toBe(now + 30 * 24 * 60 * 60 * 1000);
      }
    });

    it("flips to Lifetime for lifetime tier", () => {
      const action = resolveTierAction(
        payload({ order_id: buildOrderId(VALID_INSTALL, "lifetime") }),
      );
      expect(action.kind).toBe("set_lifetime");
      if (action.kind === "set_lifetime") {
        expect(action.installId).toBe(VALID_INSTALL);
      }
    });
  });

  describe("payment_status=refunded", () => {
    it("flips back to Free", () => {
      const action = resolveTierAction(payload({ payment_status: "refunded" }));
      expect(action.kind).toBe("set_free");
    });
  });

  describe("intermediate / failure statuses", () => {
    it.each(["waiting", "confirming", "confirmed", "sending"])(
      "returns noop on %s (waiting for finished)",
      (status) => {
        const action = resolveTierAction(payload({ payment_status: status }));
        expect(action.kind).toBe("noop");
      },
    );

    it("returns noop on partially_paid (manual review needed)", () => {
      const action = resolveTierAction(payload({ payment_status: "partially_paid" }));
      expect(action.kind).toBe("noop");
      if (action.kind === "noop") {
        expect(action.reason).toContain("partial");
      }
    });

    it.each(["expired", "failed"])(
      "returns noop on %s (no tier change)",
      (status) => {
        const action = resolveTierAction(payload({ payment_status: status }));
        expect(action.kind).toBe("noop");
      },
    );

    it("returns noop with reason on unknown status", () => {
      const action = resolveTierAction(payload({ payment_status: "alien_state" }));
      expect(action.kind).toBe("noop");
      if (action.kind === "noop") {
        expect(action.reason).toContain("unknown");
      }
    });
  });

  it("normalises status case (FINISHED → finished)", () => {
    const action = resolveTierAction(payload({ payment_status: "FINISHED" }));
    expect(action.kind).toBe("set_pro");
  });
});

// ─── TERMINAL_STATUSES ────────────────────────────────────────────────────────

describe("TERMINAL_STATUSES", () => {
  it("includes finished, expired, failed, refunded", () => {
    expect(TERMINAL_STATUSES.has("finished")).toBe(true);
    expect(TERMINAL_STATUSES.has("expired")).toBe(true);
    expect(TERMINAL_STATUSES.has("failed")).toBe(true);
    expect(TERMINAL_STATUSES.has("refunded")).toBe(true);
  });

  it("does not include intermediate statuses", () => {
    expect(TERMINAL_STATUSES.has("waiting")).toBe(false);
    expect(TERMINAL_STATUSES.has("confirming")).toBe(false);
    expect(TERMINAL_STATUSES.has("partially_paid")).toBe(false);
  });
});
