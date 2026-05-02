// api/payment-intent.ts — Create a Solana Pay payment intent.
//
//   POST /api/payment-intent
//   Body:    { tier: "monthly" | "lifetime", install_id: string }
//   Returns: { reference, payUrl, recipient, amount, splTokenMint, expiresAt }
//
// The pricing page POSTs here when the user clicks "Subscribe Pro" or
// "Get Lifetime", then renders the returned `payUrl` as a QR code + clickable
// Phantom deep link, and polls /api/payment-status?reference=... for the
// settlement state.
//
// Configure at deploy time:
//   SOLANA_RECIPIENT_WALLET   base58 address that receives the USDC payments
//   HELIUS_API_KEY             already set, reused by the cron verifier
//
// Without SOLANA_RECIPIENT_WALLET set, returns 503 + checkout_not_configured.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import {
  createPaymentIntent,
  isValidSolanaAddress,
  type Tier,
} from "./_lib/solana-pay";

const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Lazy-init Redis on first request rather than at module load. Upstash
 * is a thin HTTP client so re-creation per request is essentially free,
 * and it keeps the env-var check evaluable inside test setups that
 * configure them after import.
 */
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function readBody(req: VercelRequest): Record<string, unknown> {
  const body = req.body as unknown;
  if (body && typeof body === "object") return body as Record<string, unknown>;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const body = readBody(req);
  const tier = String(body.tier ?? "").trim().toLowerCase();
  const installId = String(body.install_id ?? "").trim();

  // 'pro' is a UX alias used by the pricing page — both monthly and pro
  // route to the 30-day pass under the hood.
  const normalisedTier: Tier = tier === "lifetime" ? "lifetime" : "monthly";
  if (tier !== "monthly" && tier !== "pro" && tier !== "lifetime") {
    return apiError(res, 400, "tier must be 'monthly', 'pro' or 'lifetime'.");
  }
  if (!INSTALL_ID_RE.test(installId)) {
    return apiError(res, 400, "Valid install_id required in body.");
  }

  const recipient = process.env.SOLANA_RECIPIENT_WALLET ?? "";
  if (!recipient || !isValidSolanaAddress(recipient)) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(503).json({
      error: "checkout_not_configured",
      message: "Crypto checkout not available yet.",
    });
  }

  const redis = getRedis();
  if (!redis) {
    return apiError(res, 503, "Storage unavailable.");
  }

  try {
    const intent = await createPaymentIntent(redis, {
      installId,
      tier: normalisedTier,
      recipient,
    });

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.json({
      reference: intent.reference,
      payUrl: intent.payUrl,
      recipient: intent.recipient,
      amount: intent.amount,
      splTokenMint: intent.splTokenMint,
      tier: intent.tier,
      expiresAt: intent.expiresAt,
    });
  } catch (err) {
    logger.error("payment-intent", "creation failed", { error: String(err) });
    return apiError(res, 500, "Could not create payment intent.");
  }
}
