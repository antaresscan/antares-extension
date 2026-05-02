// api/checkout.ts — Build a Lemonsqueezy checkout URL with install_id baked in.
//
//   GET /api/checkout?tier=monthly|lifetime&install_id=<id>
//
// Returns: { url, tier, variant }
//
// The pricing page calls this and either redirects the user or opens the
// returned URL in a popup. install_id ends up in the Lemonsqueezy webhook's
// `meta.custom_data` so we can flip the right user's tier when payment
// completes (handled in api/webhook-lemonsqueezy.ts).
//
// Configure at deploy time:
//   LEMONSQUEEZY_STORE_DOMAIN     e.g. "antares.lemonsqueezy.com"
//   LEMONSQUEEZY_VARIANT_PRO      variant ID for Pro Monthly
//   LEMONSQUEEZY_VARIANT_LIFETIME variant ID for Lifetime
//
// Until any of those are set the endpoint refuses with 503 "not configured" —
// callers can branch on that to show "Coming soon" instead of a broken button.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";

// Same install_id shape as the rate limiter / quota system. Strict to keep
// arbitrary user input out of the URL we hand back to the browser.
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const KNOWN_TIERS = ["monthly", "pro", "lifetime"] as const;
type Tier = (typeof KNOWN_TIERS)[number];

function isValidTier(v: string): v is Tier {
  return (KNOWN_TIERS as readonly string[]).includes(v);
}

function pickVariant(tier: Tier): string | null {
  if (tier === "monthly" || tier === "pro") {
    return process.env.LEMONSQUEEZY_VARIANT_PRO ?? null;
  }
  if (tier === "lifetime") {
    return process.env.LEMONSQUEEZY_VARIANT_LIFETIME ?? null;
  }
  return null;
}

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

  const storeDomain = process.env.LEMONSQUEEZY_STORE_DOMAIN ?? "";
  const variant = pickVariant(rawTier);
  if (!storeDomain || !variant) {
    // 503 + machine-readable code so the frontend can show a friendly
    // "checkout coming soon" instead of a generic error.
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res
      .status(503)
      .json({ error: "checkout_not_configured", message: "Checkout not available yet." });
  }

  // Build the LS checkout URL — install_id rides as `checkout[custom][install_id]`
  // which Lemonsqueezy passes through to the webhook's meta.custom_data.
  const url = new URL(`https://${storeDomain}/checkout/buy/${variant}`);
  url.searchParams.set("checkout[custom][install_id]", rawInstallId);
  // Optional: prefill no fields, let the user enter their own email — we
  // never see it (LS handles billing). The custom_data is our only link.

  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json({
    url: url.toString(),
    tier: rawTier,
    variant,
  });
}
