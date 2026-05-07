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

/**
 * Apply all the side effects that happen when a payment intent moves from
 * pending → confirmed:
 *   - Flips the install's user-tier (skipped for synthetic email-only ids)
 *   - Issues a license (idempotent on intent.reference) when email present
 *   - Marks the intent confirmed in Redis
 *
 * @returns The license key when one was issued (or already existed for
 *          this intent), null otherwise.
 */
export async function confirmIntent(
  redis: Redis,
  intent: PaymentIntent,
  txSignature?: string,
): Promise<{ intent: PaymentIntent; licenseKey: string | null }> {
  if (intent.status === "confirmed") {
    // Already done — re-read existing license key for idempotent return.
    let licenseKey: string | null = null
    if (intent.email) {
      try {
        licenseKey =
          (await redis.get<string>(INTENT_LICENSE_KEY(intent.reference))) ?? null
      } catch { /* ignore */ }
    }
    return { intent, licenseKey }
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
    installId: intent.installId,
    syntheticInstall: isSyntheticInstall,
    hasEmail: !!intent.email,
    txSignature: txSignature ?? null,
  })

  return { intent: updated, licenseKey }
}
