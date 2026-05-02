// api/payment-status.ts — Poll the status of a Solana Pay payment intent.
//
//   GET /api/payment-status?reference=<base58>
//   Returns: { status, expiresAt, txSignature?, confirmedAt? }
//
// The pricing page calls this every 2-3s while the user is on the QR code
// modal. Once `status` flips to "confirmed" the page closes the modal and
// shows the success state.
//
// **Lazy on-chain verification**: each polling request also triggers a
// Helius RPC check for the intent's reference key. If a confirming
// transaction has landed, we flip the user's tier in the same response —
// gives the user instant confirmation feedback instead of waiting for the
// daily cron sweep. The cron still runs as a safety net for users who
// paid but closed the tab before the polling caught up.
//
// No auth — the reference key itself is the secret. It's 32 random bytes
// of entropy (2^256), and it's only useful for someone who already knows
// they created it (otherwise the worst they can do is observe a tier flip
// they have no agency over).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { initUserStorage, setUserTier } from "./_lib/user";
import {
  checkIntentOnChain,
  getPaymentIntent,
  markIntentConfirmed,
  PRO_PASS_DAYS,
  type PaymentIntent,
} from "./_lib/solana-pay";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * If the intent is still pending and we have a Helius key configured, query
 * the chain to see if a matching transaction has landed. On match, flip the
 * user's tier and mark the intent confirmed in the same operation so the
 * polling response carries the success state immediately.
 *
 * Returns the (possibly updated) intent. Best-effort — Helius failures or
 * Redis hiccups don't break the polling response, they just leave the
 * intent in its current state for the next poll (or the daily cron) to
 * pick up.
 */
async function maybeConfirmOnChain(
  intent: PaymentIntent,
  redis: Redis,
): Promise<PaymentIntent> {
  if (intent.status !== "pending") return intent;
  if (Date.now() >= intent.expiresAt) return intent;

  const heliusApiKey = process.env.HELIUS_API_KEY;
  if (!heliusApiKey) return intent;

  try {
    const result = await checkIntentOnChain(intent, heliusApiKey);
    if (!result.confirmed) return intent;

    const tier =
      intent.tier === "lifetime" ? ("lifetime" as const) : ("pro" as const);
    const expiresAtMs =
      intent.tier === "lifetime"
        ? undefined
        : Date.now() + PRO_PASS_DAYS * 24 * 60 * 60 * 1000;

    await setUserTier(intent.installId, tier, expiresAtMs);
    await markIntentConfirmed(redis, intent, result.txSignature);

    logger.metric("payment-status.tier_set", {
      tier,
      installId: intent.installId,
      txSignature: result.txSignature,
      amount: intent.amount,
      via: "lazy-poll",
    });

    return {
      ...intent,
      status: "confirmed",
      txSignature: result.txSignature,
      confirmedAt: Date.now(),
    };
  } catch (err) {
    logger.warn("payment-status", "lazy on-chain check failed", {
      error: String(err),
      reference: intent.reference,
    });
    return intent;
  }
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

  // Lazy on-chain check — confirms the intent in the same response when
  // possible so the user gets instant feedback rather than waiting for the
  // (now daily) cron tick.
  const intent = await maybeConfirmOnChain(stored, redis);

  // If the intent is past expiry but neither this poll nor the cron has
  // visited it yet, treat it as expired client-side so the pricing page can
  // show the right state immediately rather than waiting for the next sweep.
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
    amount: intent.amount,
  });
}
