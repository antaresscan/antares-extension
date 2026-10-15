// api/cron-check-payments.ts — Vercel cron: reconcile NOWPayments invoices.
//
// Runs on the schedule defined in vercel.json. For each pending intent in
// the index it runs the reconciliation shared with the polling endpoint
// (_lib/payment-reconcile.ts): ask NOWPayments for the underlying payment and,
// if it is confirmed/finished, run confirmIntent (issues license + flips tier
// + marks confirmed). An intent is expired only when the provider says its
// payment is dead, or when its window is over and NO payment exists. It used
// to expire on the clock first; with a daily run that meant the cron could
// never confirm anything. An intent whose keys are gone is dropped from the
// index (it used to stay there for good, scanned and counted as an error).
//
// This is the safety-net for missed IPN webhooks. NOWPayments retries
// IPN delivery on failure but transient outages (Vercel deploy, Redis
// hiccup, our handler bug) can still drop one. The cron sweeps any
// pending intent the webhook didn't finalise.
//
// Authentication (audit A-28): `Authorization: Bearer <CRON_SECRET>` and nothing else. With a CRON_SECRET variable on the project Vercel
// sends exactly that on every scheduled call, and the owner can send the same to start a sweep by hand. The header `x-vercel-cron: 1`
// used to be enough on its own: anybody can type it, so a stranger could start the sweep at will (every run asks NOWPayments about each
// pending checkout). See api/_lib/cron-auth.ts.
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
import { initSentry, captureError } from "./_lib/sentry";

initSentry();
import {
  getPaymentIntent,
  listPendingIntentReferences,
  removeFromPendingIndex,
} from "./_lib/payments";
import { isConfigured as nowpaymentsConfigured } from "./_lib/nowpayments";
import { reconcileIntent } from "./_lib/payment-reconcile";
import { hasCronSecret } from "./_lib/cron-auth";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

interface CronOutcome {
  scanned: number;
  confirmed: number;
  expired: number;
  /** Still waiting: a payment in flight, or none yet inside the window. */
  pending: number;
  /** References whose intent no longer exists: removed from the pending index. */
  dropped: number;
  errors: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!hasCronSecret(req)) {
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

  const outcome: CronOutcome = { scanned: 0, confirmed: 0, expired: 0, pending: 0, dropped: 0, errors: 0 };

  try {
    const refs = await listPendingIntentReferences(redis);
    outcome.scanned = refs.length;

    // Process serially — typical pending count is < 20, the NOWPayments
    // round-trip dominates. Parallelising would barely help and would
    // multiply the chance of hitting their rate limit during a burst.
    for (const ref of refs) {
      const intent = await getPaymentIntent(redis, ref);
      if (!intent) {
        // Its keys are gone (retention over): nothing left to reconcile, and the reference must not stay in the index.
        try {
          await removeFromPendingIndex(redis, ref);
          outcome.dropped++;
        } catch (err) {
          outcome.errors++;
          captureError(err, { endpoint: "cron-check-payments", phase: "dropReference", reference: ref });
        }
        continue;
      }
      try {
        const r = await reconcileIntent(redis, intent);
        if (r.state === "confirmed") outcome.confirmed++;
        else if (r.state === "expired") outcome.expired++;
        else {
          if (r.state === "underpaid") {
            logger.warn("cron-check-payments", "underpaid intent skipped", {
              reference: ref,
              paidRatio: r.paidRatio,
            });
          }
          outcome.pending++;
        }
      } catch (err) {
        outcome.errors++;
        logger.warn("cron-check-payments", "intent processing failed", {
          reference: ref,
          error: String(err),
        });
        captureError(err, { endpoint: "cron-check-payments", phase: "processIntent", reference: ref });
      }
    }
  } catch (err) {
    logger.error("cron-check-payments", "iteration failed", {
      error: String(err),
    });
    captureError(err, { endpoint: "cron-check-payments", phase: "iteration" });
    return res.status(500).json({ error: "iteration_failed", outcome });
  }

  return res.status(200).json({ ok: true, outcome });
}
