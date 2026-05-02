// api/redeem.ts — Redeem a license key against an install_id.
//
//   POST /api/redeem
//   Body:    { license_key: string, install_id: string }
//   Returns: { ok, tier, expiresAt? } on success
//            { ok: false, reason } on failure (404, 409, 400)
//
// Called by the extension's options page after the user pastes a license
// key they received from the pricing-page modal (or from /account.html).
// The key is treated as a single-use credential: redeeming it binds the
// license to the install_id and flips that install's tier in Redis. A
// subsequent attempt with the same install_id returns the same success
// (idempotent reclaim — useful if the user re-installs the extension).
// A different install_id sees `already_redeemed`.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders } from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { initUserStorage } from "./_lib/user";
import { redeemLicense, isValidLicenseKey } from "./_lib/license";

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const body = readBody(req);
  const licenseKey = String(body.license_key ?? "").trim().toUpperCase();
  const installId = String(body.install_id ?? "").trim();

  if (!isValidLicenseKey(licenseKey)) {
    return res.status(400).json({
      ok: false,
      reason: "invalid_format",
      message: "License key format is ANT-XXXX-XXXX-XXXX-XXXX.",
    });
  }
  if (!INSTALL_ID_RE.test(installId)) {
    return apiError(res, 400, "Valid install_id required in body.");
  }

  const redis = getRedis();
  if (!redis) {
    return apiError(res, 503, "Storage unavailable.");
  }
  initUserStorage(redis);

  try {
    const outcome = await redeemLicense(redis, licenseKey, installId);
    if (!outcome.ok) {
      // 404 for unknown / 409 for already-redeemed-by-someone-else /
      // 400 for invalid format (the format check above should catch
      // most of these but redeemLicense double-checks for safety).
      const status =
        outcome.reason === "not_found"
          ? 404
          : outcome.reason === "already_redeemed"
            ? 409
            : 400;
      return res.status(status).json({ ok: false, reason: outcome.reason });
    }

    logger.metric("redeem.success", {
      licenseKey,
      installId,
      tier: outcome.license.tier,
    });

    return res.json({
      ok: true,
      tier: outcome.license.tier,
      expiresAt: outcome.license.expiresAt ?? null,
      email: outcome.license.email,
    });
  } catch (err) {
    logger.error("redeem", "redemption failed", { error: String(err) });
    return apiError(res, 500, "Could not redeem license.");
  }
}
