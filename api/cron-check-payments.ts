// api/cron-check-payments.ts — Vercel cron: confirm pending Solana Pay intents.
//
// Runs every minute (configured in vercel.json). For each intent in the
// pending index:
//   1. If past expiry → mark expired (cleans the index, page polling will
//      see "expired" on its next tick).
//   2. Otherwise query Helius RPC for transactions involving the intent's
//      reference key. If we find one that satisfies recipient + token +
//      amount, set the user's tier and mark the intent confirmed.
//
// Authentication:
//   - Vercel attaches `x-vercel-cron: 1` to legitimate scheduled invocations.
//   - For local testing or manual triggers we accept `Authorization: Bearer
//     <CRON_SECRET>` so we can probe the endpoint without spinning up Vercel.
//
// Failure modes:
//   - Helius down → cron iteration logs and moves on; next tick retries.
//   - Redis hiccup on setUserTier → log error but don't mark intent
//     confirmed (so we retry on the next tick).
//   - Concurrent crons (Vercel sometimes fires twice during deploys): each
//     sees the same pending index, both call setUserTier with idempotent
//     writes — Pro stays Pro, no duplicate billing.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { logger } from "./_lib/logger";
import { initUserStorage, setUserTier } from "./_lib/user";
import {
  checkIntentOnChain,
  getPaymentIntent,
  listPendingIntentReferences,
  markIntentConfirmed,
  markIntentExpired,
  PRO_PASS_DAYS,
  type PaymentIntent,
} from "./_lib/solana-pay";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function isAuthorized(req: VercelRequest): boolean {
  // Vercel scheduled invocations carry this header — trust them.
  if (req.headers["x-vercel-cron"] === "1") return true;
  // Manual / local invocations need the bearer secret to match.
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

async function processIntent(
  intent: PaymentIntent,
  heliusApiKey: string,
  redis: Redis,
): Promise<"confirmed" | "expired" | "still_pending" | "error"> {
  if (Date.now() > intent.expiresAt) {
    await markIntentExpired(redis, intent);
    return "expired";
  }

  const result = await checkIntentOnChain(intent, heliusApiKey);
  if (!result.confirmed) return "still_pending";

  // Compute Pro Pass expiry — 30 days from confirmation, NOT from intent
  // creation. User shouldn't be penalised for taking 25 minutes to pay.
  const tierExpiresAt =
    intent.tier === "lifetime"
      ? undefined
      : Date.now() + PRO_PASS_DAYS * 24 * 60 * 60 * 1000;

  await setUserTier(
    intent.installId,
    intent.tier === "lifetime" ? "lifetime" : "pro",
    tierExpiresAt,
  );
  await markIntentConfirmed(redis, intent, result.txSignature);

  logger.metric("cron-check-payments.tier_set", {
    tier: intent.tier === "lifetime" ? "lifetime" : "pro",
    installId: intent.installId,
    txSignature: result.txSignature,
    amount: intent.amount,
  });

  return "confirmed";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel sends GET for crons by default
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const heliusApiKey = process.env.HELIUS_API_KEY ?? "";
  if (!heliusApiKey) {
    return res.status(503).json({ error: "helius_unavailable" });
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

    // Process serially — typical pending count is < 20, the Helius
    // round-trip dominates. Parallelising would barely help and would
    // multiply the chance of hitting Helius rate limits during a burst.
    for (const ref of refs) {
      const intent = await getPaymentIntent(redis, ref);
      if (!intent) {
        // Stale index entry — index TTL is shorter than intent TTL, but
        // an SREM-without-DEL race can leave dangling refs. Clean up.
        outcome.errors++;
        continue;
      }
      try {
        const status = await processIntent(intent, heliusApiKey, redis);
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
