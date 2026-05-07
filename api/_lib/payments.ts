// api/_lib/payments.ts — Provider-agnostic payment-intent store.
//
// Replaces the Solana-Pay-specific intent module. The shape is now
// neutral so we can swap the underlying provider (currently NOWPayments,
// previously Solana Pay) without changing every consumer.
//
// Persisted shape (Redis):
//   payment-intent:<reference>      → JSON of PaymentIntent
//   payment-intents:pending         → SET of references in flight
//   payment-intent-by-np:<paymentId> → reference (so the IPN webhook can
//                                      look up the intent from a NOWPayments
//                                      payment_id without scanning)

import { Redis } from "@upstash/redis"
import { logger } from "./logger"

// ─── Constants ────────────────────────────────────────────────────────────────

export const PRO_PASS_DAYS = 30
export const YEARLY_DAYS = 365
/** 1h checkout window — NOWPayments invoices live ~24h on their side, but
 *  we surface "expired" earlier client-side so the modal doesn't sit on a
 *  stale invoice URL forever. */
export const INTENT_TTL_SECONDS = 60 * 60

export const INTENT_KEY = (reference: string) => `payment-intent:${reference}`
export const INTENT_INDEX_KEY = "payment-intents:pending"
export const INTENT_BY_NP_PAYMENT_KEY = (paymentId: string) =>
  `payment-intent-by-np:${paymentId}`
export const INTENT_BY_NP_INVOICE_KEY = (invoiceId: string) =>
  `payment-intent-by-inv:${invoiceId}`

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Tier vocabulary used at the payment-intent layer:
 *   "monthly" → 30-day Pro pass
 *   "yearly"  → 365-day subscription (replaces legacy "lifetime")
 *
 * Translated to the user-tier vocabulary at confirmation time
 * (license.ts::intentTierToLicenseTier).
 */
export type Tier = "monthly" | "yearly"

export type IntentStatus = "pending" | "confirmed" | "expired"

export interface PaymentIntent {
  /**
   * Our own random reference key (32 bytes hex). Used everywhere as
   * the intent identity — passed to NOWPayments as `order_id` so we
   * can correlate IPN callbacks back to the intent.
   */
  reference: string
  /**
   * Extension install identifier when present. Optional — direct
   * site visitors who haven't installed yet pass an email instead.
   */
  installId: string
  email?: string
  tier: Tier
  /** USD price locked at intent creation. */
  amountUsd: number
  /** URL the buyer is redirected to on the provider's side. */
  payUrl: string
  /** Provider invoice id (NOWPayments invoice.id). */
  npInvoiceId: string
  /**
   * Provider payment id, set on the first IPN callback once the
   * buyer has picked a crypto. Null until then.
   */
  npPaymentId?: string
  /** Network-side tx hash from NOWPayments (payin_hash) on confirm. */
  txSignature?: string
  createdAt: number
  expiresAt: number
  status: IntentStatus
  confirmedAt?: number
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

/**
 * USD price of a tier. Env-overridable via:
 *   ANTARES_PRICE_MONTHLY_USD (default 24.99)
 *   ANTARES_PRICE_YEARLY_USD  (default 149.99)
 *
 * Legacy SOLANA_PRICE_*_USDC env vars are honoured as fallback so the
 * existing Vercel deployment doesn't silently switch to default prices
 * during the migration.
 */
export function priceUsd(tier: Tier): number {
  if (tier === "yearly") {
    const v =
      parseFloat(process.env.ANTARES_PRICE_YEARLY_USD ?? "") ||
      parseFloat(process.env.SOLANA_PRICE_YEARLY_USDC ?? "") ||
      parseFloat(process.env.SOLANA_PRICE_LIFETIME_USDC ?? "")
    if (Number.isFinite(v) && v > 0) return v
    return 149.99
  }
  const v =
    parseFloat(process.env.ANTARES_PRICE_MONTHLY_USD ?? "") ||
    parseFloat(process.env.SOLANA_PRICE_PRO_USDC ?? "")
  if (Number.isFinite(v) && v > 0) return v
  return 24.99
}

// ─── Reference generator ─────────────────────────────────────────────────────

import { randomBytes } from "node:crypto"

/**
 * 32 bytes of randomness, hex-encoded → 64-char string. Way more entropy
 * than needed for collision avoidance; doubles as the URL-safe
 * payment-status query param.
 */
export function generateReference(): string {
  return randomBytes(32).toString("hex")
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function saveNewIntent(
  redis: Redis,
  intent: PaymentIntent,
): Promise<void> {
  await redis.set(INTENT_KEY(intent.reference), intent, {
    ex: INTENT_TTL_SECONDS + 60 * 60,
  })
  await redis.sadd(INTENT_INDEX_KEY, intent.reference)
  if (intent.npInvoiceId) {
    await redis.set(
      INTENT_BY_NP_INVOICE_KEY(intent.npInvoiceId),
      intent.reference,
      { ex: INTENT_TTL_SECONDS + 60 * 60 },
    )
  }
}

export async function getPaymentIntent(
  redis: Redis,
  reference: string,
): Promise<PaymentIntent | null> {
  try {
    const raw = await redis.get<PaymentIntent>(INTENT_KEY(reference))
    return raw ?? null
  } catch (err) {
    logger.warn("payments", "intent get failed", { error: String(err) })
    return null
  }
}

export async function getIntentByNpPaymentId(
  redis: Redis,
  paymentId: string,
): Promise<PaymentIntent | null> {
  try {
    const ref = await redis.get<string>(INTENT_BY_NP_PAYMENT_KEY(paymentId))
    if (!ref) return null
    return await getPaymentIntent(redis, ref)
  } catch {
    return null
  }
}

export async function getIntentByNpInvoiceId(
  redis: Redis,
  invoiceId: string,
): Promise<PaymentIntent | null> {
  try {
    const ref = await redis.get<string>(INTENT_BY_NP_INVOICE_KEY(invoiceId))
    if (!ref) return null
    return await getPaymentIntent(redis, ref)
  } catch {
    return null
  }
}

/**
 * Bind a NOWPayments payment_id to an intent reference. Called the first
 * time we observe a payment_id (either from the polling endpoint or the
 * IPN webhook) so subsequent IPN callbacks for the same payment can be
 * looked up in O(1).
 */
export async function bindNpPaymentId(
  redis: Redis,
  intent: PaymentIntent,
  npPaymentId: string,
): Promise<PaymentIntent> {
  const updated: PaymentIntent = { ...intent, npPaymentId }
  await redis.set(INTENT_KEY(intent.reference), updated, {
    ex: INTENT_TTL_SECONDS + 60 * 60,
  })
  await redis.set(INTENT_BY_NP_PAYMENT_KEY(npPaymentId), intent.reference, {
    ex: INTENT_TTL_SECONDS + 60 * 60,
  })
  return updated
}

export async function listPendingIntentReferences(
  redis: Redis,
): Promise<string[]> {
  try {
    const refs = await redis.smembers(INTENT_INDEX_KEY)
    return refs ?? []
  } catch (err) {
    logger.warn("payments", "pending list failed", { error: String(err) })
    return []
  }
}

export async function markIntentConfirmed(
  redis: Redis,
  intent: PaymentIntent,
  txSignature?: string,
): Promise<PaymentIntent> {
  const updated: PaymentIntent = {
    ...intent,
    status: "confirmed",
    confirmedAt: Date.now(),
    ...(txSignature ? { txSignature } : {}),
  }
  // Keep confirmed intents 24h for audit / status polling after the fact.
  await redis.set(INTENT_KEY(intent.reference), updated, {
    ex: INTENT_TTL_SECONDS + 24 * 60 * 60,
  })
  await redis.srem(INTENT_INDEX_KEY, intent.reference)
  return updated
}

export async function markIntentExpired(
  redis: Redis,
  intent: PaymentIntent,
): Promise<PaymentIntent> {
  const updated: PaymentIntent = { ...intent, status: "expired" }
  await redis.set(INTENT_KEY(intent.reference), updated, { ex: 60 * 60 })
  await redis.srem(INTENT_INDEX_KEY, intent.reference)
  return updated
}
