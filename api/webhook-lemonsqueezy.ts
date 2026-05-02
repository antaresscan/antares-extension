// api/webhook-lemonsqueezy.ts — receives Lemonsqueezy subscription webhooks
// and flips Antares user tiers accordingly.
//
// Configure at deploy time:
//   - LEMONSQUEEZY_WEBHOOK_SECRET    HMAC signing secret from LS dashboard
//   - LEMONSQUEEZY_VARIANT_LIFETIME  variant ID of the $99 Lifetime product
//
// Until those env vars are set the endpoint refuses every request with 401.
// Safe by default: we never want to flip tiers based on unsigned input.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import {
  initUserStorage,
  setUserTier,
} from "./_lib/user";
import {
  verifyWebhookSignature,
  resolveTierAction,
  tryParseWebhook,
  HANDLED_EVENTS,
} from "./_lib/lemonsqueezy";

// Vercel auto-parses JSON bodies by default, but we need the raw bytes for
// HMAC verification — opt out of body parsing on this route only.
export const config = {
  api: {
    bodyParser: false,
  },
};

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initUserStorage(redis);
}

/** Read the raw request body as a UTF-8 string so we can HMAC-verify it. */
async function readRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return apiError(res, 405, "Method not allowed.");
  }

  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET ?? "";
  if (!secret) {
    // No signing secret configured — fail closed. Do not accept any payload.
    logger.warn("webhook-lemonsqueezy", "rejected: no signing secret configured");
    return apiError(res, 401, "Webhook receiver not configured.");
  }

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    logger.error("webhook-lemonsqueezy", "raw body read failed", { error: String(err) });
    return apiError(res, 400, "Could not read request body.");
  }

  const signature = (req.headers["x-signature"] ?? req.headers["X-Signature"]) as
    | string
    | undefined;

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    logger.warn("webhook-lemonsqueezy", "rejected: invalid signature");
    return apiError(res, 401, "Invalid signature.");
  }

  const payload = tryParseWebhook(rawBody);
  if (!payload) {
    return apiError(res, 400, "Malformed webhook payload.");
  }

  const eventName = payload.meta.event_name;

  // Acknowledge unhandled events with 200 so LS doesn't keep retrying — the
  // log line below is enough to diagnose later if needed.
  if (!HANDLED_EVENTS.has(eventName)) {
    logger.warn("webhook-lemonsqueezy", "unhandled event", { event: eventName });
    return res.status(200).json({ received: true, handled: false, event: eventName });
  }

  const action = resolveTierAction(payload, {
    lifetimeVariantId: process.env.LEMONSQUEEZY_VARIANT_LIFETIME,
  });

  try {
    switch (action.kind) {
      case "set_pro":
        await setUserTier(action.installId, "pro", action.expiresAtMs ?? undefined);
        logger.metric("webhook-lemonsqueezy.tier_set", {
          tier: "pro",
          installId: action.installId,
          expiresAtMs: action.expiresAtMs,
          event: eventName,
        });
        break;

      case "set_lifetime":
        await setUserTier(action.installId, "lifetime");
        logger.metric("webhook-lemonsqueezy.tier_set", {
          tier: "lifetime",
          installId: action.installId,
          event: eventName,
        });
        break;

      case "set_free":
        await setUserTier(action.installId, "free");
        logger.metric("webhook-lemonsqueezy.tier_set", {
          tier: "free",
          installId: action.installId,
          event: eventName,
        });
        break;

      case "noop":
        logger.warn("webhook-lemonsqueezy", "no-op", {
          event: eventName,
          reason: action.reason,
        });
        break;
    }

    return res.status(200).json({
      received: true,
      handled: true,
      event: eventName,
      action: action.kind,
    });
  } catch (err) {
    logger.error("webhook-lemonsqueezy", "tier write failed", {
      error: String(err),
      event: eventName,
      action: action.kind,
    });
    // Return 500 so LS retries — Redis hiccups shouldn't lose paid upgrades.
    return apiError(res, 500, "Internal error processing webhook.");
  }
}
