// api/_lib/nowpayments.ts — NOWPayments REST client + IPN HMAC verifier.
//
// NOWPayments hosts the crypto checkout (200+ coins, auto fiat conversion)
// so we never touch crypto rails ourselves: we POST an invoice, redirect
// the user to NOWPayments' hosted page, and listen for the IPN webhook
// when payment finalises.
//
// Auth: every API call carries `x-api-key: <NOWPAYMENTS_API_KEY>`. IPN
// callbacks are signed with HMAC-SHA512 over the body's *sorted-keys* JSON
// using NOWPAYMENTS_IPN_SECRET — see verifyIpnSignature().
//
// Docs: https://documenter.getpostman.com/view/7907941/S1a32n38

import { createHmac } from "node:crypto"
import { logger } from "./logger"

const NP_BASE = "https://api.nowpayments.io/v1"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * NOWPayments payment_status values, as documented in their API. We map
 * them onto our internal `pending | confirmed | expired` vocabulary in
 * mapStatus(). Values we never act on (e.g. "sending") still resolve to
 * a sane internal state so the polling UI doesn't spin forever.
 */
export type NpPaymentStatus =
  | "waiting"
  | "confirming"
  | "confirmed"
  | "sending"
  | "partially_paid"
  | "finished"
  | "failed"
  | "refunded"
  | "expired"

export interface NpInvoice {
  id: string
  invoice_url: string
  order_id: string
  price_amount: string
  price_currency: string
  created_at: string
}

export interface NpPayment {
  payment_id: string
  payment_status: NpPaymentStatus
  pay_address?: string
  price_amount: number | string
  price_currency: string
  pay_amount?: number | string
  /** What the buyer really sent, in `pay_currency`. Compared with `pay_amount` (what was asked): see paidRatio(). */
  actually_paid?: number | string
  pay_currency?: string
  order_id?: string
  invoice_id?: string | number
  outcome_amount?: number | string
  outcome_currency?: string
  payin_hash?: string
  payout_hash?: string
  created_at?: string
  updated_at?: string
}

export interface CreateInvoiceParams {
  /** Our own reference key (random). Echoed back as `order_id` in IPN. */
  orderId: string
  /** USD amount as a number (NOWPayments accepts decimals up to 2). */
  priceAmountUsd: number
  /** Human-readable description shown on the checkout page. */
  description: string
  /** URL the IPN webhook POSTs to — must be HTTPS, publicly reachable. */
  ipnCallbackUrl: string
  /** Where NOWPayments redirects the user after a successful payment. */
  successUrl: string
  /** Where NOWPayments redirects the user if they bail out / payment fails. */
  cancelUrl: string
}

// ─── Env helpers ──────────────────────────────────────────────────────────────

function getApiKey(): string | null {
  const key = (process.env.NOWPAYMENTS_API_KEY ?? "").trim()
  return key.length > 0 ? key : null
}

export function isConfigured(): boolean {
  return getApiKey() !== null
}

function getIpnSecret(): string | null {
  const secret = (process.env.NOWPAYMENTS_IPN_SECRET ?? "").trim()
  return secret.length > 0 ? secret : null
}

// ─── REST client ──────────────────────────────────────────────────────────────

/**
 * The longest one NOWPayments call may take, body included. There was no limit: a NOWPayments that hangs held the buyer's
 * status poll (every 2-3 s, so one hung function after another) and the daily cron (one intent after another) until Vercel
 * killed them. 8 s leaves the cron and payment-status room to answer within their own limit.
 */
export const NP_TIMEOUT_MS = 8_000

/** A NOWPayments answer that is not 2xx. `status` is the HTTP status: a caller tells "not found" (404) from "could not ask" by it. */
export class NpApiError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`NOWPayments ${path} failed: ${status}`)
    this.name = "NpApiError"
  }
}

async function npFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error("NOWPAYMENTS_API_KEY not configured")

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  }
  if (init.body && typeof init.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json"
  }

  // The deadline covers the body too: a server can answer its headers at once and then never finish the body.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`NOWPayments ${path} timed out after ${NP_TIMEOUT_MS} ms`)), NP_TIMEOUT_MS)
  try {
    const res = await fetch(`${NP_BASE}${path}`, { ...init, headers, signal: ctrl.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      logger.warn("nowpayments", "API call failed", {
        path,
        status: res.status,
        body: text.slice(0, 200),
      })
      throw new NpApiError(path, res.status)
    }
    return (await res.json()) as T
  } catch (err) {
    // An abort rejects with the signal's reason (the timeout error above), whichever await it interrupted.
    throw ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a hosted-checkout invoice. The buyer is redirected to
 * `invoice_url`, picks a crypto, and pays. NOWPayments fires our IPN
 * webhook on each status transition.
 */
export async function createInvoice(
  params: CreateInvoiceParams,
): Promise<NpInvoice> {
  return npFetch<NpInvoice>("/invoice", {
    method: "POST",
    body: JSON.stringify({
      price_amount: Number(params.priceAmountUsd.toFixed(2)),
      price_currency: "usd",
      order_id: params.orderId,
      order_description: params.description,
      ipn_callback_url: params.ipnCallbackUrl,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      is_fixed_rate: true,
      is_fee_paid_by_user: false,
    }),
  })
}

/** `strict`: rethrow when NOWPayments cannot be asked (anything but a 404), instead of answering "nothing found". */
export interface LookupOpts { strict?: boolean }

/**
 * Look up a payment by its NOWPayments payment_id. Used by the polling
 * endpoint and the cron reconciler. Returns null on 404 (payment not
 * created yet — buyer hasn't picked a crypto on the hosted page).
 */
export async function getPayment(
  paymentId: string,
  opts: LookupOpts = {},
): Promise<NpPayment | null> {
  try {
    return await npFetch<NpPayment>(`/payment/${encodeURIComponent(paymentId)}`)
  } catch (err) {
    // 404 is the common case (buyer hasn't picked a crypto yet) — quiet. Read from the status, not from the message: the message
    // holds the path, i.e. the payment id, and about 1 ten-digit id in 125 contains "404" — a 500, a 429 or a timeout on such a
    // payment read as "no payment", even in strict mode, the one case strict mode exists to rule out.
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof NpApiError && err.status === 404) return null
    logger.warn("nowpayments", "getPayment failed", { paymentId, error: msg })
    // strict: "NOWPayments could not be asked" is NOT "there is no payment" (reconcileIntent expires on the second only).
    if (opts.strict) throw err
    return null
  }
}

/**
 * List payments for a given invoice. NOWPayments creates one payment
 * per crypto-pick attempt, so an invoice can have multiple payment
 * records. We pick the most-progressed one (finished > confirming >
 * waiting) so a half-completed earlier attempt doesn't mask a later
 * successful one.
 */
export async function listPaymentsForInvoice(
  invoiceId: string,
  opts: LookupOpts = {},
): Promise<NpPayment[]> {
  try {
    const res = await npFetch<{ data?: NpPayment[] }>(
      `/payment/?invoiceId=${encodeURIComponent(invoiceId)}&limit=50`,
    )
    return Array.isArray(res?.data) ? res.data : []
  } catch (err) {
    logger.warn("nowpayments", "listPaymentsForInvoice failed", {
      invoiceId,
      error: String(err),
    })
    if (opts.strict) throw err
    return []
  }
}

// ─── Payment choice and amount check ──────────────────────────────────────────

/**
 * An invoice gets one payment record per crypto-pick attempt: the furthest along wins, so a half-completed earlier
 * attempt does not mask a successful retry. One copy, shared by the polling endpoint and the cron.
 */
const PAYMENT_PRIORITY: Record<string, number> = {
  finished: 5,
  confirmed: 4,
  sending: 3,
  confirming: 2,
  partially_paid: 1,
  waiting: 0,
  failed: -1,
  refunded: -1,
  expired: -1,
}

export function pickMostProgressed(payments: NpPayment[]): NpPayment | null {
  if (payments.length === 0) return null
  return [...payments].sort(
    (a, b) => (PAYMENT_PRIORITY[b.payment_status] ?? 0) - (PAYMENT_PRIORITY[a.payment_status] ?? 0),
  )[0]
}

/** Below this share of the asked amount, a payment is an underpayment (1% of slack for rounding and fees). */
export const MIN_PAID_RATIO = 0.99

/**
 * What share of the asked crypto amount the buyer really sent: actually_paid / pay_amount, both in the buyer's currency.
 * undefined when either figure is missing or unusable (nothing to judge from; the caller does not refuse on that).
 * It used to compare price_amount (the invoiced price, copied back by the provider) with the invoice: always equal.
 */
export function paidRatio(p: Pick<NpPayment, "actually_paid" | "pay_amount">): number | undefined {
  if (p.actually_paid === undefined || p.actually_paid === null || p.pay_amount === undefined || p.pay_amount === null) return undefined
  const paid = Number(p.actually_paid)
  const asked = Number(p.pay_amount)
  if (!Number.isFinite(paid) || !Number.isFinite(asked) || asked <= 0 || paid < 0) return undefined
  return paid / asked
}

// ─── Status mapping ───────────────────────────────────────────────────────────

/**
 * Collapse NOWPayments' nine status values onto our internal
 * `pending | confirmed | expired` vocabulary. We treat both `confirmed`
 * (sufficient on-chain confirmations) and `finished` (NOWPayments has
 * forwarded funds to our merchant wallet) as confirmed for license
 * issuance — we got paid, no need to wait for the forwarding hop.
 */
export function mapStatus(
  npStatus: NpPaymentStatus,
): "pending" | "confirmed" | "expired" {
  switch (npStatus) {
    case "confirmed":
    case "sending":
    case "finished":
      return "confirmed"
    case "failed":
    case "refunded":
    case "expired":
      return "expired"
    case "waiting":
    case "confirming":
    case "partially_paid":
    default:
      return "pending"
  }
}

// ─── IPN signature verification ───────────────────────────────────────────────

/**
 * Verify a NOWPayments IPN callback signature. NOWPayments signs every
 * IPN body with HMAC-SHA512 of the JSON payload with keys sorted
 * alphabetically (recursive on nested objects). The signature is sent
 * in the `x-nowpayments-sig` header.
 *
 * Accepts either the raw request body string OR a pre-parsed object
 * — Vercel parses application/json bodies automatically, so endpoints
 * generally only have the parsed form on hand. We canonicalise the
 * payload via stableStringify either way before HMAC'ing.
 *
 * @param body The request body, raw string or already-parsed object.
 * @param sigHeader Value of `x-nowpayments-sig`.
 * @returns true if the signature matches, false otherwise (also false
 *          when NOWPAYMENTS_IPN_SECRET is unset — fail closed).
 */
export function verifyIpnSignature(
  body: string | Record<string, unknown> | unknown,
  sigHeader: string | string[] | undefined,
): boolean {
  const secret = getIpnSecret()
  if (!secret) return false
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
  if (typeof sig !== "string" || sig.length === 0) return false

  let parsed: unknown = body
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body)
    } catch {
      return false
    }
  }
  if (!parsed || typeof parsed !== "object") return false

  const sortedJson = stableStringify(parsed as Record<string, unknown>)
  const expected = createHmac("sha512", secret).update(sortedJson).digest("hex")

  // Constant-time compare to prevent timing-leak (Node 18+ has timingSafeEqual
  // but length-mismatch makes that throw; we slice/pad ourselves).
  if (sig.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * JSON.stringify with keys sorted alphabetically at every nesting level.
 * Required because NOWPayments' HMAC is computed over the canonical
 * sorted form, not the wire-order JSON. Mirrors their official PHP +
 * Node.js examples.
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return "[" + value.map(v => stableStringify(v)).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return (
    "{" +
    keys
      .map(k => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  )
}
