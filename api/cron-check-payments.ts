// api/cron-check-payments.ts — Vercel cron: reconcile NOWPayments invoices.
//
// Runs on the schedule defined in vercel.json. For each pending intent in
// the index:
//   1. If past expiry → mark expired (cleans the index, polling sees
//      "expired" on its next tick).
//   2. Otherwise query NOWPayments for the underlying payment and, if the
//      provider says confirmed/finished, run the shared confirmIntent
//      helper (issues license + flips tier + marks confirmed).
//
// This is the safety-net for missed IPN webhooks. NOWPayments retries
// IPN delivery on failure but transient outages (Vercel deploy, Redis
// hiccup, our handler bug) can still drop one. The cron sweeps any
// pending intent the webhook didn't finalise.
//
// Authentication:
//   - Vercel attaches `x-vercel-cron: 1` to legitimate scheduled invocations.
//   - For local testing or manual triggers we accept `Authorization: Bearer
//     <CRON_SECRET>` so we can probe the endpoint without spinning up Vercel.
//
// Failure modes:
//   - NOWPayments down → cron iteration logs and moves on; next tick retries.
//   - Redis hiccup → log error but don't mark intent confirmed (we retry).
//   - Concurrent crons (Vercel sometimes fires twice during deploys): each
//     sees the same pending index, both call confirmIntent with idempotent
//     writes — Pro stays Pro, no duplicate billing.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { logger } from "./_lib/logger";
import { initUserStorage } from "./_lib/user";
import {
  bindNpPaymentId,
  getPaymentIntent,
  listPendingIntentReferences,
  markIntentExpired,
  type PaymentIntent,
} from "./_lib/payments";
import {
  isConfigured as nowpaymentsConfigured,
  listPaymentsForInvoice,
  getPayment,
  mapStatus,
} from "./_lib/nowpayments";
import { confirmIntent } from "./_lib/payment-confirm";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function isAuthorized(req: VercelRequest): boolean {
  if (req.headers["x-vercel-cron"] === "1") return true;
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false;
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${secret}`;
}

interface CronOutcome {
  scanned: number;
  confirmed: number;
  expired: number;
  errors: number;
}

/**
 * Pick the most-progressed payment for an intent. NOWPayments creates
 * one payment record per crypto-pick attempt, so an invoice can have
 * multiple payment records — we pick whichever is furthest along so a
 * half-completed earlier attempt doesn't mask a successful retry.
 */
const PAYMENT_PRIORITY: Record<string, number> = {
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

async function processIntent(
  intent: PaymentIntent,
  redis: Redis,
): Promise<"confirmed" | "expired" | "still_pending" | "error"> {
  if (Date.now() > intent.expiresAt) {
    await markIntentExpired(redis, intent);
    return "expired";
  }

  // Fast path when we already have the provider payment_id from a prior
  // IPN or polling tick.
  let canonical = null;
  if (intent.npPaymentId) {
    canonical = await getPayment(intent.npPaymentId);
  }
  if (!canonical && intent.npInvoiceId) {
    const payments = await listPaymentsForInvoice(intent.npInvoiceId);
    if (payments.length > 0) {
      payments.sort(
        (a, b) =>
          (PAYMENT_PRIORITY[b.payment_status] ?? 0) -
          (PAYMENT_PRIORITY[a.payment_status] ?? 0),
      );
      canonical = payments[0];
    }
  }
  if (!canonical) return "still_pending";

  let workingIntent = intent;
  if (!workingIntent.npPaymentId && canonical.payment_id) {
    try {
      workingIntent = await bindNpPaymentId(
        redis,
        workingIntent,
        String(canonical.payment_id),
      );
    } catch { /* non-critical */ }
  }

  const internalStatus = mapStatus(canonical.payment_status);
  if (internalStatus === "confirmed") {
    const txSignature =
      canonical.payin_hash ?? canonical.payout_hash ?? undefined;
    const reportedUsd = Number(canonical.price_amount ?? 0);
    const outcome = await confirmIntent(redis, workingIntent, {
      txSignature: typeof txSignature === "string" ? txSignature : undefined,
      reportedUsd: Number.isFinite(reportedUsd) ? reportedUsd : undefined,
    });
    if (!outcome.ok) {
      // Underpay surfaced by the cron — log + leave pending. Either
      // the buyer tops up or the intent eventually expires.
      logger.warn("cron-check-payments", "underpaid intent skipped", {
        reference: workingIntent.reference,
        expectedUsd: outcome.expectedUsd,
        reportedUsd: outcome.reportedUsd,
      });
      return "still_pending";
    }
    return "confirmed";
  }
  if (internalStatus === "expired") {
    await markIntentExpired(redis, workingIntent);
    return "expired";
  }
  return "still_pending";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (!nowpaymentsConfigured()) {
    return res.status(503).json({ error: "nowpayments_not_configured" });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({ error: "storage_unavailable" });
  }
  initUserStorage(redis);

  const outcome: CronOutcome = { scanned: 0, confirmed: 0, expired: 0, errors: 0 };

  try {
    const refs = await listPendingIntentReferences(redis);
    outcome.scanned = refs.length;

    // Process serially — typical pending count is < 20, the NOWPayments
    // round-trip dominates. Parallelising would barely help and would
    // multiply the chance of hitting their rate limit during a burst.
    for (const ref of refs) {
      const intent = await getPaymentIntent(redis, ref);
      if (!intent) {
        outcome.errors++;
        continue;
      }
      try {
        const status = await processIntent(intent, redis);
        if (status === "confirmed") outcome.confirmed++;
        else if (status === "expired") outcome.expired++;
        else if (status === "error") outcome.errors++;
      } catch (err) {
        outcome.errors++;
        logger.warn("cron-check-payments", "intent processing failed", {
          reference: ref,
          error: String(err),
        });
      }
    }
  } catch (err) {
    logger.error("cron-check-payments", "iteration failed", {
      error: String(err),
    });
    return res.status(500).json({ error: "iteration_failed", outcome });
  }

  return res.status(200).json({ ok: true, outcome });
}
