// api/payment-status.ts — Poll the status of a Solana Pay payment intent.
//
//   GET /api/payment-status?reference=<base58>
//   Returns: { status, expiresAt, txSignature?, confirmedAt? }
//
// The pricing page calls this every 2-3s while the user is on the QR code
// modal. Once `status` flips to "confirmed" the page closes the modal and
// shows the success state.
//
// No auth — the reference key itself is the secret. It's 32 random bytes
// of entropy (2^256), and it's only useful for someone who already knows
// they created it (otherwise the worst they can do is observe a tier flip
// they have no agency over).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { getPaymentIntent } from "./_lib/solana-pay";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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

  const intent = await getPaymentIntent(redis, reference);
  if (!intent) {
    return res.status(404).json({ status: "not_found" });
  }

  // If the intent is past expiry but the cron hasn't visited it yet, treat
  // it as expired client-side so the pricing page can show the right state
  // immediately rather than waiting up to 1 minute for the cron tick.
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
