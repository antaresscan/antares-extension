// api/_lib/license.ts — License-key issuance and redemption.
//
// Plugs the gap between "user pays on the website" and "extension on
// some random machine flips to Pro". Without this module the only way
// to upgrade is to come from the extension's quota link with the
// install_id baked into the URL — which excludes every direct site
// visitor who hasn't installed yet.
//
// Flow:
//   1. /api/payment-intent accepts an `email` field. The intent stores
//      it alongside the install_id (or in place of it for site-only
//      visitors).
//   2. /api/cron-check-payments confirms the on-chain payment, then
//      calls `issueLicense()` here. The license is keyed by intent
//      reference so a second cron tick on the same intent is a no-op.
//   3. /api/payment-status returns the license_key in its response so
//      the pricing modal can show it to the buyer immediately.
//   4. /api/redeem accepts {license_key, install_id}. It atomically
//      marks the license redeemed and calls setUserTier on the
//      install_id. A license can only be redeemed once.
//   5. /api/account-licenses lets a user re-fetch their licenses by
//      proving ownership: email + at least one valid key for that
//      email. No passwords, no sessions — the key IS the credential.
//
// Redis layout:
//   license:<KEY>           HASH  → all License fields
//   email:licenses:<email>  SET   → license keys owned by that email
//   intent:license:<ref>    STRING → license key issued for this intent
//                                    (idempotency guard for cron retries)

import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";
import { setUserTier, type Tier as UserTier } from "./user";
import { PRO_PASS_DAYS, type Tier as IntentTier } from "./solana-pay";
import { logger } from "./logger";

// Inlined here (instead of imported from ./account) to avoid the
// circular dep account.ts → license.ts → account.ts. Must stay in
// sync with the canonical definition in api/_lib/account.ts.
const ACCOUNT_INSTALL_KEY = (installId: string) =>
  `account:install:${installId}`;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Tier carried by a license. Mirrors the user-tier vocabulary in
 * api/_lib/user.ts.
 *
 *   "pro"      → 30-day pass (mapped from intent tier "monthly")
 *   "yearly"   → 1-year subscription (replaces "lifetime" as of 2026-05)
 *   "lifetime" → grandfathered: kept readable so old licenses still
 *                redeem correctly, but new licences are never minted
 *                with this tier.
 */
export type LicenseTier = "pro" | "yearly" | "lifetime";

export interface License {
  /** ANT-XXXX-XXXX-XXXX-XXXX, base32-ish, 19 chars including dashes. */
  key: string;
  email: string;
  tier: LicenseTier;
  /** Reference of the payment-intent that paid for this license. */
  intentReference: string;
  amountUsd: number;
  createdAt: number;
  redeemed: boolean;
  redeemedBy?: string;
  redeemedAt?: number;
  /**
   * Epoch-ms when the *license itself* expires (for Pro 30-day passes).
   * Once redeemed, this is also passed through to setUserTier so the
   * install gets auto-downgraded after 30d. Lifetime → undefined.
   */
  expiresAt?: number;
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

export const LICENSE_KEY = (key: string) => `license:${key}`;
export const EMAIL_LICENSES_KEY = (email: string) =>
  `email:licenses:${email.toLowerCase().trim()}`;
export const INTENT_LICENSE_KEY = (reference: string) =>
  `intent:license:${reference}`;

// ─── Key generation ───────────────────────────────────────────────────────────

/**
 * Crockford-base32 alphabet (no I, L, O, U — visually unambiguous).
 * 32 chars × 16 = 80 bits of entropy, which is way more than enough
 * to make brute-forcing infeasible (HTTP rate limit + 80-bit search
 * space = effectively impossible).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateLicenseKey(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i] % 32];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return `ANT-${out}`;
}

const KEY_RE = /^ANT-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/;

export function isValidLicenseKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

// ─── Email validation ─────────────────────────────────────────────────────────

// Conservative regex — local + @ + domain with a TLD. Good enough to
// reject malformed input; real validation happens at delivery time
// (which is post-MVP). We lowercase and trim before comparison.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed.length > 254) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

// ─── Tier translation ─────────────────────────────────────────────────────────

/**
 * Intent vocabulary uses "monthly" / "yearly"; license vocabulary uses
 * "pro" / "yearly" (yearly is the same word in both). Translation
 * happens once at issue time so callers don't need to know. The legacy
 * "lifetime" intent value is mapped to "yearly" too, to handle in-flight
 * intents created on stale clients during the 2026-05 rename rollout.
 */
export function intentTierToLicenseTier(tier: IntentTier): LicenseTier {
  // Cast: IntentTier is currently "monthly" | "yearly" but stale clients
  // may still POST tier="lifetime"; the runtime check below is what
  // actually runs. TypeScript guards us against new IntentTier values.
  if ((tier as string) === "yearly" || (tier as string) === "lifetime") {
    return "yearly";
  }
  return "pro";
}

// ─── Issue ────────────────────────────────────────────────────────────────────

export interface IssueParams {
  email: string;
  tier: IntentTier;
  intentReference: string;
  amountUsd: number;
  /** Default Date.now(); injectable for tests. */
  now?: number;
}

/**
 * Idempotently issue a license for a confirmed payment intent. Returns
 * the license. Safe to call repeatedly on the same intent reference —
 * subsequent calls return the originally-issued key.
 */
export async function issueLicense(
  redis: Redis,
  params: IssueParams,
): Promise<License> {
  const email = normalizeEmail(params.email);
  if (!email) {
    throw new Error("issueLicense: invalid email");
  }
  const now = params.now ?? Date.now();
  const tier = intentTierToLicenseTier(params.tier);

  // Idempotency: if this intent already issued a license, return it.
  const existingKey = await redis.get<string>(
    INTENT_LICENSE_KEY(params.intentReference),
  );
  if (existingKey) {
    const existing = await getLicense(redis, existingKey);
    if (existing) return existing;
    // Index points at a non-existent license — Redis got out of sync.
    // Fall through and issue a fresh key.
    logger.warn("license", "intent index points at missing license", {
      intent: params.intentReference,
      key: existingKey,
    });
  }

  // License-level expiry. The license carries its own clock so when
  // it's eventually redeemed the install gets the correct downgrade
  // moment, even if the user redeems weeks after purchase.
  //
  //   "pro"      → 30 days
  //   "yearly"   → 365 days
  //   "lifetime" → undefined (grandfathered legacy licences only;
  //                new licences never reach this branch)
  const YEARLY_DAYS = 365;
  const expiresAt =
    tier === "pro"
      ? now + PRO_PASS_DAYS * 24 * 60 * 60 * 1000
      : tier === "yearly"
        ? now + YEARLY_DAYS * 24 * 60 * 60 * 1000
        : undefined;

  const license: License = {
    key: generateLicenseKey(),
    email,
    tier,
    intentReference: params.intentReference,
    amountUsd: params.amountUsd,
    createdAt: now,
    redeemed: false,
    expiresAt,
  };

  // We use HSET to store all the fields under a single key so reads
  // are one round-trip. Boolean and number fields go through
  // String(...) for the wire format; readers in getLicense undo it.
  const fields: Record<string, string> = {
    key: license.key,
    email: license.email,
    tier: license.tier,
    intentReference: license.intentReference,
    amountUsd: String(license.amountUsd),
    createdAt: String(license.createdAt),
    redeemed: "0",
  };
  if (license.expiresAt !== undefined) {
    fields.expiresAt = String(license.expiresAt);
  }

  await redis.hset(LICENSE_KEY(license.key), fields);
  await redis.sadd(EMAIL_LICENSES_KEY(email), license.key);
  await redis.set(INTENT_LICENSE_KEY(params.intentReference), license.key);

  logger.info("license", "issued", {
    key: license.key,
    email,
    tier,
    intent: params.intentReference,
  });

  return license;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getLicense(
  redis: Redis,
  key: string,
): Promise<License | null> {
  if (!isValidLicenseKey(key)) return null;
  const raw = await redis.hgetall<Record<string, string>>(LICENSE_KEY(key));
  if (!raw || !raw.key) return null;
  return parseLicense(raw);
}

export async function getLicensesByEmail(
  redis: Redis,
  email: string,
): Promise<License[]> {
  const norm = normalizeEmail(email);
  if (!norm) return [];
  const keys = await redis.smembers(EMAIL_LICENSES_KEY(norm));
  if (!keys || keys.length === 0) return [];
  // Pull each license individually. The set is bounded by the number
  // of purchases per email — single-digit in practice — so an N+1 here
  // is fine and avoids needing to script-side a multi-key fetch.
  const licenses: License[] = [];
  for (const k of keys) {
    const lic = await getLicense(redis, k);
    if (lic) licenses.push(lic);
  }
  // Newest first
  licenses.sort((a, b) => b.createdAt - a.createdAt);
  return licenses;
}

function parseLicense(raw: Record<string, string>): License {
  const expiresAt =
    raw.expiresAt && raw.expiresAt !== "0" ? Number(raw.expiresAt) : undefined;
  // Honour all three persisted tier values. "lifetime" is grandfathered
  // for legacy licences that haven't been redeemed yet.
  const tier: LicenseTier =
    raw.tier === "lifetime"
      ? "lifetime"
      : raw.tier === "yearly"
        ? "yearly"
        : "pro";
  return {
    key: raw.key,
    email: raw.email,
    tier,
    intentReference: raw.intentReference,
    amountUsd: Number(raw.amountUsd) || 0,
    createdAt: Number(raw.createdAt) || 0,
    redeemed: raw.redeemed === "1",
    redeemedBy: raw.redeemedBy || undefined,
    redeemedAt: raw.redeemedAt ? Number(raw.redeemedAt) : undefined,
    expiresAt,
  };
}

// ─── Redeem ───────────────────────────────────────────────────────────────────

export type RedeemOutcome =
  | { ok: true; license: License }
  | { ok: false; reason: "not_found" | "already_redeemed" | "invalid_format" };

/**
 * Mark a license as redeemed against a specific install_id and flip
 * that install_id's tier accordingly. Idempotent in the success case
 * for the *same* install_id (re-running just returns the already-flipped
 * license); idempotent-fail for a different install_id (returns
 * `already_redeemed`).
 */
export async function redeemLicense(
  redis: Redis,
  rawKey: string,
  installId: string,
  now: number = Date.now(),
): Promise<RedeemOutcome> {
  if (!isValidLicenseKey(rawKey)) {
    return { ok: false, reason: "invalid_format" };
  }

  const existing = await getLicense(redis, rawKey);
  if (!existing) return { ok: false, reason: "not_found" };

  if (existing.redeemed) {
    if (existing.redeemedBy === installId) {
      // Same install reclaiming its own license — idempotent success.
      // Re-flip the tier in case Redis lost it (e.g. manual flush).
      await applyTier(redis, installId, existing);
      return { ok: true, license: existing };
    }
    return { ok: false, reason: "already_redeemed" };
  }

  // Mark redeemed first, then flip the tier. If the tier-flip fails
  // we don't want to lose the redemption record (the user paid;
  // operational support can re-flip manually). Order matters.
  const updated: License = {
    ...existing,
    redeemed: true,
    redeemedBy: installId,
    redeemedAt: now,
  };
  await redis.hset(LICENSE_KEY(existing.key), {
    redeemed: "1",
    redeemedBy: installId,
    redeemedAt: String(now),
  });
  await applyTier(redis, installId, updated);

  logger.info("license", "redeemed", {
    key: existing.key,
    install: installId,
    tier: existing.tier,
  });

  return { ok: true, license: updated };
}

async function applyTier(
  redis: Redis,
  installId: string,
  license: License,
): Promise<void> {
  // 1:1 mapping — license tier vocabulary == user tier vocabulary.
  // license.expiresAt carries the right per-tier clock (30d Pro, 365d
  // Yearly, undefined Lifetime), so setUserTier just forwards it.
  const userTier: UserTier =
    license.tier === "lifetime"
      ? "lifetime"
      : license.tier === "yearly"
        ? "yearly"
        : "pro";
  await setUserTier(installId, userTier, license.expiresAt);

  // Bind the install to the buyer's email so the API's session-gated
  // tier resolution (`resolveTierAndBypass` in api/_lib/user.ts) can
  // map "the user signed in as X" → "X owns this install" → "return
  // the tier stored on this install". Without this write the user
  // sees Free in the overlay even after a successful redeem because
  // the install→email binding doesn't exist.
  //
  // This is the missing piece the founder hit repeatedly: clicking
  // LINK TO MY EXTENSION on /account.html flipped tier on the install
  // but never wrote the binding, so signed-in scan calls resolved
  // anonymous → Free. Writing the binding here closes the loop in the
  // redemption path so any user (Solana payer with email, license-
  // redeemer, dev grantee) gets their tier the moment they redeem.
  //
  // Idempotent: we always write the same email regardless of any
  // existing value. License redemption is the canonical "this email
  // owns this install" event; later sync-token auto-binds defer to
  // it (sync-token only writes when no binding exists).
  try {
    await redis.set(ACCOUNT_INSTALL_KEY(installId), license.email);
  } catch (err) {
    // Don't fail the redeem on a binding-write hiccup — the user paid,
    // tier is already flipped, the binding can be re-created later by
    // sync-token's auto-bind path. Log so the operator can see if this
    // happens at scale.
    logger.warn("license", "applyTier binding-write failed", {
      installId,
      email: license.email,
      error: String(err),
    });
  }
}
