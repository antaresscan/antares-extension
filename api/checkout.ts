// api/checkout.ts — Build a NOWPayments crypto checkout invoice and return
// the hosted-payment URL for the user's chosen tier.
//
//   GET /api/checkout?tier=monthly|lifetime&install_id=<id>
//
// Returns: { url, tier }
//
// The pricing page calls this and redirects the browser to NP's hosted
// checkout, where the user picks BTC / ETH / SOL / USDC / USDT / etc. and
// pays. install_id rides through as part of `order_id` so the NP webhook
// (api/webhook-nowpayments.ts) can map the payment back to the right user.
//
// Configure at deploy time:
//   NOWPAYMENTS_API_KEY  — API key from https://account.nowpayments.io
//
// Until that's set the endpoint returns 503 + machine-readable
// {error:"checkout_not_configured"} so the frontend can show "Coming soon"
// rather than a broken button.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { createInvoice } from "./_lib/nowpayments";

// Same install_id shape as the rate limiter / quota system.
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const KNOWN_TIERS = ["monthly", "pro", "lifetime"] as const;
type Tier = (typeof KNOWN_TIERS)[number];

function isValidTier(v: string): v is Tier {
  return (KNOWN_TIERS as readonly string[]).includes(v);
}

function priceFor(tier: Tier): number {
  if (tier === "lifetime") {
    const v = parseFloat(process.env.NOWPAYMENTS_PRICE_LIFETIME ?? "99");
    return Number.isFinite(v) && v > 0 ? v : 99;
  }
  // monthly == pro alias — both go to the 30-day pass
  const v = parseFloat(process.env.NOWPAYMENTS_PRICE_PRO ?? "14.99");
  return Number.isFinite(v) && v > 0 ? v : 14.99;
}

const DEFAULT_API_HOST = "https://antares-extension.vercel.app";
const DEFAULT_SITE_HOST = "https://antares-website.vercel.app";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const rawTier = String(req.query.tier ?? "").trim().toLowerCase();
  const rawInstallId = String(req.query.install_id ?? "").trim();

  if (!isValidTier(rawTier)) {
    return apiError(res, 400, "tier must be 'monthly' or 'lifetime'.");
  }
  if (!INSTALL_ID_RE.test(rawInstallId)) {
    return apiError(res, 400, "Valid install_id query param required.");
  }

  const apiKey = process.env.NOWPAYMENTS_API_KEY ?? "";
  if (!apiKey) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res
      .status(503)
      .json({ error: "checkout_not_configured", message: "Checkout not available yet." });
  }

  // 'pro' is just a UX alias — under the hood it's the 30-day monthly pass.
  const normalisedTier: "monthly" | "lifetime" =
    rawTier === "lifetime" ? "lifetime" : "monthly";

  const apiHost = process.env.PUBLIC_API_HOST ?? DEFAULT_API_HOST;
  const siteHost = process.env.PUBLIC_SITE_HOST ?? DEFAULT_SITE_HOST;

  try {
    const invoice = await createInvoice(apiKey, {
      installId: rawInstallId,
      tier: normalisedTier,
      priceAmount: priceFor(rawTier),
      priceCurrency: "usd",
      ipnCallbackUrl: `${apiHost}/api/webhook-nowpayments`,
      successUrl: `${siteHost}/pricing.html?paid=1`,
      cancelUrl: `${siteHost}/pricing.html`,
    });

    if (!invoice.invoice_url) {
      logger.error("checkout", "NP invoice missing invoice_url", { invoice });
      return apiError(res, 502, "Checkout provider returned malformed invoice.");
    }

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.json({
      url: invoice.invoice_url,
      tier: normalisedTier,
    });
  } catch (err) {
    logger.error("checkout", "NP invoice creation failed", { error: String(err) });
    return apiError(res, 502, "Could not create checkout invoice.");
  }
}
