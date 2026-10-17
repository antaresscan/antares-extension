// api/_lib/user.ts — Per-user primitives backed by Upstash Redis.
//
// Identity: install_id (extension-generated UUID-style token). Pro v1 uses
// install_id alone; magic-link email auth in v2 will let users migrate their
// state across reinstalls by attaching email to install_id.
//
// Storage shape:
//   user:{id}:tier        STRING   "pro" | "yearly" | "lifetime" (absent = free)
//   user:{id}:tierExpires STRING   epoch-ms when tier downgrades to free (absent = no end)
//   The two keys are always written together, in one transaction (setUserTier).
//   user:{id}:history     LIST     LPUSH JSON entries, LTRIM 0 999
import { Redis } from "@upstash/redis";
import { logger } from "./logger";
import { emailRef } from "./log-ref";
// Static imports for the auth + tier helpers we use inside resolveTier.
// Previously these were `await import("./session-cookie")` and `await
// import("./account")`. The dynamic-import path was added to dodge the
// known circular dep (user → session-cookie → account → license → user)
// but it backfired: Vercel's serverless bundler doesn't resolve
// dynamic relative imports the same way Node ESM does, and threw
// `Cannot find module './session-cookie'` on every /api/scan call —
// every authenticated request silently fell through to "Free" before
// any auth code even ran. Static imports work because JS handles the
// circular gracefully (license.ts only needs setUserTier at call time,
// not at module init).
import { getAccountFromRequest } from "./session-cookie";
import { isEmailProven } from "./email-proof";
import { isDevLifetimeEmail, isDevProEmail } from "./account";
import { getLicensesByEmail } from "./license";
import { decideTier, parseDevTier, type Tier, type TierDecision, type TierFacts } from "./entitlements";

// ─── Constants ────────────────────────────────────────────────────────────────

export const HISTORY_HARD_CAP = 1000;
export const HISTORY_DAY_WINDOW = 30; // expose last 30 days on GET /api/history
// Defined in keys.ts; still exported from here for the modules and tests that import them from this file.
import { ACCOUNT_INSTALL_KEY, TIER_KEY, TIER_EXPIRES_KEY, HISTORY_KEY } from "./keys";
export { TIER_KEY, TIER_EXPIRES_KEY, HISTORY_KEY };

// ─── Types ────────────────────────────────────────────────────────────────────

// "yearly" replaces "lifetime" for new purchases as of 2026-05. We keep
// "lifetime" in the type for grandfathered customers who paid before
// the rename — their stored tier is still honoured forever and the UI
// displays them as Lifetime. New checkout flows mint "yearly" only.
export type { Tier };

export interface ScanHistoryEntry {
  ca: string;
  score: number;
  verdict: string;
  scannedAt: number; // epoch ms
  symbol?: string;
  name?: string;
}

// ─── Module wiring ────────────────────────────────────────────────────────────

let redis: Redis | null = null;
let redisConfigured = false;

export function initUserStorage(redisInstance: Redis): void {
  redis = redisInstance;
  redisConfigured = true;
}

/** Reset state — only for tests. */
export function _resetUserStorageForTests(): void {
  redis = null;
  redisConfigured = false;
}

function isAvailable(): boolean {
  return redisConfigured && redis !== null;
}

// ─── Dev-mode tier override ───────────────────────────────────────────────────

/**
 * Comma-separated list of install_ids the dev wants to force into a
 * paid tier without going through the payment flow. Used so the dev
 * can keep running their own extension on a paid tier during day-to-day
 * work — and so QA installs don't need real on-chain payments to test
 * paid surfaces.
 *
 * `DEV_PRO_INSTALLS=install-aaaaaaaaaaa,install-bbbbbbbbbbb`
 *   → both ids get the tier the X-Antares-Dev-Tier header names, Yearly
 *     otherwise (row 1 of the table in entitlements.ts).
 *
 * Not meant for production grants: the env var is the audit trail.
 * Real customers go through /api/redeem like everyone else.
 */
function getDevProInstalls(): Set<string> {
  const raw = process.env.DEV_PRO_INSTALLS ?? "";
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isDevProInstall(installId: string): boolean {
  if (!installId) return false;
  return getDevProInstalls().has(installId);
}

// (getEffectiveTier and isDevAllowlistedInstall were removed in the audit of 2026-10-17. Nothing called them, and they were a tier read
// WITHOUT the session: any install bound to a dev e-mail could name its tier in X-Antares-Dev-Tier. A binding is also written by a
// payment, from the e-mail the buyer typed, which nobody has confirmed (audit A-01): paying once with a founder's address would have
// been enough. The one way to read a caller's tier is resolveTier, which applies the whole table of entitlements.ts.)

export interface TierResolution {
  tier: Tier;
  /** Epoch ms when a time-limited tier (pro, yearly) lapses; null for free, lifetime and dev grants. /api/quota hands it to the Options page ("expires on ..."). */
  tierExpiresAt: number | null;
}

/**
 * The tier of the caller, and when a time-limited tier lapses. One session lookup, two answers.
 *
 * Returns:
 *   - `tier`: the same value `getEffectiveTierFromRequest` would return
 *   - `tierExpiresAt`: epoch ms when a pro / yearly tier lapses, null otherwise
 *
 * Which row of the table in entitlements.ts decided it is logged here (logTierDecision).
 */
export async function resolveTier(
  req: { headers: { cookie?: string | string[]; "x-antares-dev-tier"?: string | string[] } },
  installId: string,
): Promise<TierResolution> {
  const cookieRaw = (req as { headers: { cookie?: string | string[] } }).headers.cookie;
  const headerRaw = (req as { headers: { "x-antares-session"?: string | string[] } }).headers["x-antares-session"];
  const authSource = headerRaw
    ? "header"
    : (typeof cookieRaw === "string" && cookieRaw.includes("antares_session="))
      ? "cookie"
      : "none";

  // The facts the decision reads (see entitlements.ts for the table). Each is read only when a row of the table needs it.
  let licenseExpiresAt: number | null = null;
  const facts: TierFacts = {
    devInstall: isDevProInstall(installId),
    devTier: parseDevTier(req.headers["x-antares-dev-tier"]),
    storageAvailable: isAvailable() && redis !== null,
    session: async () => {
      try {
        const account = await getAccountFromRequest(req as unknown as Parameters<typeof getAccountFromRequest>[0], redis as Redis);
        return account?.email ? { kind: "email", email: account.email, proven: isEmailProven(account) } : { kind: "none" };
      } catch (err) {
        return {
          kind: "error",
          name: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    boundEmail: async () => {
      try {
        return (await (redis as Redis).get<string>(ACCOUNT_INSTALL_KEY(installId))) ?? null;
      } catch (err) {
        logger.warn("user", "binding read failed during tier resolve", { error: String(err) });
        return null;
      }
    },
    isDevEmail: (email) => isDevLifetimeEmail(email) || isDevProEmail(email),
    licenseTier: async (email) => {
      const r = await resolveTierFromEmail(email);
      licenseExpiresAt = r.expiresAt; // the table only needs the tier; the expiry rides along for /api/quota
      return r.tier;
    },
    installTier: () => getUserTier(installId),
  };

  const decision = await decideTier(facts);
  logTierDecision(decision, installId, authSource);

  // When the paid tier lapses, for the Options page: the winning licence's end (row "license"), or the install's stored end (row
  // "install-stored"). Free, Lifetime and dev grants have none.
  let tierExpiresAt: number | null = null;
  if (decision.reason === "license") tierExpiresAt = licenseExpiresAt;
  else if (decision.reason === "install-stored" && (decision.tier === "pro" || decision.tier === "yearly")) tierExpiresAt = await readTierExpiry(installId);
  return { tier: decision.tier, tierExpiresAt };
}

/**
 * One metric per decision, with the names and fields the dashboards have always read. A dev install logs nothing. Every row of the
 * table has its case: the switch is exhaustive (a row added to entitlements.ts without its metric does not compile). The row of the
 * accounts whose e-mail is not confirmed (A-01) had none: a buyer told "I paid and I am Free" left no trace of why.
 */
function logTierDecision(d: TierDecision, installId: string, authSource: string): void {
  const reason = d.reason;
  switch (reason) {
    case "dev-install":
      return;
    case "no-storage":
      logger.metric("tier-resolve.no-redis", { installId, tier: "free" });
      return;
    case "session-error":
      logger.metric("tier-resolve.session-error", { installId, authSource, errorMessage: d.error?.message, errorName: d.error?.name });
      return;
    case "no-session":
      logger.metric("tier-resolve.no-session", { installId, authSource, tier: "free" });
      return;
    case "dev-header":
      logger.metric("tier-resolve.dev-header", { installId, authSource, sessionRef: emailRef(d.sessionEmail), tier: d.tier });
      return;
    case "license":
      logger.metric("tier-resolve.from-email", {
        installId, authSource, sessionRef: emailRef(d.sessionEmail), tier: d.tier, isDev: d.isDev, boundRef: emailRef(d.boundEmail),
      });
      return;
    case "install-bound-elsewhere":
      logger.metric("tier-resolve.hijack-block", { installId, authSource, sessionRef: emailRef(d.sessionEmail), boundRef: emailRef(d.boundEmail), tier: "free" });
      return;
    case "install-stored":
      logger.metric("tier-resolve.from-install-fallback", { installId, authSource, sessionRef: emailRef(d.sessionEmail), tier: d.tier, isDev: d.isDev });
      return;
    case "no-license-no-binding":
      logger.metric("tier-resolve.no-license-no-binding", { installId, authSource, sessionRef: emailRef(d.sessionEmail), tier: "free", isDev: d.isDev });
      return;
    case "email-unverified":
      logger.metric("tier-resolve.email-unverified", { installId, authSource, sessionRef: emailRef(d.sessionEmail), tier: "free" });
      return;
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}

/**
 * Pick the best active tier across all licenses owned by `email`, and when it lapses.
 * Priority: lifetime (no expiry) > yearly (active) > pro (active) > free.
 *
 * Active means either no expiresAt set OR expiresAt is in the future.
 * Lifetime licences never have an expiry; pro/yearly licences expire
 * after their respective windows.
 * `expiresAt` is the latest expiry among the active licenses of the winning tier (null when one of them has none, and for
 * lifetime and free): with two paid passes, the tier lasts until the later one ends.
 *
 * Same logic as /account.html resolveTier() — they walk licences and
 * pick the highest active band. Keep both copies in sync.
 */
async function resolveTierFromEmail(email: string): Promise<{ tier: Tier; expiresAt: number | null }> {
  const free = { tier: "free" as Tier, expiresAt: null };
  if (!isAvailable() || !redis) return free;
  try {
    const licenses = await getLicensesByEmail(redis, email);
    if (licenses.length === 0) return free;

    const now = Date.now();
    let hasLifetime = false;
    // Per band: is a license active, does one of them never expire, and the latest end among the others.
    const band = {
      yearly: { active: false, open: false, until: 0 },
      pro: { active: false, open: false, until: 0 },
    };
    for (const l of licenses) {
      if (l.tier === "lifetime") {
        hasLifetime = true;
      } else if (l.tier === "yearly" || l.tier === "pro") {
        if (!l.expiresAt || l.expiresAt > now) {
          const b = band[l.tier];
          b.active = true;
          if (!l.expiresAt) b.open = true;
          else b.until = Math.max(b.until, l.expiresAt);
        }
      }
    }
    if (hasLifetime) return { tier: "lifetime", expiresAt: null };
    if (band.yearly.active) return { tier: "yearly", expiresAt: band.yearly.open ? null : band.yearly.until };
    if (band.pro.active) return { tier: "pro", expiresAt: band.pro.open ? null : band.pro.until };
    return free;
  } catch (err) {
    logger.warn("user", "email tier resolve failed", { error: String(err), emailRef: emailRef(email) });
    return free;
  }
}

/** When the install's stored tier lapses (epoch ms), or null if it has no expiry or Redis cannot say. */
async function readTierExpiry(installId: string): Promise<number | null> {
  if (!isAvailable() || !redis) return null;
  try {
    const raw = await redis.get<number | string>(TIER_EXPIRES_KEY(installId));
    if (raw == null) return null;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Session-gated tier resolution. THIS is the right thing for HTTP
 * handlers (scan / quota / history / etc.) to call.
 *
 * Behaviour:
 *   - install in DEV_PRO_INSTALLS env var
 *       → "lifetime" (legacy escape hatch — headless test runs and
 *         CI smoke-tests where there's no website session don't break)
 *   - no valid session cookie
 *       → "free" (this is what makes "log out → I'm Free again" true
 *         for everyone, paying customers included; signing back in
 *         restores tier without any data being mutated)
 *   - session cookie valid AND install bound to a different email
 *       → "free" (anti-hijack: install Y was paid by email B; if email
 *         A signs in on the same browser they don't inherit B's tier)
 *   - session cookie valid AND install bound to the same email
 *       → honour X-Antares-Dev-Tier if email is dev-allowlisted, else
 *         return the stored install tier
 *   - session cookie valid AND install has no binding yet
 *       → "free" (user needs to redeem a license or re-link via
 *         /account.html before tier kicks in)
 *
 * No tier data is mutated by this function. Tier storage stays on
 * `user:<install_id>:tier` exactly as before — we just refuse to
 * surface it to the client unless the session proves they own it.
 */
export async function getEffectiveTierFromRequest(
  req: { headers: { cookie?: string | string[]; "x-antares-dev-tier"?: string | string[] } },
  installId: string,
): Promise<Tier> {
  // Thin wrapper around resolveTier so callers that don't care
  // about the dev-bypass flag stay simple. Both functions share one
  // session+binding read internally.
  const { tier } = await resolveTier(req, installId);
  return tier;
}

// ─── Tier read / write ────────────────────────────────────────────────────────

/**
 * Read the user's tier. Default Free; treats expired Pro/Lifetime as Free
 * automatically (server-side enforcement, not just client trust). Dev
 * installs listed in DEV_PRO_INSTALLS short-circuit to yearly so the
 * dev's own install is never Free by accident.
 */
export async function getUserTier(installId: string): Promise<Tier> {
  if (isDevProInstall(installId)) return "yearly";
  if (!isAvailable() || !redis) return "free";
  try {
    const tier = await redis.get<string>(TIER_KEY(installId));
    if (tier !== "pro" && tier !== "yearly" && tier !== "lifetime") return "free";

    // Honour expiry — Pro Monthly subs that lapsed should immediately
    // revert to Free without waiting for an external sweeper.
    const expiresRaw = await redis.get<number | string>(TIER_EXPIRES_KEY(installId));
    if (expiresRaw != null) {
      const expires =
        typeof expiresRaw === "number" ? expiresRaw : parseInt(String(expiresRaw), 10);
      if (Number.isFinite(expires) && expires > 0 && expires < Date.now()) {
        return "free";
      }
    }
    return tier;
  } catch (err) {
    logger.warn("user", "tier read failed", { error: String(err) });
    return "free";
  }
}

/**
 * Persist a tier change. Used by the payment confirmation (payment-confirm.ts) and the redeem of a licence (license.ts) to flip an
 * install_id between free/pro/yearly/lifetime.
 *
 * The tier and its end date are written in ONE transaction (MULTI/EXEC: one round trip, all or nothing). Written one after the other,
 * a failure between the two left a mix that reads wrong for good: a 30-day Pro without its end date is a Pro that never ends, and a
 * Lifetime redeemed on an install whose old Pro end date could not be cleared read as Free at once (getUserTier applies the old date).
 *
 * @param expiresAtMs  Optional epoch-ms when the tier should auto-revert
 *                     to free. Lifetime should be set without expiry.
 *                     Pro Monthly should set this to renewal+grace window.
 */
export async function setUserTier(
  installId: string,
  tier: Tier,
  expiresAtMs?: number,
): Promise<void> {
  if (!isAvailable() || !redis) {
    logger.warn("user", "setUserTier called without Redis — no-op");
    return;
  }
  try {
    if (tier === "free") {
      // One DEL of both keys: atomic on its own.
      await redis.del(TIER_KEY(installId), TIER_EXPIRES_KEY(installId));
      return;
    }
    const tx = redis.multi();
    tx.set(TIER_KEY(installId), tier);
    if (expiresAtMs && expiresAtMs > 0) {
      tx.set(TIER_EXPIRES_KEY(installId), String(expiresAtMs));
    } else {
      // Lifetime or perpetual Pro — clear any prior expiry
      tx.del(TIER_EXPIRES_KEY(installId));
    }
    await tx.exec();
  } catch (err) {
    logger.warn("user", "setUserTier failed", { error: String(err), tier });
    throw err;
  }
}

// ─── Scan history ─────────────────────────────────────────────────────────────

function isScanHistoryEntry(v: unknown): v is ScanHistoryEntry {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ca === "string" &&
    typeof o.score === "number" &&
    typeof o.verdict === "string" &&
    typeof o.scannedAt === "number"
  );
}

/**
 * Append a scan entry to the user's history. LPUSH puts newest at index 0;
 * LTRIM caps the list at HISTORY_HARD_CAP to bound storage. Older entries
 * are filtered out at read time (last-30-days policy).
 *
 * Failures are logged but don't propagate — a history-write failure should
 * never break a successful scan response.
 */
export async function pushScanHistory(
  installId: string,
  entry: ScanHistoryEntry,
): Promise<void> {
  if (!isAvailable() || !redis) return;
  try {
    await redis.lpush(HISTORY_KEY(installId), JSON.stringify(entry));
    // LTRIM was previously fired on every push, costing 1 Redis command
    // per scan. Sampled at ~1 % now: the list cap is HISTORY_HARD_CAP
    // (1000) and the worst-case overshoot between trims is bounded by
    // the sampling rate, so a 1000-cap list might hold ~1010 entries
    // temporarily — completely safe at read time (we filter by sinceMs
    // anyway). Cuts ~0.99 commands per scan.
    if (Math.random() < 0.01) {
      await redis.ltrim(HISTORY_KEY(installId), 0, HISTORY_HARD_CAP - 1);
    }
  } catch (err) {
    logger.warn("user", "history push failed", { error: String(err) });
  }
}

/**
 * Return the user's scan history, newest first, optionally filtered to a
 * time window. Default window is HISTORY_DAY_WINDOW (30 days) to match the
 * pricing-page promise.
 */
export async function getScanHistory(
  installId: string,
  options: { limit?: number; sinceMs?: number } = {},
): Promise<ScanHistoryEntry[]> {
  if (!isAvailable() || !redis) return [];

  const limit = Math.max(1, Math.min(options.limit ?? HISTORY_HARD_CAP, HISTORY_HARD_CAP));
  const sinceMs =
    options.sinceMs ?? Date.now() - HISTORY_DAY_WINDOW * 24 * 60 * 60 * 1000;

  try {
    const raw = await redis.lrange(HISTORY_KEY(installId), 0, limit - 1);
    const entries: ScanHistoryEntry[] = [];
    for (const item of raw ?? []) {
      try {
        // Upstash already deserialises JSON values stored as strings; tolerate both.
        const parsed: unknown = typeof item === "string" ? JSON.parse(item) : item;
        if (isScanHistoryEntry(parsed) && parsed.scannedAt >= sinceMs) {
          entries.push(parsed);
        }
      } catch {
        // Drop malformed entries silently — they shouldn't block valid ones
      }
    }
    return entries;
  } catch (err) {
    logger.warn("user", "history read failed", { error: String(err) });
    return [];
  }
}

