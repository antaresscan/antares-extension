// api/webhook-nowpayments.ts — receives NOWPayments IPN (Instant Payment
// Notifications) and flips Antares user tiers when crypto payments confirm
// on-chain.
//
// Configure at deploy time:
//   NOWPAYMENTS_IPN_SECRET — HMAC-SHA512 signing secret from NP dashboard
//
// Until that env var is set the endpoint refuses every request with 401.
// Safe by default: never flip a tier based on an unverifiable payload.
//
// IPN URL to register on NOWPayments:
//   https://antares-extension.vercel.app/api/webhook-nowpayments
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { initUserStorage, setUserTier } from "./_lib/user";
import {
  verifyWebhookSignature,
  resolveTierAction,
  tryParseIpn,
} from "./_lib/nowpayments";

// Vercel auto-parses JSON, but HMAC verification needs the exact byte
// sequence NP signed against — opt out of body parsing on this route only.
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

/** Read the raw request body as a UTF-8 string for HMAC verification. */
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

  const secret = process.env.NOWPAYMENTS_IPN_SECRET ?? "";
  if (!secret) {
    logger.warn("webhook-nowpayments", "rejected: no IPN secret configured");
    return apiError(res, 401, "Webhook receiver not configured.");
  }

  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    logger.error("webhook-nowpayments", "raw body read failed", { error: String(err) });
    return apiError(res, 400, "Could not read request body.");
  }

  // NP uses lowercase header `x-nowpayments-sig` per their docs. Vercel
  // lowercases all headers anyway; the explicit `X-` fallback is belt-and-
  // braces for the rare proxy that preserves case.
  const signature =
    (req.headers["x-nowpayments-sig"] ?? req.headers["X-Nowpayments-Sig"]) as
      | string
      | undefined;

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    logger.warn("webhook-nowpayments", "rejected: invalid signature");
    return apiError(res, 401, "Invalid signature.");
  }

  const payload = tryParseIpn(rawBody);
  if (!payload) {
    return apiError(res, 400, "Malformed IPN payload.");
  }

  const action = resolveTierAction(payload);

  try {
    switch (action.kind) {
      case "set_pro":
        await setUserTier(action.installId, "pro", action.expiresAtMs);
        logger.metric("webhook-nowpayments.tier_set", {
          tier: "pro",
          installId: action.installId,
          expiresAtMs: action.expiresAtMs,
          paymentStatus: payload.payment_status,
          payCurrency: payload.pay_currency,
          actuallyPaid: payload.actually_paid,
        });
        break;

      case "set_lifetime":
        await setUserTier(action.installId, "lifetime");
        logger.metric("webhook-nowpayments.tier_set", {
          tier: "lifetime",
          installId: action.installId,
          paymentStatus: payload.payment_status,
          payCurrency: payload.pay_currency,
          actuallyPaid: payload.actually_paid,
        });
        break;

      case "set_free":
        await setUserTier(action.installId, "free");
        logger.metric("webhook-nowpayments.tier_set", {
          tier: "free",
          installId: action.installId,
          paymentStatus: payload.payment_status,
          reason: "refund",
        });
        break;

      case "noop":
        logger.warn("webhook-nowpayments", "no-op", {
          paymentStatus: payload.payment_status,
          reason: action.reason,
        });
        break;
    }

    return res.status(200).json({
      received: true,
      action: action.kind,
      payment_status: payload.payment_status,
    });
  } catch (err) {
    logger.error("webhook-nowpayments", "tier write failed", {
      error: String(err),
      paymentStatus: payload.payment_status,
      action: action.kind,
    });
    // 500 so NOWPayments retries — Redis hiccups shouldn't lose paid upgrades.
    return apiError(res, 500, "Internal error processing webhook.");
  }
}
