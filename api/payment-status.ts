// api/payment-status.ts — Poll the status of a NOWPayments invoice.
//
//   GET /api/payment-status?reference=<hex>
//   Returns: { status, expiresAt, txSignature?, confirmedAt?, tier, amount, licenseKey }
//
// The pricing page calls this every 2-3s while the user is on the
// NOWPayments hosted checkout (or on the post-payment success page).
// Once `status` flips to "confirmed" the page closes the modal and shows
// the success state with the license key.
//
// **Lazy reconciliation**: each polling request also hits the NOWPayments
// REST API to check if the underlying payment has progressed. If we
// observe a `confirmed`/`finished` payment, we flip the user's tier and
// issue the license in the same response — gives instant confirmation
// feedback without depending solely on the IPN webhook (which can be
// delayed under load) or the daily cron sweep.
//
// No auth — the reference key itself is the secret. It's 32 random bytes
// of entropy (2^256), and it's only useful to someone who already knows
// they created it.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { initUserStorage } from "./_lib/user";
import {
  getPaymentIntent,
  bindNpPaymentId,
  markIntentExpired,
  type PaymentIntent,
} from "./_lib/payments";
import {
  listPaymentsForInvoice,
  getPayment,
  mapStatus,
} from "./_lib/nowpayments";
import { confirmIntent } from "./_lib/payment-confirm";
import { INTENT_LICENSE_KEY } from "./_lib/license";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Reference is 32 bytes hex → 64 chars [0-9a-f].
const REFERENCE_RE = /^[0-9a-f]{64}$/;

/**
 * Pick the most-progressed payment when an invoice has multiple
 * (NOWPayments creates one payment record per crypto-pick attempt).
 * "finished" / "confirmed" / "sending" win over "confirming"/"waiting"
 * so a half-completed earlier attempt doesn't mask a successful retry.
 */
const PRIORITY: Record<string, number> = {
  finished: 5,
  confirmed: 4,
  sending: 3,
  confirming: 2,
  partially_paid: 1,
  waiting: 0,
  failed: -1,
  refunded: -1,
  expired: -1,
};

async function findCanonicalPayment(intent: PaymentIntent) {
  // Fast path: we already know which payment id to look up.
  if (intent.npPaymentId) {
    const p = await getPayment(intent.npPaymentId);
    if (p) return p;
    // Fall through to invoice listing if the bound payment id was lost.
  }
  if (!intent.npInvoiceId) return null;
  const payments = await listPaymentsForInvoice(intent.npInvoiceId);
  if (payments.length === 0) return null;
  payments.sort(
    (a, b) =>
      (PRIORITY[b.payment_status] ?? 0) - (PRIORITY[a.payment_status] ?? 0),
  );
  return payments[0];
}

/**
 * If the intent is still pending, query NOWPayments to see if the
 * underlying payment has progressed. On confirm we flip the tier and
 * issue the license in the same operation. Best-effort — provider
 * failures or Redis hiccups don't break the polling response, they just
 * leave the intent in its current state for the next poll (or the cron)
 * to pick up.
 */
async function maybeConfirmFromProvider(
  intent: PaymentIntent,
  redis: Redis,
): Promise<{ intent: PaymentIntent; licenseKey: string | null }> {
  if (intent.status !== "pending") {
    // Already in a terminal state — surface any previously-issued license
    // key so the polling page sees it on its first call after refresh.
    let licenseKey: string | null = null;
    if (intent.email && intent.status === "confirmed") {
      try {
        licenseKey =
          (await redis.get<string>(INTENT_LICENSE_KEY(intent.reference))) ?? null;
      } catch { /* non-critical */ }
    }
    return { intent, licenseKey };
  }

  // Auto-expire on TTL hit even if NOWPayments is unreachable. Keeps the
  // polling client from spinning forever after a crashed checkout.
  if (Date.now() > intent.expiresAt) {
    const expired = await markIntentExpired(redis, intent);
    return { intent: expired, licenseKey: null };
  }

  let canonical;
  try {
    canonical = await findCanonicalPayment(intent);
  } catch (err) {
    logger.warn("payment-status", "provider lookup failed", {
      reference: intent.reference,
      error: String(err),
    });
    return { intent, licenseKey: null };
  }

  if (!canonical) return { intent, licenseKey: null };

  // First time we've seen this payment_id for the intent — bind it so
  // future polls and the IPN webhook hit the fast path.
  let workingIntent = intent;
  if (!workingIntent.npPaymentId && canonical.payment_id) {
    try {
      workingIntent = await bindNpPaymentId(redis, workingIntent, canonical.payment_id);
    } catch { /* non-critical */ }
  }

  const internalStatus = mapStatus(canonical.payment_status);
  if (internalStatus === "confirmed") {
    const txSignature = canonical.payin_hash ?? canonical.payout_hash ?? undefined;
    const reportedUsd = Number(canonical.price_amount ?? 0);
    const outcome = await confirmIntent(redis, workingIntent, {
      txSignature: typeof txSignature === "string" ? txSignature : undefined,
      reportedUsd: Number.isFinite(reportedUsd) ? reportedUsd : undefined,
    });
    if (!outcome.ok) {
      // Underpay — leave intent pending so the user (or our cron) can
      // retry without re-issuing a license. The polling client just
      // keeps spinning until the buyer tops up or the intent expires.
      return { intent: workingIntent, licenseKey: null };
    }
    return { intent: outcome.intent, licenseKey: outcome.licenseKey };
  }
  if (internalStatus === "expired") {
    const expired = await markIntentExpired(redis, workingIntent);
    return { intent: expired, licenseKey: null };
  }
  return { intent: workingIntent, licenseKey: null };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const reference = String(req.query.reference ?? "").trim();
  if (!REFERENCE_RE.test(reference)) {
    return apiError(res, 400, "Valid reference query param required.");
  }

  // No-cache — status flips per second once the user pays.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const redis = getRedis();
  if (!redis) {
    return apiError(res, 503, "Storage unavailable.");
  }
  initUserStorage(redis);

  const stored = await getPaymentIntent(redis, reference);
  if (!stored) {
    return res.status(404).json({ status: "not_found" });
  }

  const { intent, licenseKey } = await maybeConfirmFromProvider(stored, redis);

  // If the intent is past expiry but neither this poll nor the cron has
  // visited it yet, treat it as expired client-side so the pricing page
  // can show the right state immediately.
  const status =
    intent.status === "pending" && Date.now() > intent.expiresAt
      ? "expired"
      : intent.status;

  return res.json({
    status,
    expiresAt: intent.expiresAt,
    txSignature: intent.txSignature ?? null,
    confirmedAt: intent.confirmedAt ?? null,
    tier: intent.tier,
    amount: intent.amountUsd,
    licenseKey,
  });
}
