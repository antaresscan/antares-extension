// api/_lib/payment-reconcile.ts — One reconciliation of a pending intent against NOWPayments.
//
// Shared by /api/payment-status (polling) and /api/cron-check-payments. The two used to carry their own copy, and both
// expired an intent on the CLOCK before asking the provider: a payment that was real but slow (crypto confirmations, an
// invoice that lives ~24h on NOWPayments, a cron that runs once a day) found its intent already expired and deleted, was
// never confirmed, and the buyer paid for nothing.
//
// The rule now: an intent expires only when
//   - NOWPayments says its payment is dead (failed / refunded / expired), or
//   - the checkout window is over AND no payment exists for the invoice.
// A payment that exists and is still moving (waiting / confirming / partially paid / sending) keeps the intent pending,
// past the window, until the provider settles it.
import type { Redis } from "@upstash/redis"
import { bindNpPaymentId, markIntentExpired, type PaymentIntent } from "./payments"
import {
  getPayment,
  listPaymentsForInvoice,
  mapStatus,
  paidRatio,
  pickMostProgressed,
  type NpPayment,
} from "./nowpayments"
import { confirmIntent } from "./payment-confirm"
import { INTENT_LICENSE_KEY } from "./license"

/**
 * The payment that tells where the intent stands: the bound one (fast path), unless it is dead and the invoice has another
 * attempt, then the most progressed of the invoice. Throws when NOWPayments cannot be asked: "could not ask" must never be
 * read as "no payment" (that is the case in which an intent gets expired).
 */
export async function findCanonicalPayment(intent: PaymentIntent): Promise<NpPayment | null> {
  let bound: NpPayment | null = null
  if (intent.npPaymentId) {
    bound = await getPayment(intent.npPaymentId, { strict: true })
    if (bound && mapStatus(bound.payment_status) !== "expired") return bound
  }
  if (intent.npInvoiceId) {
    const best = pickMostProgressed(await listPaymentsForInvoice(intent.npInvoiceId, { strict: true }))
    if (best) return best
  }
  return bound
}

export type Reconciled =
  | { state: "confirmed"; intent: PaymentIntent; licenseKey: string | null }
  | { state: "underpaid"; intent: PaymentIntent; paidRatio: number }
  | { state: "expired"; intent: PaymentIntent }
  | { state: "pending"; intent: PaymentIntent }

async function storedLicenseKey(redis: Redis, intent: PaymentIntent): Promise<string | null> {
  if (!intent.email) return null
  try {
    return (await redis.get<string>(INTENT_LICENSE_KEY(intent.reference))) ?? null
  } catch {
    return null // non-critical: the buyer can read it from their account
  }
}

/**
 * Ask NOWPayments where this intent's payment stands and apply it. Throws when NOWPayments cannot be asked or when the
 * confirmation fails (license): the caller logs it and the intent stays as it was, to be retried by the next poll / IPN /
 * cron run. `now` is injectable for tests.
 */
export async function reconcileIntent(redis: Redis, intent: PaymentIntent, now: number = Date.now()): Promise<Reconciled> {
  if (intent.status === "confirmed") return { state: "confirmed", intent, licenseKey: await storedLicenseKey(redis, intent) }
  if (intent.status === "expired") return { state: "expired", intent }

  const canonical = await findCanonicalPayment(intent)
  if (!canonical) {
    // Nothing paid or started. Only now can the clock close the intent.
    if (now > intent.expiresAt) return { state: "expired", intent: await markIntentExpired(redis, intent) }
    return { state: "pending", intent }
  }

  // First time we see this payment id: bind it so the IPN and the next polls take the fast path.
  let working = intent
  if (!working.npPaymentId && canonical.payment_id) {
    try {
      working = await bindNpPaymentId(redis, working, String(canonical.payment_id))
    } catch { /* non-critical */ }
  }

  const internal = mapStatus(canonical.payment_status)
  if (internal === "confirmed") {
    const txSignature = canonical.payin_hash ?? canonical.payout_hash ?? undefined
    const ratio = paidRatio(canonical)
    const outcome = await confirmIntent(redis, working, {
      txSignature: typeof txSignature === "string" ? txSignature : undefined,
      paidRatio: ratio,
    })
    if (!outcome.ok) return { state: "underpaid", intent: working, paidRatio: outcome.paidRatio }
    return { state: "confirmed", intent: outcome.intent, licenseKey: outcome.licenseKey }
  }
  if (internal === "expired") return { state: "expired", intent: await markIntentExpired(redis, working) }
  return { state: "pending", intent: working }
}
