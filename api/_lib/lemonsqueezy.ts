// api/_lib/lemonsqueezy.ts — Lemonsqueezy webhook handling helpers.
//
// Lemonsqueezy is the merchant of record for Pro/Lifetime payments. They
// handle EU VAT, refunds, and chargebacks; we just listen for webhook
// events and flip user tiers accordingly.
//
// Wire-up at deploy time:
//   1. Sign up for a Lemonsqueezy store
//   2. Create products: "Antares Pro Monthly" ($14.99/mo) + "Antares Lifetime" ($99 one-time)
//   3. Configure a webhook endpoint pointing to /api/webhook-lemonsqueezy
//   4. Set the following Vercel env vars:
//      - LEMONSQUEEZY_WEBHOOK_SECRET   the signing secret from the LS dashboard
//      - LEMONSQUEEZY_VARIANT_PRO      variant ID for Pro Monthly
//      - LEMONSQUEEZY_VARIANT_LIFETIME variant ID for Lifetime
//   5. Customers click "Upgrade" → checkout URL embeds install_id in
//      `checkout[custom][install_id]` so the webhook can map back.
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

// ─── Types matching Lemonsqueezy's webhook payload ────────────────────────────

/**
 * Subset of LS webhook payload we actually use. Their full schema covers
 * billing details, customer info, etc. — kept narrow to what's needed for
 * tier flipping.
 */
export interface LemonsqueezyWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: { install_id?: string } & Record<string, unknown>;
  };
  data: {
    id?: string;
    type?: string;
    attributes?: {
      status?: string;
      ends_at?: string | null;
      renews_at?: string | null;
      variant_id?: number | string;
      product_id?: number | string;
    };
  };
}

/** Events we explicitly handle. LS sends others; we ack but no-op. */
export const HANDLED_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_expired",
  "subscription_resumed",
  "order_created",
  "order_refunded",
]);

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Verify a Lemonsqueezy webhook's X-Signature header. LS computes
 * HMAC-SHA256 over the raw request body using the configured signing secret.
 *
 * Uses `timingSafeEqual` to avoid leaking signature bytes via timing
 * differences when an attacker probes with crafted signatures.
 *
 * Returns false (not throws) on any mismatch so the handler can respond
 * with a clean 401 instead of leaking error details in the response.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  if (typeof signature !== "string") return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Both buffers must be the same length for timingSafeEqual
  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  } catch {
    return false;
  }
}

// ─── Tier resolution ──────────────────────────────────────────────────────────

export type ResolvedTierAction =
  | { kind: "set_pro"; installId: string; expiresAtMs: number | null }
  | { kind: "set_lifetime"; installId: string }
  | { kind: "set_free"; installId: string }
  | { kind: "noop"; reason: string };

/**
 * Decide what to do with the user's tier given a LS webhook event.
 *
 * Pure function — takes a parsed payload + the configured Lifetime variant
 * ID and returns the action the caller should apply (via setUserTier).
 * Keeps tier-flipping logic test-friendly without needing a Redis double.
 *
 * Mapping:
 *   subscription_created/resumed/updated  → set_pro with expiry = renews_at
 *   subscription_cancelled                → no-op (let the existing
 *                                            expiresAt do the downgrade)
 *   subscription_expired                  → set_free
 *   order_created (lifetime variant)      → set_lifetime
 *   order_created (other)                 → set_pro w/ short expiry (initial
 *                                            month bought; renewal arrives
 *                                            via subscription_created)
 *   order_refunded                        → set_free (charge reversed)
 */
export function resolveTierAction(
  payload: LemonsqueezyWebhookPayload,
  config: { lifetimeVariantId?: string | number },
): ResolvedTierAction {
  const event = payload.meta.event_name;
  const installId = payload.meta.custom_data?.install_id;

  if (typeof installId !== "string" || installId.length < 8) {
    return { kind: "noop", reason: "missing or invalid install_id in custom_data" };
  }

  const attrs = payload.data.attributes ?? {};

  switch (event) {
    case "subscription_created":
    case "subscription_resumed":
    case "subscription_updated": {
      // LS sets `status` on every subscription event; we trust it as the
      // source of truth for active vs. paused/expired.
      const status = attrs.status ?? "";
      if (status === "active" || status === "on_trial") {
        const expiresAtMs = parseLsDate(attrs.renews_at);
        return { kind: "set_pro", installId, expiresAtMs };
      }
      if (status === "expired" || status === "unpaid" || status === "cancelled") {
        // Cancelled-but-still-paid-through stays Pro until renews_at.
        // Hard expiry handled by subscription_expired event.
        return status === "expired"
          ? { kind: "set_free", installId }
          : { kind: "noop", reason: `status=${status}, keeping current tier until expiry` };
      }
      return { kind: "noop", reason: `unknown subscription status: ${status}` };
    }

    case "subscription_cancelled":
      // Cancelled but the customer keeps access until the period they paid for
      // ends. The renews_at timestamp is the natural downgrade boundary —
      // user.ts's getUserTier already auto-reverts to free past that point,
      // so we don't need to set anything here.
      return { kind: "noop", reason: "cancelled — auto-downgrade at expiry handled by user.ts" };

    case "subscription_expired":
      return { kind: "set_free", installId };

    case "order_created": {
      const variantId = attrs.variant_id;
      if (
        config.lifetimeVariantId !== undefined &&
        String(variantId) === String(config.lifetimeVariantId)
      ) {
        return { kind: "set_lifetime", installId };
      }
      // Non-lifetime order — typically the initial month of a Pro subscription.
      // The subsequent subscription_created event sets the proper expiry.
      // We grant a short bridge so the user gets immediate access.
      const bridgeExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
      return { kind: "set_pro", installId, expiresAtMs: bridgeExpiresAt };
    }

    case "order_refunded":
      return { kind: "set_free", installId };

    default:
      return { kind: "noop", reason: `unhandled event: ${event}` };
  }
}

/** Parse an ISO 8601 string from LS into epoch-ms, or null when absent/invalid. */
export function parseLsDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Best-effort safe parse of a webhook body. Returns null on any failure. */
export function tryParseWebhook(body: string): LemonsqueezyWebhookPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "meta" in parsed &&
      "data" in parsed
    ) {
      return parsed as LemonsqueezyWebhookPayload;
    }
  } catch (err) {
    logger.warn("lemonsqueezy", "webhook JSON parse failed", { error: String(err) });
  }
  return null;
}
