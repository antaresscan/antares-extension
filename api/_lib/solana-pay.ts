// api/_lib/solana-pay.ts — Solana Pay direct on-chain payment flow.
//
// Zero middleman, zero fee (beyond Solana network gas ~$0.0001), zero KYC.
// User signs a USDC SPL transfer (or native SOL) directly from their wallet
// to the merchant's wallet. We verify the payment by querying the
// merchant's wallet for transactions that include a unique reference key
// we generated for this specific payment intent.
//
// The flow:
//   1. /api/payment-intent → generates a fresh reference Pubkey, stores
//      the intent in Redis (TTL 30min), returns the Solana Pay URL.
//   2. Pricing page renders the URL as a QR code + Phantom deep-link button.
//      User signs the tx in their wallet — the wallet adds the reference
//      key as a read-only account in the tx so on-chain searches by
//      reference return exactly the right tx.
//   3. /api/cron-check-payments runs every minute, calls Helius RPC's
//      getSignaturesForAddress(reference) for each pending intent. Match
//      the tx, verify recipient + amount + token, then setUserTier.
//   4. /api/payment-status polls intent state for the page UI.
//
// Configure at deploy time:
//   SOLANA_RECIPIENT_WALLET   — base58 address that receives payments
//   HELIUS_API_KEY            — already used elsewhere, reused for tx queries
//   SOLANA_PRICE_PRO_USDC     — defaults to 14.99
//   SOLANA_PRICE_LIFETIME_USDC — defaults to 99
//
// Until SOLANA_RECIPIENT_WALLET is set, /api/payment-intent returns 503
// "checkout_not_configured" and the pricing page shows "Coming soon".

import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

// ─── Constants ────────────────────────────────────────────────────────────────

/** USDC mainnet mint on Solana — stable, 6 decimals. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const PRO_PASS_DAYS = 30;
export const INTENT_TTL_SECONDS = 30 * 60; // 30 minutes for the user to pay
export const INTENT_KEY = (reference: string) => `payment-intent:${reference}`;
export const INTENT_INDEX_KEY = "payment-intents:pending";

// ─── Types ────────────────────────────────────────────────────────────────────

// Payment-intent tiers. "yearly" replaces "lifetime" as of 2026-05 (the
// founder's call: a 1-year subscription is the right product, not a
// forever pass). "lifetime" is removed from the union so we can't
// accidentally mint a new lifetime intent — grandfathered customers
// still have user tier = "lifetime" (handled in api/_lib/user.ts) but
// the payment system never issues new lifetime artefacts.
export type Tier = "monthly" | "yearly";
export type PayToken = "usdc" | "sol";
export type IntentStatus = "pending" | "confirmed" | "expired";

export interface PaymentIntent {
  reference: string;
  /**
   * Identifier of the extension install, if the user came from the
   * extension's quota link. Optional — direct site visitors who pay
   * before installing won't have one. The license-key flow covers
   * that case: at redemption time the install_id is bound to the
   * license, not at intent time.
   */
  installId: string;
  /**
   * Email of the buyer, lowercased + trimmed. Required for direct
   * site visitors (so we can issue them a license to redeem later)
   * and optional for extension-driven payments (we still record it
   * if provided so the same install_id can fetch its receipts via
   * /account.html).
   */
  email?: string;
  tier: Tier;
  /** Which token the user is paying with — "usdc" (stable) or "sol" (native). */
  token: PayToken;
  recipient: string;
  /**
   * Decimal amount in the chosen token's natural units (NOT raw lamports
   * or token-account units). For USDC this is dollars; for SOL it's the
   * SOL float value computed from the current Jupiter rate at intent
   * creation time and locked in until the intent expires.
   */
  amount: number;
  /** USD-equivalent at intent creation — useful for analytics + audit. */
  amountUsd: number;
  /**
   * SPL token mint address; null when paying in native SOL. Verifier
   * branches on this to pick the right balance check.
   */
  splTokenMint: string | null;
  /** The full Solana Pay URL the wallet opens. */
  payUrl: string;
  createdAt: number;
  expiresAt: number;
  status: IntentStatus;
  txSignature?: string;
  confirmedAt?: number;
}

// ─── Base58 encoder ───────────────────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Encode bytes as base58 (Bitcoin/Solana flavour). Avoids pulling in a
 * dependency for ~30 lines of code we'd own anyway. Handles the
 * leading-zero edge case so `0x00...` round-trips correctly.
 */
export function base58encode(bytes: Uint8Array | Buffer): string {
  if (bytes.length === 0) return "";
  let num = BigInt(0);
  for (const b of bytes) num = num * BigInt(256) + BigInt(b);
  let result = "";
  while (num > BigInt(0)) {
    const rem = num % BigInt(58);
    num = num / BigInt(58);
    result = BASE58_ALPHABET[Number(rem)] + result;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    result = "1" + result;
  }
  return result;
}

/**
 * Solana addresses are 32-byte base58 strings. We're not strict about
 * on-curve-ness here — Solana Pay reference accounts don't need to be on
 * the curve, only valid-shaped Pubkeys. Loose validation is enough to
 * keep arbitrary user input out of the URL we hand back.
 */
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(address: string): boolean {
  return typeof address === "string" && SOLANA_PUBKEY_RE.test(address);
}

// ─── Reference key generation ─────────────────────────────────────────────────

/**
 * Generate a fresh per-payment reference Pubkey. Solana Pay uses this as
 * an extra account in the transaction so the merchant can later query
 * for that exact tx without scanning every transfer to its wallet.
 *
 * Cryptographically random — collision probability is 2^-128 even at
 * billions of intents, comfortably safe.
 */
export function generateReferenceKey(): string {
  return base58encode(randomBytes(32));
}

// ─── Solana Pay URL building ─────────────────────────────────────────────────

export interface BuildPayUrlParams {
  recipient: string;
  amount: number;
  splTokenMint?: string | null;
  reference: string;
  label?: string;
  message?: string;
  memo?: string;
}

/**
 * Build a Solana Pay URL per the spec
 * (https://solanapay.com/spec). Wallets recognise this URI scheme and
 * open a sign-tx prompt with the right amount + recipient prefilled.
 *
 * Format:
 *   solana:<recipient>?amount=N&spl-token=MINT&reference=KEY&label=...&message=...&memo=...
 *
 * Omitting `spl-token` produces a native SOL transfer URL.
 */
export function buildPayUrl(params: BuildPayUrlParams): string {
  const search = new URLSearchParams();
  search.set("amount", params.amount.toString());
  if (params.splTokenMint) search.set("spl-token", params.splTokenMint);
  search.set("reference", params.reference);
  if (params.label) search.set("label", params.label);
  if (params.message) search.set("message", params.message);
  if (params.memo) search.set("memo", params.memo);
  return `solana:${params.recipient}?${search.toString()}`;
}

// ─── Pricing helpers ─────────────────────────────────────────────────────────

/** USD price of the tier — the canonical reference, env-overridable. */
export function priceUsd(tier: Tier): number {
  if (tier === "yearly") {
    // The yearly subscription replaces the old "lifetime" SKU. Same
    // env knob name kept for back-compat (existing Vercel env vars
    // don't need rotation), with a yearly-named alias preferred when
    // both are set. Default falls back to the legacy lifetime price
    // until the founder sets the new yearly price explicitly.
    const yearly = parseFloat(process.env.SOLANA_PRICE_YEARLY_USDC ?? "");
    if (Number.isFinite(yearly) && yearly > 0) return yearly;
    const legacy = parseFloat(process.env.SOLANA_PRICE_LIFETIME_USDC ?? "149.99");
    return Number.isFinite(legacy) && legacy > 0 ? legacy : 149.99;
  }
  const v = parseFloat(process.env.SOLANA_PRICE_PRO_USDC ?? "24.99");
  return Number.isFinite(v) && v > 0 ? v : 24.99;
}

/** Back-compat alias — many tests call priceFor(tier) expecting USD. */
export function priceFor(tier: Tier): number {
  return priceUsd(tier);
}

// Mainnet wrapped-SOL mint — used by Jupiter's price API as the SOL
// identifier (their v3 lite-api keys by mint address, not symbol).
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Fetch the current SOL/USD price. Used to lock the SOL amount at
 * intent creation so the user can't pay 24h later at a stale rate.
 *
 * Source priority (first to return a positive number wins):
 *   1. Jupiter lite-api v3 (free, no auth, very fast, AMM-derived)
 *   2. CoinGecko simple/price (free, no auth, ~30s cache, exchange-derived)
 *
 * The previous implementation hit `https://price.jup.ag/v4/price` which
 * Jupiter deprecated in late 2024 — the endpoint now returns empty. We
 * keep two independent sources so a single provider outage doesn't
 * brick SOL payments.
 *
 * Returns 0 on combined failure — the caller surfaces a clear "rate
 * fetch failed" error rather than silently locking the user into an
 * under/over-paid amount.
 */
export async function getSolPriceUsd(): Promise<number> {
  // Primary: Jupiter lite-api v3 (replaces the dead price.jup.ag v4)
  try {
    const res = await fetch(
      `https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const json = (await res.json()) as Record<
        string,
        { usdPrice?: number } | undefined
      >;
      const price = json[WSOL_MINT]?.usdPrice;
      if (typeof price === "number" && price > 0) return price;
    }
  } catch (err) {
    logger.warn("solana-pay", "Jupiter v3 price fetch failed", {
      error: String(err),
    });
  }

  // Fallback: CoinGecko simple/price. Free, no auth, but rate-limited
  // (~30 calls/min) — fine because we only hit it when Jupiter is down.
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const json = (await res.json()) as { solana?: { usd?: number } };
      const price = json.solana?.usd;
      if (typeof price === "number" && price > 0) return price;
    }
  } catch (err) {
    logger.warn("solana-pay", "CoinGecko fallback fetch failed", {
      error: String(err),
    });
  }

  logger.error("solana-pay", "all SOL price sources failed");
  return 0;
}

/**
 * Resolve the tier+token pair into an actual on-chain payment amount.
 *
 *   USDC → 1:1 with USD, fixed via env override.
 *   SOL  → USD price ÷ current SOL/USD rate, rounded to 4 decimals
 *          (sufficient precision for amounts in the 0.05–1 SOL range).
 *
 * Throws when the SOL rate fetch fails — better to refuse intent creation
 * than to lock a user into an under/over-paid amount.
 */
export async function resolveAmount(
  tier: Tier,
  token: PayToken,
): Promise<{ amount: number; amountUsd: number; splTokenMint: string | null }> {
  const usd = priceUsd(tier);
  if (token === "usdc") {
    return { amount: usd, amountUsd: usd, splTokenMint: USDC_MINT };
  }
  // SOL
  const solPrice = await getSolPriceUsd();
  if (solPrice <= 0) {
    throw new Error("Could not resolve SOL/USD rate");
  }
  // Round up to 4 decimals — under-paying by sub-cent rounding would fail
  // the verifier's 1% tolerance check on small amounts. Better to ask
  // 0.0001 SOL more than to silently fail at confirmation.
  const solAmount = Math.ceil((usd / solPrice) * 1e4) / 1e4;
  return { amount: solAmount, amountUsd: usd, splTokenMint: null };
}

// ─── Intent CRUD ─────────────────────────────────────────────────────────────

/**
 * Create and persist a new payment intent. The reference key is fresh per
 * call — never reused across users or tiers, so cross-user linkability via
 * on-chain probing is impossible.
 *
 * The intent is added to a Redis SET (`payment-intents:pending`) so the
 * cron job can iterate the pending bucket without a SCAN over every key
 * in the namespace.
 */
export async function createPaymentIntent(
  redis: Redis,
  params: {
    installId: string;
    /**
     * Pre-normalized buyer email (lowercased + trimmed). Required for
     * site-direct purchases so we can issue a license they can redeem
     * later; optional for extension-driven flow but we still record it
     * if provided so the buyer can pull receipts at /account.html.
     */
    email?: string;
    tier: Tier;
    token: PayToken;
    recipient: string;
  },
): Promise<PaymentIntent> {
  const reference = generateReferenceKey();
  const { amount, amountUsd, splTokenMint } = await resolveAmount(
    params.tier,
    params.token,
  );
  const now = Date.now();
  const expiresAt = now + INTENT_TTL_SECONDS * 1000;

  const intent: PaymentIntent = {
    reference,
    installId: params.installId,
    ...(params.email ? { email: params.email } : {}),
    tier: params.tier,
    token: params.token,
    recipient: params.recipient,
    amount,
    amountUsd,
    splTokenMint,
    payUrl: buildPayUrl({
      recipient: params.recipient,
      amount,
      splTokenMint,
      reference,
      label: "Antares",
      message:
        params.tier === "yearly"
          ? "Antares Yearly — Pro features for 1 year"
          : "Antares Pro — 30-day pass",
    }),
    createdAt: now,
    expiresAt,
    status: "pending",
  };

  // Store the intent itself (TTL = expiry + 1h grace so we can read
  // expired intents to surface the right status to the polling client).
  await redis.set(INTENT_KEY(reference), intent, {
    ex: INTENT_TTL_SECONDS + 60 * 60,
  });
  // Add to the pending index so the cron iterates only what's relevant
  await redis.sadd(INTENT_INDEX_KEY, reference);

  return intent;
}

export async function getPaymentIntent(
  redis: Redis,
  reference: string,
): Promise<PaymentIntent | null> {
  try {
    const raw = await redis.get<PaymentIntent>(INTENT_KEY(reference));
    return raw ?? null;
  } catch (err) {
    logger.warn("solana-pay", "intent get failed", { error: String(err) });
    return null;
  }
}

export async function listPendingIntentReferences(
  redis: Redis,
): Promise<string[]> {
  try {
    const refs = await redis.smembers(INTENT_INDEX_KEY);
    return refs ?? [];
  } catch (err) {
    logger.warn("solana-pay", "pending list failed", { error: String(err) });
    return [];
  }
}

export async function markIntentConfirmed(
  redis: Redis,
  intent: PaymentIntent,
  txSignature: string,
): Promise<void> {
  const updated: PaymentIntent = {
    ...intent,
    status: "confirmed",
    txSignature,
    confirmedAt: Date.now(),
  };
  await redis.set(INTENT_KEY(intent.reference), updated, {
    ex: INTENT_TTL_SECONDS + 24 * 60 * 60, // keep confirmed intents 24h for audit
  });
  await redis.srem(INTENT_INDEX_KEY, intent.reference);
}

export async function markIntentExpired(
  redis: Redis,
  intent: PaymentIntent,
): Promise<void> {
  const updated: PaymentIntent = { ...intent, status: "expired" };
  await redis.set(INTENT_KEY(intent.reference), updated, {
    ex: 60 * 60, // keep expired intents 1h for status polling
  });
  await redis.srem(INTENT_INDEX_KEY, intent.reference);
}

// ─── On-chain verification via Helius RPC ────────────────────────────────────

interface SignatureInfo {
  signature: string;
  slot?: number;
  blockTime?: number | null;
  err?: unknown;
}

interface HeliusRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

const HELIUS_RPC_URL = (apiKey: string) =>
  `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

/**
 * Query Solana for transactions involving the given reference key.
 * Solana Pay-compliant wallets attach the reference as a read-only account
 * to the transfer instruction, making this lookup O(1) per intent.
 */
async function getSignaturesForReference(
  reference: string,
  apiKey: string,
): Promise<SignatureInfo[]> {
  const res = await fetch(HELIUS_RPC_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [reference, { limit: 5 }],
    }),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as HeliusRpcResponse<SignatureInfo[]>;
  return json.result ?? [];
}

interface ParsedAccountKey {
  pubkey?: string;
  signer?: boolean;
  writable?: boolean;
}

interface ParsedTransaction {
  meta?: {
    err?: unknown;
    /** Native SOL balances (lamports) per account in tx, indexed by accountKeys order. */
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{
      mint?: string;
      owner?: string;
      uiTokenAmount?: { uiAmount?: number | null; amount?: string };
    }>;
    postTokenBalances?: Array<{
      mint?: string;
      owner?: string;
      uiTokenAmount?: { uiAmount?: number | null; amount?: string };
    }>;
  };
  transaction?: {
    message?: {
      accountKeys?: Array<string | ParsedAccountKey>;
    };
  };
}

/** Solana lamport-to-SOL constant. 1 SOL = 1_000_000_000 lamports. */
const LAMPORTS_PER_SOL = 1_000_000_000;

async function getTransactionDetails(
  signature: string,
  apiKey: string,
): Promise<ParsedTransaction | null> {
  const res = await fetch(HELIUS_RPC_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as HeliusRpcResponse<ParsedTransaction>;
  return json.result ?? null;
}

/**
 * Verify on-chain that an SPL token transfer satisfying the intent's
 * recipient + token + amount actually occurred. Compares pre/post token
 * balances on the recipient's account so partial transfers and unrelated
 * txs that happened to include the reference key cannot be mistaken for
 * a payment.
 */
export function verifyTokenTransfer(
  tx: ParsedTransaction,
  expected: { recipient: string; mint: string; minAmount: number },
): boolean {
  if (!tx.meta || tx.meta.err) return false;
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  // Find the post balance entry for our recipient + mint
  const postEntry = post.find(
    (b) => b.owner === expected.recipient && b.mint === expected.mint,
  );
  if (!postEntry) return false;
  const postAmount = postEntry.uiTokenAmount?.uiAmount ?? 0;

  // Pre balance might not exist if the recipient just opened the ATA
  const preEntry = pre.find(
    (b) => b.owner === expected.recipient && b.mint === expected.mint,
  );
  const preAmount = preEntry?.uiTokenAmount?.uiAmount ?? 0;

  const delta = postAmount - preAmount;
  // 1% tolerance for rounding — Solana Pay decimal handling can shave
  // a sub-cent in the wallet → on-chain conversion.
  return delta >= expected.minAmount * 0.99;
}

/**
 * Verify on-chain that a native SOL transfer to the merchant wallet
 * satisfies the intent's amount. Reads pre/post lamport balances on the
 * recipient's account index in the tx — no SPL token machinery needed.
 *
 * Same 1% tolerance as the SPL verifier so a wallet sub-cent rounding
 * difference doesn't reject an otherwise-valid payment.
 */
export function verifySolTransfer(
  tx: ParsedTransaction,
  expected: { recipient: string; minAmount: number },
): boolean {
  if (!tx.meta || tx.meta.err) return false;
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const recipientIndex = accountKeys.findIndex((k) =>
    typeof k === "string" ? k === expected.recipient : k?.pubkey === expected.recipient,
  );
  if (recipientIndex < 0) return false;

  const preBalances = tx.meta.preBalances ?? [];
  const postBalances = tx.meta.postBalances ?? [];
  const preLamports = preBalances[recipientIndex];
  const postLamports = postBalances[recipientIndex];
  if (typeof preLamports !== "number" || typeof postLamports !== "number") return false;

  const deltaSol = (postLamports - preLamports) / LAMPORTS_PER_SOL;
  return deltaSol >= expected.minAmount * 0.99;
}

/**
 * Check on-chain whether a payment intent has been settled. Returns the
 * confirming tx signature when found, otherwise null.
 *
 * Dispatches on `splTokenMint`: when present we look for an SPL transfer,
 * otherwise we look for a native SOL transfer. Same on-chain query path
 * for both — only the verification step differs.
 */
export async function checkIntentOnChain(
  intent: PaymentIntent,
  heliusApiKey: string,
): Promise<{ confirmed: true; txSignature: string } | { confirmed: false }> {
  const sigs = await getSignaturesForReference(intent.reference, heliusApiKey);
  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    const tx = await getTransactionDetails(sigInfo.signature, heliusApiKey);
    if (!tx) continue;
    const ok = intent.splTokenMint
      ? verifyTokenTransfer(tx, {
          recipient: intent.recipient,
          mint: intent.splTokenMint,
          minAmount: intent.amount,
        })
      : verifySolTransfer(tx, {
          recipient: intent.recipient,
          minAmount: intent.amount,
        });
    if (ok) return { confirmed: true, txSignature: sigInfo.signature };
  }
  return { confirmed: false };
}
