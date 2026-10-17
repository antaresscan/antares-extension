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
import {
  setCorsHeaders,
  checkRateLimit,
  getClientIp,
  initRateLimiters,
} from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { initUserStorage } from "./_lib/user";
import { getPaymentIntent, type PaymentIntent } from "./_lib/payments";
import { reconcileIntent } from "./_lib/payment-reconcile";
import { initSentry, captureError } from "./_lib/sentry";

initSentry();

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// Reference is 32 bytes hex → 64 chars [0-9a-f].
const REFERENCE_RE = /^[0-9a-f]{64}$/;

/**
 * Ask NOWPayments (through the reconciliation shared with the cron) where the intent's payment stands, and apply it: on a
 * confirmed payment the tier flips and the license is issued in the same response. Best-effort for the buyer's page: a
 * provider failure or a Redis hiccup leaves the intent as it is for the next poll (or the cron) to pick up.
 */
async function maybeConfirmFromProvider(
  intent: PaymentIntent,
  redis: Redis,
): Promise<{ intent: PaymentIntent; licenseKey: string | null }> {
  try {
    const r = await reconcileIntent(redis, intent);
    // Underpaid: the intent stays pending (the buyer tops up, or the provider expires the payment).
    return { intent: r.intent, licenseKey: r.state === "confirmed" ? r.licenseKey : null };
  } catch (err) {
    logger.warn("payment-status", "reconciliation failed", {
      reference: intent.reference,
      error: String(err),
    });
    captureError(err, { endpoint: "payment-status", phase: "reconcile", reference: intent.reference });
    return { intent, licenseKey: null };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res, { credentialedOnly: true }); // account state: first-party origins only
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
  initRateLimiters(redis);

  // Standard 60-req/min network limit. Each poll hits NOWPayments REST,
  // which costs API quota — without this, a leaked reference (URL bar,
  // Referer log, `?ref=` query string) becomes a DoS-economic vector.
  // The reference's 2^256 entropy makes guessing infeasible, but
  // replay of a known reference is otherwise trivially cheap.
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  // Strict read: "could not read" must not answer 404. The website's account.html takes a 404 as final ("Payment not found
  // ... Try again") and stops polling: a Redis hiccup right after the buyer paid told them to pay again. A 503 is what it keeps
  // polling through.
  let stored: PaymentIntent | null;
  try {
    stored = await getPaymentIntent(redis, reference, { strict: true });
  } catch (err) {
    logger.warn("payment-status", "intent read failed", { reference, error: String(err) });
    captureError(err, { endpoint: "payment-status", phase: "read", reference });
    return res.status(503).json({ status: "unavailable" });
  }
  if (!stored) {
    return res.status(404).json({ status: "not_found" });
  }

  const { intent, licenseKey } = await maybeConfirmFromProvider(stored, redis);

  // The status is what the reconciliation settled. A pending intent past its window is NOT shown as expired: either a
  // payment is in flight (it may still confirm) or NOWPayments could not be asked just now (the next poll retries).
  return res.json({
    status: intent.status,
    expiresAt: intent.expiresAt,
    txSignature: intent.txSignature ?? null,
    confirmedAt: intent.confirmedAt ?? null,
    tier: intent.tier,
    amount: intent.amountUsd,
    licenseKey,
  });
}
