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
import { emailRef } from "./log-ref"
import { setUserTier } from "./user"
import { issueLicense, INTENT_LICENSE_KEY } from "./license"
import { ACCOUNT_INSTALL_KEY } from "./account"
import { MIN_PAID_RATIO } from "./nowpayments"
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
   * Share of the asked crypto amount the buyer really sent (nowpayments.ts paidRatio: actually_paid / pay_amount). When
   * given and < MIN_PAID_RATIO the confirmation is rejected as underpaid. Omit when the provider gave no figures.
   */
  paidRatio?: number
}

export type ConfirmOutcome =
  | { ok: true; intent: PaymentIntent; licenseKey: string | null }
  | { ok: false; reason: "underpaid"; paidRatio: number }

/**
 * Apply all the side effects that happen when a payment intent moves from
 * pending → confirmed:
 *   - Anti-underpay check (rejects when the buyer sent less than MIN_PAID_RATIO of the asked crypto amount)
 *   - Flips the install's user-tier (skipped for synthetic email-only ids)
 *   - Issues a license (idempotent on intent.reference) when email present
 *   - Marks the intent confirmed in Redis
 *
 * Idempotent on the same intent reference — safe to call multiple times
 * for the same payment without double-billing or duplicate licenses.
 *
 * Throws when the license cannot be issued: the intent then stays pending, so the IPN retry, the next poll or the cron
 * run this again (everything before it is idempotent). Swallowing that error used to mark the intent confirmed with no
 * license, and nothing ever came back to it.
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
  const { txSignature, paidRatio } = opts

  // Underpay defence: the buyer must have sent (about) what was asked. 1% of slack for fee/rounding noise.
  if (typeof paidRatio === "number" && Number.isFinite(paidRatio) && paidRatio < MIN_PAID_RATIO) {
    logger.warn("payment-confirm", "underpaid — refusing to confirm", {
      reference: intent.reference,
      expectedUsd: intent.amountUsd,
      paidRatio,
    })
    return { ok: false, reason: "underpaid", paidRatio }
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

    // Auto-bind install→email so the next /api/scan call resolves the
    // user's tier WITHOUT them having to sign in to the website first.
    // Closes the silent-fail loop where:
    //   - User pays from /pricing.html (install_id flowed via the
    //     extension bridge) with their email
    //   - setUserTier writes user:<install>:tier = pro
    //   - But account:install:<install> stays unset
    //   - Next scan: resolveTierAndBypass sees no session AND no
    //     binding → returns Free → extension shows locked overlay
    //     even though the user just paid 10 seconds ago
    //
    // Anti-hijack: only bind when the install is currently UNBOUND.
    // If somehow the install is already tied to a different email
    // (would be unusual), we leave it alone and log a warning so the
    // operator can investigate. Same-email re-bind is a no-op.
    if (intent.email) {
      try {
        const existingBinding = await redis.get<string>(
          ACCOUNT_INSTALL_KEY(intent.installId),
        )
        if (!existingBinding) {
          await redis.set(ACCOUNT_INSTALL_KEY(intent.installId), intent.email)
          logger.info("payment-confirm", "install auto-bound via payment", {
            reference: intent.reference,
            installId: intent.installId,
            emailRef: emailRef(intent.email),
          })
        } else if (existingBinding !== intent.email) {
          logger.warn("payment-confirm", "install bound to different email — leaving as-is", {
            reference: intent.reference,
            installId: intent.installId,
            payerRef: emailRef(intent.email),
            boundRef: emailRef(existingBinding),
          })
        }
        // existingBinding === intent.email → no-op, idempotent
      } catch (err) {
        // Don't fail the whole confirmation on a binding-write hiccup.
        // The user's tier is already set on the install, and the binding
        // can be re-created later via /api/auth/sync-token or /api/redeem.
        logger.warn("payment-confirm", "install binding write failed", {
          reference: intent.reference,
          installId: intent.installId,
          error: String(err),
        })
      }
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
      logger.error("payment-confirm", "license issuance failed — intent stays pending, will be retried", {
        reference: intent.reference,
        error: String(err),
      })
      throw err
    }
  }

  const updated = await markIntentConfirmed(redis, intent, txSignature)

  logger.metric("payment-confirm.intent_confirmed", {
    reference: intent.reference,
    tier: intent.tier,
    amountUsd: intent.amountUsd,
    paidRatio: paidRatio ?? null,
    installId: intent.installId,
    syntheticInstall: isSyntheticInstall,
    hasEmail: !!intent.email,
    txSignature: txSignature ?? null,
  })

  return { ok: true, intent: updated, licenseKey }
}
