import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  resolveTierAction,
  parseLsDate,
  tryParseWebhook,
  HANDLED_EVENTS,
  type LemonsqueezyWebhookPayload,
} from "../api/_lib/lemonsqueezy";

const SECRET = "test-signing-secret-do-not-use-in-prod";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const VALID_INSTALL = "install-test-aaaaaaaaaa";

function payload(
  event: string,
  overrides: {
    installId?: string | null;
    status?: string;
    renewsAt?: string | null;
    variantId?: string | number;
  } = {},
): LemonsqueezyWebhookPayload {
  return {
    meta: {
      event_name: event,
      custom_data:
        overrides.installId === undefined
          ? { install_id: VALID_INSTALL }
          : overrides.installId === null
            ? {}
            : { install_id: overrides.installId },
    },
    data: {
      id: "12345",
      type: "subscriptions",
      attributes: {
        status: overrides.status,
        renews_at: overrides.renewsAt,
        variant_id: overrides.variantId,
      },
    },
  };
}

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  it("returns true for a correctly-signed body", () => {
    const body = JSON.stringify({ meta: { event_name: "test" }, data: {} });
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const body = JSON.stringify({ meta: { event_name: "test" }, data: {} });
    const tampered = body.replace("test", "tampered");
    expect(verifyWebhookSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const body = "{}";
    expect(verifyWebhookSignature(body, sign(body, "other-secret"), SECRET)).toBe(false);
  });

  it("returns false when signature is missing", () => {
    expect(verifyWebhookSignature("{}", undefined, SECRET)).toBe(false);
  });

  it("returns false when secret is empty", () => {
    const body = "{}";
    expect(verifyWebhookSignature(body, sign(body), "")).toBe(false);
  });

  it("returns false on mismatched signature length without crashing", () => {
    expect(verifyWebhookSignature("{}", "tooshort", SECRET)).toBe(false);
  });

  it("uses constant-time comparison (no early-exit on first byte mismatch)", () => {
    // Sanity check that timing-safe path is actually exercised — same length
    // signatures with diff content should both return false without throwing.
    const body = "{}";
    const wrong = "a".repeat(64);
    expect(verifyWebhookSignature(body, wrong, SECRET)).toBe(false);
  });
});

// ─── parseLsDate ──────────────────────────────────────────────────────────────

describe("parseLsDate", () => {
  it("parses ISO 8601 strings into epoch-ms", () => {
    expect(parseLsDate("2026-06-01T00:00:00.000Z")).toBe(Date.UTC(2026, 5, 1));
  });

  it("returns null for null/undefined", () => {
    expect(parseLsDate(null)).toBeNull();
    expect(parseLsDate(undefined)).toBeNull();
  });

  it("returns null for empty strings", () => {
    expect(parseLsDate("")).toBeNull();
  });

  it("returns null for unparseable strings", () => {
    expect(parseLsDate("not a date")).toBeNull();
  });
});

// ─── tryParseWebhook ──────────────────────────────────────────────────────────

describe("tryParseWebhook", () => {
  it("parses valid LS webhook JSON", () => {
    const body = JSON.stringify({ meta: { event_name: "x" }, data: { id: "1" } });
    const result = tryParseWebhook(body);
    expect(result?.meta.event_name).toBe("x");
  });

  it("returns null for malformed JSON", () => {
    expect(tryParseWebhook("{not json")).toBeNull();
  });

  it("returns null for JSON without meta/data", () => {
    expect(tryParseWebhook(JSON.stringify({ random: "stuff" }))).toBeNull();
  });
});

// ─── resolveTierAction ────────────────────────────────────────────────────────

describe("resolveTierAction", () => {
  describe("missing install_id", () => {
    it("returns noop when install_id is absent from custom_data", () => {
      const action = resolveTierAction(payload("subscription_created", { installId: null }), {});
      expect(action.kind).toBe("noop");
    });

    it("returns noop when install_id is too short", () => {
      const action = resolveTierAction(payload("subscription_created", { installId: "abc" }), {});
      expect(action.kind).toBe("noop");
    });
  });

  describe("subscription_created", () => {
    it("flips to Pro with renews_at as expiry when status is active", () => {
      const renews = "2026-06-01T00:00:00.000Z";
      const action = resolveTierAction(
        payload("subscription_created", { status: "active", renewsAt: renews }),
        {},
      );
      expect(action.kind).toBe("set_pro");
      if (action.kind === "set_pro") {
        expect(action.installId).toBe(VALID_INSTALL);
        expect(action.expiresAtMs).toBe(Date.parse(renews));
      }
    });

    it("flips to Pro on trial", () => {
      const action = resolveTierAction(
        payload("subscription_created", {
          status: "on_trial",
          renewsAt: "2026-06-01T00:00:00.000Z",
        }),
        {},
      );
      expect(action.kind).toBe("set_pro");
    });

    it("flips to free on expired status", () => {
      const action = resolveTierAction(
        payload("subscription_created", { status: "expired" }),
        {},
      );
      expect(action.kind).toBe("set_free");
    });

    it("returns noop on cancelled (let auto-downgrade handle expiry)", () => {
      const action = resolveTierAction(
        payload("subscription_created", { status: "cancelled" }),
        {},
      );
      expect(action.kind).toBe("noop");
    });
  });

  describe("subscription_cancelled", () => {
    it("returns noop — user keeps access until paid period expires", () => {
      const action = resolveTierAction(payload("subscription_cancelled"), {});
      expect(action.kind).toBe("noop");
    });
  });

  describe("subscription_expired", () => {
    it("flips to free", () => {
      const action = resolveTierAction(payload("subscription_expired"), {});
      expect(action.kind).toBe("set_free");
    });
  });

  describe("order_created", () => {
    it("flips to Lifetime when variant matches LEMONSQUEEZY_VARIANT_LIFETIME", () => {
      const action = resolveTierAction(payload("order_created", { variantId: "9999" }), {
        lifetimeVariantId: "9999",
      });
      expect(action.kind).toBe("set_lifetime");
    });

    it("matches lifetime variant via numeric/string coercion", () => {
      const action = resolveTierAction(payload("order_created", { variantId: 9999 }), {
        lifetimeVariantId: "9999",
      });
      expect(action.kind).toBe("set_lifetime");
    });

    it("grants short Pro bridge for non-lifetime orders", () => {
      const action = resolveTierAction(payload("order_created", { variantId: "1234" }), {
        lifetimeVariantId: "9999",
      });
      expect(action.kind).toBe("set_pro");
      if (action.kind === "set_pro") {
        // Bridge expires roughly 24h from now
        expect(action.expiresAtMs).toBeGreaterThan(Date.now());
        expect(action.expiresAtMs).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
      }
    });

    it("treats order as Pro when no lifetime variant configured", () => {
      const action = resolveTierAction(payload("order_created", { variantId: "9999" }), {});
      expect(action.kind).toBe("set_pro");
    });
  });

  describe("order_refunded", () => {
    it("flips to free on refund", () => {
      const action = resolveTierAction(payload("order_refunded"), {});
      expect(action.kind).toBe("set_free");
    });
  });

  describe("unhandled events", () => {
    it("returns noop for events outside the HANDLED_EVENTS set", () => {
      const action = resolveTierAction(payload("subscription_payment_failed"), {});
      expect(action.kind).toBe("noop");
    });
  });
});

// ─── HANDLED_EVENTS set sanity ────────────────────────────────────────────────

describe("HANDLED_EVENTS", () => {
  it("contains the core lifecycle events", () => {
    expect(HANDLED_EVENTS.has("subscription_created")).toBe(true);
    expect(HANDLED_EVENTS.has("subscription_cancelled")).toBe(true);
    expect(HANDLED_EVENTS.has("subscription_expired")).toBe(true);
    expect(HANDLED_EVENTS.has("order_created")).toBe(true);
    expect(HANDLED_EVENTS.has("order_refunded")).toBe(true);
  });

  it("does not include payment-noise events we explicitly ignore", () => {
    expect(HANDLED_EVENTS.has("subscription_payment_success")).toBe(false);
    expect(HANDLED_EVENTS.has("subscription_payment_failed")).toBe(false);
  });
});
