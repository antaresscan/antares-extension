// api/_lib/payment-confirm.ts — Shared "intent confirmed" side effects.
//
// Lives in a dedicated file rather than inside payments.ts to avoid a
// circular dep (license.ts already pulls Tier + PRO_PASS_DAYS from
// payments.ts). Three callers go through this:
//
//   1. /api/payment-status polling (lazy confirm when status flips)
//   2. /api/auth/nowpayments-ipn webhook (push confirmation from provider)
//   3. /api/cron-check-payments reconciler (safety net for missed webhooks)
//
// Idempotent on the same intent reference — safe to call multiple times
// for the same payment without double-billing or duplicate licenses.

import type { Redis } from "@upstash/redis"
import { logger } from "./logger"
import { setUserTier } from "./user"
import { issueLicense, INTENT_LICENSE_KEY } from "./license"
import {
  PRO_PASS_DAYS,
  YEARLY_DAYS,
  markIntentConfirmed,
  type PaymentIntent,
} from "./payments"

export interface ConfirmIntentOpts {
  /** On-chain tx hash from the provider (payin_hash / payout_hash). */
  txSignature?: string
  /**
   * USD amount the provider reports as paid. When given and < 99% of
   * intent.amountUsd, the confirmation is rejected as underpaid. Pass
   * `undefined` (or omit) when the caller has no reported amount on
   * hand (e.g. polling endpoints with no payload to verify against).
   */
  reportedUsd?: number
}

export type ConfirmOutcome =
  | { ok: true; intent: PaymentIntent; licenseKey: string | null }
  | { ok: false; reason: "underpaid"; expectedUsd: number; reportedUsd: number }

/**
 * Apply all the side effects that happen when a payment intent moves from
 * pending → confirmed:
 *   - Anti-underpay check (rejects when reportedUsd < intent.amountUsd * 0.99)
 *   - Flips the install's user-tier (skipped for synthetic email-only ids)
 *   - Issues a license (idempotent on intent.reference) when email present
 *   - Marks the intent confirmed in Redis
 *
 * Idempotent on the same intent reference — safe to call multiple times
 * for the same payment without double-billing or duplicate licenses.
 *
 * @returns On success, the updated intent and license key (when one was
 *          issued or already existed). On underpay, an error envelope so
 *          the caller can return a structured 200/4xx to the IPN sender.
 */
export async function confirmIntent(
  redis: Redis,
  intent: PaymentIntent,
  opts: ConfirmIntentOpts = {},
): Promise<ConfirmOutcome> {
  const { txSignature, reportedUsd } = opts

  // Underpay defence — reject if the provider reports materially less
  // than expected. 1% tolerance for fee/rounding noise.
  if (
    typeof reportedUsd === "number" &&
    Number.isFinite(reportedUsd) &&
    reportedUsd > 0 &&
    reportedUsd < intent.amountUsd * 0.99
  ) {
    logger.warn("payment-confirm", "underpaid — refusing to confirm", {
      reference: intent.reference,
      expectedUsd: intent.amountUsd,
      reportedUsd,
    })
    return {
      ok: false,
      reason: "underpaid",
      expectedUsd: intent.amountUsd,
      reportedUsd,
    }
  }

  if (intent.status === "confirmed") {
    // Already done — re-read existing license key for idempotent return.
    let licenseKey: string | null = null
    if (intent.email) {
      try {
        licenseKey =
          (await redis.get<string>(INTENT_LICENSE_KEY(intent.reference))) ?? null
      } catch { /* ignore */ }
    }
    return { ok: true, intent, licenseKey }
  }

  const tierExpiresAt =
    intent.tier === "yearly"
      ? Date.now() + YEARLY_DAYS * 24 * 60 * 60 * 1000
      : Date.now() + PRO_PASS_DAYS * 24 * 60 * 60 * 1000

  const isSyntheticInstall = intent.installId.startsWith("email:")
  if (!isSyntheticInstall) {
    try {
      await setUserTier(
        intent.installId,
        intent.tier === "yearly" ? "yearly" : "pro",
        tierExpiresAt,
      )
    } catch (err) {
      logger.warn("payment-confirm", "setUserTier failed", {
        reference: intent.reference,
        error: String(err),
      })
    }
  }

  let licenseKey: string | null = null
  if (intent.email) {
    try {
      const license = await issueLicense(redis, {
        email: intent.email,
        tier: intent.tier,
        intentReference: intent.reference,
        amountUsd: intent.amountUsd,
      })
      licenseKey = license.key
    } catch (err) {
      logger.warn("payment-confirm", "license issuance failed", {
        reference: intent.reference,
        error: String(err),
      })
    }
  }

  const updated = await markIntentConfirmed(redis, intent, txSignature)

  logger.metric("payment-confirm.intent_confirmed", {
    reference: intent.reference,
    tier: intent.tier,
    amountUsd: intent.amountUsd,
    reportedUsd: reportedUsd ?? null,
    installId: intent.installId,
    syntheticInstall: isSyntheticInstall,
    hasEmail: !!intent.email,
    txSignature: txSignature ?? null,
  })

  return { ok: true, intent: updated, licenseKey }
}
