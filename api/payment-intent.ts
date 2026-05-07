// api/payment-intent.ts — Create a NOWPayments hosted-checkout invoice.
//
//   POST /api/payment-intent
//   Body:    { tier: "monthly" | "yearly", install_id?: string, email?: string }
//   Returns: { reference, payUrl, tier, amountUsd, expiresAt }
//
// The pricing page POSTs here when the user clicks "Get Pro" / "Get
// Yearly", then redirects them to `payUrl` (NOWPayments hosted page).
// The user picks any of 200+ supported cryptos there. NOWPayments fires
// our IPN webhook (`/api/auth/nowpayments-ipn`) when payment confirms;
// the page polls /api/payment-status?reference=... in parallel as a
// belt-and-braces fallback.
//
// Configure at deploy time (Vercel env vars):
//   NOWPAYMENTS_API_KEY      Server-side API key from the NOWPayments dashboard
//   NOWPAYMENTS_IPN_SECRET   IPN secret from the same dashboard (HMAC verifier)
//   ANTARES_PUBLIC_BASE_URL  e.g. https://antares-extension.vercel.app
//                            (used to build IPN callback + success URLs)
//   ANTARES_SUCCESS_URL      Optional override for the post-payment redirect
//                            (defaults to ${BASE}/success.html?ref=<reference>)
//   ANTARES_CANCEL_URL       Optional override for the bail-out redirect
//
// Without NOWPAYMENTS_API_KEY set, returns 503 + checkout_not_configured.
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
import {
  generateReference,
  saveNewIntent,
  priceUsd,
  INTENT_TTL_SECONDS,
  type PaymentIntent,
  type Tier,
} from "./_lib/payments";
import { createInvoice, isConfigured as nowpaymentsConfigured } from "./_lib/nowpayments";
import { normalizeEmail } from "./_lib/license";
import { getAccountFromRequest } from "./_lib/session-cookie";

const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

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

/**
 * Resolve the public base URL we use to build the IPN callback +
 * success / cancel URLs we hand to NOWPayments. Order:
 *   1. ANTARES_PUBLIC_BASE_URL env var (recommended, explicit)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (auto-set by Vercel on prod deploys)
 *   3. Hardcoded production URL (last resort)
 */
function getPublicBaseUrl(): string {
  const explicit = (process.env.ANTARES_PUBLIC_BASE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelProd = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (vercelProd) return `https://${vercelProd.replace(/^https?:\/\//, "")}`;
  return "https://antares-extension.vercel.app";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  if (!nowpaymentsConfigured()) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(503).json({
      error: "checkout_not_configured",
      message: "Crypto checkout not available yet.",
    });
  }

  // Rate-limit per IP — invoice creation hits NOWPayments (paid API quota)
  // and writes to Redis (paid storage). A misbehaving client or a bot
  // sweep could otherwise mint thousands of stale invoices and burn our
  // budget. The shared limiter (30/min sliding) is the right knob here:
  // a real buyer makes 1-3 attempts max in normal use, way below the cap.
  const rlRedis = getRedis();
  if (rlRedis) {
    initRateLimiters(rlRedis);
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(res, ip);
    if (!allowed) return;
  }

  const body = readBody(req);
  const tierRaw = String(body.tier ?? "").trim().toLowerCase();
  const installIdRaw = String(body.install_id ?? "").trim();

  // Logged-in user? Pull email from the session cookie so the buyer doesn't
  // have to re-type it (and so the license is bound to their account
  // regardless of what they typed in the modal).
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
  const emailNorm = sessionEmail ?? normalizeEmail(body.email);

  // Tier normalisation:
  //   - 'pro'      / 'monthly'  → "monthly" (30-day pass)
  //   - 'yearly'                → "yearly" (1-year subscription)
  //   - 'lifetime'              → "yearly" (legacy alias from before the rename)
  const normalisedTier: Tier =
    tierRaw === "yearly" || tierRaw === "lifetime" ? "yearly" : "monthly";
  if (
    tierRaw !== "monthly" &&
    tierRaw !== "pro" &&
    tierRaw !== "yearly" &&
    tierRaw !== "lifetime"
  ) {
    return apiError(res, 400, "tier must be 'monthly', 'pro' or 'yearly'.");
  }

  // install_id is optional when email is provided. At least one of the two
  // must be present so we have *some* identity to bind the license to.
  const hasInstall = INSTALL_ID_RE.test(installIdRaw);
  if (!hasInstall && !emailNorm) {
    return apiError(res, 400, "install_id or email required.");
  }
  if (installIdRaw && !hasInstall) {
    return apiError(res, 400, "install_id format invalid.");
  }
  // When email is present but the user typed something invalid we want to
  // fail loudly rather than silently dropping it — it's the only recovery
  // handle for site-direct buyers.
  if (body.email !== undefined && body.email !== "" && !emailNorm) {
    return apiError(res, 400, "email format invalid.");
  }
  // Stable identity used downstream by the confirmation helper. When the
  // user has no install yet, the email synthesises one (prefixed so we
  // never collide with a real install_id).
  const installId = hasInstall ? installIdRaw : `email:${emailNorm}`;

  const redis = getRedis();
  if (!redis) {
    return apiError(res, 503, "Storage unavailable.");
  }

  const reference = generateReference();
  const amountUsd = priceUsd(normalisedTier);
  const baseUrl = getPublicBaseUrl();
  const ipnCallbackUrl = `${baseUrl}/api/auth/nowpayments-ipn`;
  const successUrl =
    (process.env.ANTARES_SUCCESS_URL ?? `${baseUrl}/account.html?ref=${reference}`)
      .replace("{reference}", reference);
  const cancelUrl =
    process.env.ANTARES_CANCEL_URL ?? `${baseUrl}/account.html?cancelled=1`;

  let invoice;
  try {
    invoice = await createInvoice({
      orderId: reference,
      priceAmountUsd: amountUsd,
      description:
        normalisedTier === "yearly"
          ? "Antares Pro — 1 year subscription"
          : "Antares Pro — 30 day pass",
      ipnCallbackUrl,
      successUrl,
      cancelUrl,
    });
  } catch (err) {
    logger.error("payment-intent", "NOWPayments invoice creation failed", {
      error: String(err),
      tier: normalisedTier,
    });
    return apiError(res, 502, "Could not create payment intent.");
  }

  const now = Date.now();
  const expiresAt = now + INTENT_TTL_SECONDS * 1000;
  const intent: PaymentIntent = {
    reference,
    installId,
    ...(emailNorm ? { email: emailNorm } : {}),
    tier: normalisedTier,
    amountUsd,
    payUrl: invoice.invoice_url,
    npInvoiceId: invoice.id,
    createdAt: now,
    expiresAt,
    status: "pending",
  };

  try {
    await saveNewIntent(redis, intent);
  } catch (err) {
    logger.error("payment-intent", "intent persistence failed", {
      error: String(err),
      reference,
    });
    return apiError(res, 500, "Could not persist payment intent.");
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json({
    reference: intent.reference,
    payUrl: intent.payUrl,
    tier: intent.tier,
    amountUsd: intent.amountUsd,
    expiresAt: intent.expiresAt,
  });
}
