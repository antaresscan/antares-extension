// api/_lib/nowpayments.ts — NOWPayments crypto payment integration helpers.
//
// NOWPayments accepts BTC, ETH, SOL, USDC, USDT (multi-chain), 200+ others.
// 0.5% commission, no KYC for individuals, settlement direct to your wallets.
//
// Wire-up at deploy time:
//   1. Sign up at https://account.nowpayments.io (no KYC for individuals)
//   2. Add your wallet addresses (one per chain you accept)
//   3. Generate an API key (Settings → API keys)
//   4. Generate an IPN secret (Settings → IPN settings)
//   5. Configure the IPN URL: https://antares-extension.vercel.app/api/webhook-nowpayments
//   6. Set Vercel env vars:
//      - NOWPAYMENTS_API_KEY  — API key for invoice creation
//      - NOWPAYMENTS_IPN_SECRET — HMAC-SHA512 signing secret for webhooks
//
// Webhook flow:
//   user clicks "Pay" → /api/checkout creates an NP invoice with order_id =
//   "<install_id>:<tier>" → user lands on NP checkout page → picks crypto +
//   pays → NP confirms on-chain → IPN fires here → we flip user tier.
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Subset of NOWPayments IPN payload we use. Full schema covers a lot more
 * (pay_address, actually_paid, outcome currency, etc.) — kept narrow to the
 * fields that drive tier decisions.
 */
export interface NowPaymentsIpnPayload {
  payment_id?: string | number;
  payment_status?: string;
  /** Free-form, set when we created the invoice. We pack "<install_id>:<tier>" here. */
  order_id?: string;
  order_description?: string;
  price_amount?: number | string;
  price_currency?: string;
  pay_amount?: number | string;
  pay_currency?: string;
  actually_paid?: number | string;
  purchase_id?: string | number;
}

/**
 * Statuses NOWPayments emits on the IPN. We only act on `finished` and
 * `refunded`; intermediate states (`waiting`, `confirming`, `sending`) just
 * get acknowledged with 200 so NP doesn't keep retrying.
 *
 * `partially_paid` is treated as a noop with a warning log — manual
 * intervention is needed because the user underpaid and we don't want to
 * grant Pro for a partial payment.
 */
export const TERMINAL_STATUSES = new Set([
  "finished",
  "expired",
  "failed",
  "refunded",
]);

// ─── Order ID encoding ────────────────────────────────────────────────────────

const ORDER_ID_DELIMITER = ":";

/**
 * Pack install_id + tier into the NP `order_id` field. NP echoes this verbatim
 * in the webhook so we can map back to the user without an extra DB lookup.
 */
export function buildOrderId(installId: string, tier: "monthly" | "lifetime"): string {
  return `${installId}${ORDER_ID_DELIMITER}${tier}`;
}

/** Unpack the install_id + tier out of an order_id. Returns null on malformed input. */
export function parseOrderId(
  orderId: string | undefined,
): { installId: string; tier: "monthly" | "lifetime" } | null {
  if (!orderId || typeof orderId !== "string") return null;
  const parts = orderId.split(ORDER_ID_DELIMITER);
  if (parts.length !== 2) return null;
  const [installId, tier] = parts;
  if (!installId || !/^[a-zA-Z0-9_-]{8,128}$/.test(installId)) return null;
  if (tier !== "monthly" && tier !== "lifetime") return null;
  return { installId, tier };
}

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Recursively sort an object's keys alphabetically. NOWPayments' signature
 * scheme requires this normalisation: HMAC over JSON.stringify(sortedKeys(body))
 * rather than the raw bytes. This makes the signature stable regardless of
 * how the upstream HTTP layer ordered the keys.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Verify an NP webhook's `x-nowpayments-sig` header. NP signs with
 * HMAC-SHA512 over the *key-sorted* JSON of the body using the IPN secret.
 *
 * Constant-time compare via timingSafeEqual to avoid byte-by-byte signature
 * probing. Returns false on any mismatch (no exceptions) so the handler
 * responds with a clean 401 without leaking parse errors.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  if (typeof signature !== "string") return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const sortedJson = JSON.stringify(sortKeysDeep(parsed));
  const expected = createHmac("sha512", secret).update(sortedJson).digest("hex");

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
  | { kind: "set_pro"; installId: string; expiresAtMs: number }
  | { kind: "set_lifetime"; installId: string }
  | { kind: "set_free"; installId: string }
  | { kind: "noop"; reason: string };

const PRO_PASS_DAYS = 30;

/**
 * Decide what to do given an IPN payload. Pure function — takes parsed
 * webhook + a "now" injection so unit tests can pin the clock and assert
 * the expiry timestamp without timing flakiness.
 *
 * Mapping:
 *   payment_status=finished + tier=monthly  → set_pro w/ +30 days expiry
 *   payment_status=finished + tier=lifetime → set_lifetime
 *   payment_status=refunded                  → set_free
 *   payment_status=expired/failed            → noop (no tier change)
 *   anything else                            → noop with reason for the log
 */
export function resolveTierAction(
  payload: NowPaymentsIpnPayload,
  now: number = Date.now(),
): ResolvedTierAction {
  const status = (payload.payment_status ?? "").toLowerCase();
  const order = parseOrderId(payload.order_id);

  if (!order) {
    return { kind: "noop", reason: "missing or invalid order_id" };
  }

  switch (status) {
    case "finished":
      if (order.tier === "lifetime") {
        return { kind: "set_lifetime", installId: order.installId };
      }
      return {
        kind: "set_pro",
        installId: order.installId,
        // 30-day pass model — crypto has no native auto-renewal. The user
        // pays again to extend; user.ts auto-downgrades after expiry.
        expiresAtMs: now + PRO_PASS_DAYS * 24 * 60 * 60 * 1000,
      };

    case "refunded":
      return { kind: "set_free", installId: order.installId };

    case "expired":
    case "failed":
      return { kind: "noop", reason: `payment ${status}, tier unchanged` };

    case "waiting":
    case "confirming":
    case "confirmed":
    case "sending":
      return {
        kind: "noop",
        reason: `intermediate status ${status} — wait for finished`,
      };

    case "partially_paid":
      return {
        kind: "noop",
        reason: "partial payment — manual review required, tier not granted",
      };

    default:
      return { kind: "noop", reason: `unknown payment_status: ${status}` };
  }
}

/** Best-effort safe parse. Returns null on any failure. */
export function tryParseIpn(body: string): NowPaymentsIpnPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      return parsed as NowPaymentsIpnPayload;
    }
  } catch (err) {
    logger.warn("nowpayments", "IPN JSON parse failed", { error: String(err) });
  }
  return null;
}

// ─── Invoice creation (server → NOWPayments API) ──────────────────────────────

const NOWPAYMENTS_API_BASE = "https://api.nowpayments.io/v1";

export interface CreateInvoiceParams {
  installId: string;
  tier: "monthly" | "lifetime";
  priceAmount: number;
  priceCurrency: string; // "usd" — NP converts to crypto at the rate of the moment
  ipnCallbackUrl: string;
  successUrl: string;
  cancelUrl: string;
}

export interface NowPaymentsInvoiceResponse {
  id?: string | number;
  invoice_url?: string;
  order_id?: string;
}

/**
 * Create a hosted-checkout invoice on NOWPayments. Returns the URL to
 * redirect the browser to — the user picks their crypto + chain on NP's
 * page, pays, and our webhook fires when the payment confirms on-chain.
 *
 * Throws on any non-2xx response so the caller can surface a 503 with a
 * machine-readable error code.
 */
export async function createInvoice(
  apiKey: string,
  params: CreateInvoiceParams,
): Promise<NowPaymentsInvoiceResponse> {
  const body = {
    price_amount: params.priceAmount,
    price_currency: params.priceCurrency,
    order_id: buildOrderId(params.installId, params.tier),
    order_description:
      params.tier === "lifetime"
        ? "Antares Lifetime — Pro features forever"
        : "Antares Pro — 30-day pass",
    ipn_callback_url: params.ipnCallbackUrl,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    is_fee_paid_by_user: false,
  };

  const res = await fetch(`${NOWPAYMENTS_API_BASE}/invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`NowPayments invoice creation failed: ${res.status} ${errText}`);
  }

  const json: unknown = await res.json();
  if (!json || typeof json !== "object") {
    throw new Error("NowPayments returned a non-object response");
  }
  return json as NowPaymentsInvoiceResponse;
}
