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
  type PayToken,
  type Tier,
} from "./_lib/solana-pay";
import { normalizeEmail } from "./_lib/license";
import { getAccountFromRequest } from "./_lib/session-cookie";

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
  const installIdRaw = String(body.install_id ?? "").trim();
  // Default to USDC (stable pricing) when the client doesn't specify;
  // the modal exposes both options explicitly so this fallback only
  // matters for direct API consumers.
  const tokenRaw = String(body.token ?? "usdc").trim().toLowerCase();
  // Logged-in user? Pull email from the session cookie so the buyer
  // doesn't have to re-type it (and so the license is bound to their
  // account regardless of what they typed in the modal).
  let sessionEmail: string | null = null;
  try {
    const redisForSession = getRedis();
    if (redisForSession) {
      const account = await getAccountFromRequest(req, redisForSession);
      if (account) sessionEmail = account.email;
    }
  } catch {
    // SESSION_SECRET unset, etc. Fall through to body-supplied email.
  }
  // Email is optional when an install_id is present (the user came from
  // the extension and we already know who they are), but required when
  // it's absent (site-direct visitors who haven't installed yet — the
  // license-key issued on payment confirm is the only handle they'll
  // have to redeem later). Session email always wins over body.
  const emailNorm = sessionEmail ?? normalizeEmail(body.email);

  // 'pro' is a UX alias used by the pricing page — both monthly and pro
  // route to the 30-day pass under the hood.
  const normalisedTier: Tier = tier === "lifetime" ? "lifetime" : "monthly";
  if (tier !== "monthly" && tier !== "pro" && tier !== "lifetime") {
    return apiError(res, 400, "tier must be 'monthly', 'pro' or 'lifetime'.");
  }
  if (tokenRaw !== "usdc" && tokenRaw !== "sol") {
    return apiError(res, 400, "token must be 'usdc' or 'sol'.");
  }
  const token: PayToken = tokenRaw;
  // install_id is optional when email is provided. At least one of the
  // two must be present so we have *some* identity to bind the license
  // to.
  const hasInstall = INSTALL_ID_RE.test(installIdRaw);
  if (!hasInstall && !emailNorm) {
    return apiError(res, 400, "install_id or email required.");
  }
  if (installIdRaw && !hasInstall) {
    return apiError(res, 400, "install_id format invalid.");
  }
  // When email is present but the user typed something invalid we want
  // to fail loudly rather than silently dropping it — it's the only
  // recovery handle for site-direct buyers.
  if (body.email !== undefined && body.email !== "" && !emailNorm) {
    return apiError(res, 400, "email format invalid.");
  }
  // Stable identity used downstream by createPaymentIntent + license
  // issuance. When the user has no install yet, the email synthesises
  // one (prefixed so we never collide with a real install_id).
  const installId = hasInstall ? installIdRaw : `email:${emailNorm}`;

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
      ...(emailNorm ? { email: emailNorm } : {}),
      tier: normalisedTier,
      token,
      recipient,
    });

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.json({
      reference: intent.reference,
      payUrl: intent.payUrl,
      recipient: intent.recipient,
      token: intent.token,
      amount: intent.amount,
      amountUsd: intent.amountUsd,
      splTokenMint: intent.splTokenMint,
      tier: intent.tier,
      expiresAt: intent.expiresAt,
    });
  } catch (err) {
    logger.error("payment-intent", "creation failed", { error: String(err) });
    // SOL rate fetch failures are user-actionable: surface them so the
    // pricing-page modal can suggest USDC instead.
    const message = err instanceof Error ? err.message : String(err);
    if (/SOL\/USD/i.test(message)) {
      return res.status(502).json({
        error: "sol_rate_unavailable",
        message: "Could not fetch the current SOL price — please try again or pay in USDC.",
      });
    }
    return apiError(res, 500, "Could not create payment intent.");
  }
}
