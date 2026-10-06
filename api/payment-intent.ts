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
//   ANTARES_PUBLIC_BASE_URL  API host, e.g. https://antares-extension.vercel.app
//                            (used to build the IPN callback URL — the
//                            webhook handler lives on the API host)
//   ANTARES_WEBSITE_URL      Marketing-site host, e.g.
//                            https://antares-website.vercel.app
//                            (used to build the post-payment success +
//                            cancel redirects — account.html lives on
//                            the website, NOT on the API host. Without
//                            this set, NOWPayments redirects buyers to
//                            the API host's /account.html which 404s.)
//   ANTARES_SUCCESS_URL      Optional override for the post-payment redirect
//                            (defaults to ${WEBSITE}/account.html?ref=<reference>)
//   ANTARES_CANCEL_URL       Optional override for the bail-out redirect
//                            (defaults to ${WEBSITE}/account.html?cancelled=1)
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
import { initSentry, captureError } from "./_lib/sentry";

initSentry();

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
 * Resolve the API host — used for the IPN callback URL only. The
 * webhook handler lives on this host (api/auth/nowpayments-ipn.ts),
 * so NOWPayments must POST signature-verified events here.
 *
 *   1. ANTARES_PUBLIC_BASE_URL env var (recommended, explicit)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (auto-set by Vercel on prod deploys)
 *   3. Hardcoded production URL (last resort)
 */
function getApiBaseUrl(): string {
  const explicit = (process.env.ANTARES_PUBLIC_BASE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelProd = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (vercelProd) return `https://${vercelProd.replace(/^https?:\/\//, "")}`;
  return "https://antares-extension.vercel.app";
}

/**
 * Resolve the marketing-site host — used for the post-payment
 * success/cancel redirects. account.html lives on the website repo
 * (deployed to antares-website.vercel.app + GH Pages mirror), NOT on
 * the API host — using the API host as the redirect target would 404
 * the buyer right after paying. This was a real bug that surfaced as
 * "404 page after clicking pay".
 *
 *   1. ANTARES_WEBSITE_URL env var (recommended, explicit)
 *   2. Hardcoded production URL (works for the canonical deployment)
 */
function getWebsiteUrl(): string {
  const explicit = (process.env.ANTARES_WEBSITE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return "https://antares-website.vercel.app";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res, { credentialedOnly: true }); // account state: first-party origins only
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  // Wrap the rest of the handler so a throw from Redis (most commonly:
  // Upstash daily/monthly quota exceeded → checkRateLimit / saveNewIntent
  // bubbles a network-style exception) doesn't end up as Vercel's
  // FUNCTION_INVOCATION_FAILED, which ships a generic 500 page WITHOUT
  // CORS headers. The browser then sees a CORS rejection and surfaces
  // "Failed to fetch" / "Network error" to the user instead of our
  // payload — exactly the symptom on /pricing today. The CORS headers
  // from setCorsHeaders() above stay attached because we respond with
  // res.status().json() ourselves below, on the same response object.
  try {
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
  // IPN callback target = API host (the webhook handler lives there).
  const apiBaseUrl = getApiBaseUrl();
  const ipnCallbackUrl = `${apiBaseUrl}/api/auth/nowpayments-ipn`;
  // Success/cancel redirects = WEBSITE host (account.html lives there,
  // NOT on the API host). Reusing the API host for these used to 404
  // the buyer the moment NOWPayments redirected back after payment.
  const websiteUrl = getWebsiteUrl();
  const successUrl =
    (process.env.ANTARES_SUCCESS_URL ?? `${websiteUrl}/account.html?ref=${reference}`)
      .replace("{reference}", reference);
  const cancelUrl =
    process.env.ANTARES_CANCEL_URL ?? `${websiteUrl}/account.html?cancelled=1`;

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
    captureError(err, { endpoint: "payment-intent", phase: "createInvoice", tier: normalisedTier });
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
    captureError(err, { endpoint: "payment-intent", phase: "saveNewIntent", reference });
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
  } catch (err) {
    // Catches anything the inner try/catches around createInvoice and
    // saveNewIntent didn't cover — primarily Redis errors from
    // checkRateLimit and getAccountFromRequest above, plus any future
    // path that throws unhandled. Classify quota / transient errors
    // as 503 so the website's pricing.js shows a clear retry message
    // instead of the misleading "Network error".
    const errMsg = String((err as Error)?.message || err);
    logger.error("payment-intent", "unhandled exception", { error: errMsg });
    captureError(err, { endpoint: "payment-intent", phase: "dispatcher-catch" });
    if (res.headersSent) return;
    const lower = errMsg.toLowerCase();
    const isQuotaOrTransient =
      lower.includes("upstash") ||
      lower.includes("daily limit") ||
      lower.includes("rate limit") ||
      lower.includes("quota") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("max requests");
    if (isQuotaOrTransient) {
      return res.status(503).json({
        error: "service_unavailable",
        message:
          "Service temporarily unavailable. Please try again in a few minutes.",
      });
    }
    return res.status(500).json({
      error: "internal_error",
      message: "An internal error occurred. Please try again.",
    });
  }
}
