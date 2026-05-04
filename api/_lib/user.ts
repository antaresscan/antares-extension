// api/_lib/user.ts — Per-user primitives backed by Upstash Redis.
//
// Identity: install_id (extension-generated UUID-style token). Pro v1 uses
// install_id alone; magic-link email auth in v2 will let users migrate their
// state across reinstalls by attaching email to install_id.
//
// Storage shape:
//   user:{id}:tier        STRING   "free" | "pro" | "lifetime"
//   user:{id}:tierExpires STRING   epoch-ms when tier downgrades to free
//   user:{id}:history     LIST     LPUSH JSON entries, LTRIM 0 999
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

// ─── Constants ────────────────────────────────────────────────────────────────

export const HISTORY_HARD_CAP = 1000;
export const HISTORY_DAY_WINDOW = 30; // expose last 30 days on GET /api/history
export const TIER_KEY = (id: string) => `user:${id}:tier`;
export const TIER_EXPIRES_KEY = (id: string) => `user:${id}:tierExpires`;
export const HISTORY_KEY = (id: string) => `user:${id}:history`;

// ─── Types ────────────────────────────────────────────────────────────────────

// "yearly" replaces "lifetime" for new purchases as of 2026-05. We keep
// "lifetime" in the type for grandfathered customers who paid before
// the rename — their stored tier is still honoured forever and the UI
// displays them as Lifetime. New checkout flows mint "yearly" only.
export type Tier = "free" | "pro" | "yearly" | "lifetime";

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
 * can keep running their own extension on Pro mode without burning
 * the Free quota during day-to-day work — and so QA installs don't
 * need real on-chain payments to test paid surfaces.
 *
 * `DEV_PRO_INSTALLS=install-aaaaaaaaaaa,install-bbbbbbbbbbb`
 *   → both ids return tier="lifetime", quota check is bypassed.
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

/**
 * Async dev-install check that ALSO honours installs whose bound email
 * is in the dev-Lifetime / dev-Pro hardcoded allowlists (see
 * api/_lib/account.ts: DEV_LIFETIME_EMAILS_HARDCODED,
 * DEV_PRO_EMAILS_HARDCODED).
 *
 * Why this exists: previously the X-Antares-Dev-Tier header was only
 * honoured for installs in the `DEV_PRO_INSTALLS` env var — meaning
 * the founder had to look up each install's UUID and add it manually,
 * for every browser they tested on, surviving every reinstall. Tying
 * the dev override to EMAIL instead means: sign up once with the
 * dev-allowlisted email, redeem any license in the extension once
 * (which binds install_id → email via account:install:<install_id>),
 * and from that moment on every tier-switch from this install's
 * Options dropdown is honoured by the server.
 *
 * Resolution order:
 *   1. installId in process.env.DEV_PRO_INSTALLS  → true (legacy path)
 *   2. installId has a bound email AND that email is dev-allowlisted → true
 *   3. otherwise → false
 *
 * Reads Redis (one cheap GET) on path 2. Path 1 short-circuits without
 * a network round-trip so per-scan latency is unchanged for the common
 * env-var case.
 */
export async function isDevAllowlistedInstall(
  installId: string,
): Promise<boolean> {
  if (!installId) return false;
  if (isDevProInstall(installId)) return true;
  if (!isAvailable() || !redis) return false;
  try {
    // Lazy import to avoid circular dep with account.ts (which imports
    // from license.ts which is independent — we only need the email
    // allowlist predicates here).
    const { isDevLifetimeEmail, isDevProEmail } = await import("./account");
    const email = await redis.get<string>(`account:install:${installId}`);
    if (!email) return false;
    return isDevLifetimeEmail(email) || isDevProEmail(email);
  } catch (err) {
    logger.warn("user", "dev-allowlist check failed", { error: String(err), installId });
    return false;
  }
}

/**
 * Resolve the effective tier for a request — non-session-aware variant.
 *
 * Used by callers that don't have a request object (tests, internal
 * batch jobs). Honours the dev-tier header for dev-allowlisted installs
 * and otherwise reads the stored install tier.
 *
 * The session-gated production path is `getEffectiveTierFromRequest`,
 * which is what every HTTP handler should call. This variant exists
 * so we don't break existing tests or any code path that legitimately
 * needs to read the raw install tier without the "are you signed in"
 * gate.
 */
export async function getEffectiveTier(
  installId: string,
  devTierHeaderRaw?: string | string[] | null,
): Promise<Tier> {
  if (devTierHeaderRaw && (await isDevAllowlistedInstall(installId))) {
    const raw = Array.isArray(devTierHeaderRaw)
      ? devTierHeaderRaw[0]
      : devTierHeaderRaw;
    const v = String(raw ?? "").trim().toLowerCase();
    if (v === "free" || v === "pro" || v === "yearly" || v === "lifetime") return v as Tier;
  }
  return getUserTier(installId);
}

/**
 * Combined tier + dev-bypass resolution. One session lookup, two answers.
 *
 * Returns:
 *   - `tier`: the same value `getEffectiveTierFromRequest` would return
 *   - `bypassQuota`: true if the caller is dev-allowlisted (env-var or
 *     bound dev email). When true, callers should skip the Free-tier
 *     daily-quota enforcement so the dev can flip the Options dropdown
 *     to Free and test the locked-overlay UX without burning through
 *     the 50-scan/day cap. Quota counter is still surfaced honestly
 *     in response headers — we just don't 429 the request.
 *
 * For non-dev users this returns `{ tier, bypassQuota: false }` and
 * behaves identically to `getEffectiveTierFromRequest`.
 */
export async function resolveTierAndBypass(
  req: { headers: { cookie?: string | string[]; "x-antares-dev-tier"?: string | string[] } },
  installId: string,
): Promise<{ tier: Tier; bypassQuota: boolean }> {
  const devTierHeaderRaw = req.headers["x-antares-dev-tier"] ?? null;

  // Env-var dev escape: bypass session, bypass quota.
  if (isDevProInstall(installId)) {
    let tier: Tier = "yearly";
    if (devTierHeaderRaw) {
      const raw = Array.isArray(devTierHeaderRaw) ? devTierHeaderRaw[0] : devTierHeaderRaw;
      const v = String(raw ?? "").trim().toLowerCase();
      if (v === "free" || v === "pro" || v === "yearly" || v === "lifetime") tier = v as Tier;
    } else {
      tier = await getUserTier(installId);
    }
    return { tier, bypassQuota: true };
  }

  if (!isAvailable() || !redis) {
    logger.metric("tier-resolve.no-redis", { installId, tier: "free" });
    return { tier: "free", bypassQuota: false };
  }

  // Helper to find which auth path was taken (header vs cookie vs none)
  const cookieRaw = (req as { headers: { cookie?: string | string[] } }).headers.cookie;
  const headerRaw = (req as { headers: { "x-antares-session"?: string | string[] } })
    .headers["x-antares-session"];
  const authSource = headerRaw
    ? "header"
    : (typeof cookieRaw === "string" && cookieRaw.includes("antares_session="))
      ? "cookie"
      : "none";

  // Single session read. The cookie or X-Antares-Session header is the
  // ONLY thing that proves who the user is — sign out clears it,
  // signing in restores it.
  let sessionEmail: string | null = null;
  try {
    const { getAccountFromRequest } = await import("./session-cookie");
    const account = await getAccountFromRequest(
      req as unknown as Parameters<typeof getAccountFromRequest>[0],
      redis,
    );
    sessionEmail = account?.email ?? null;
  } catch (err) {
    logger.warn("user", "session check failed during tier resolve", { error: String(err) });
    return { tier: "free", bypassQuota: false };
  }
  if (!sessionEmail) {
    logger.metric("tier-resolve.no-session", { installId, authSource, tier: "free" });
    return { tier: "free", bypassQuota: false };
  }

  // Read install→email binding (if any).
  let boundEmail: string | null = null;
  try {
    boundEmail = await redis.get<string>(`account:install:${installId}`);
  } catch (err) {
    logger.warn("user", "binding read failed during tier resolve", { error: String(err) });
  }
  // Anti-hijack: if the install is bound to a DIFFERENT email than the
  // session, refuse. An unbound install is fine — we'll resolve tier
  // from the session email's licences instead.
  if (boundEmail && boundEmail !== sessionEmail) {
    logger.metric("tier-resolve.hijack-block", {
      installId, authSource, sessionEmail, boundEmail, tier: "free",
    });
    return { tier: "free", bypassQuota: false };
  }

  // Dev check (single import).
  let isDev = false;
  try {
    const { isDevLifetimeEmail, isDevProEmail } = await import("./account");
    isDev = isDevLifetimeEmail(sessionEmail) || isDevProEmail(sessionEmail);
  } catch (err) {
    logger.warn("user", "dev-email check failed during tier resolve", { error: String(err) });
  }

  // Dev users can flip tier via header — applies on top of whatever
  // tier resolution would otherwise produce.
  if (isDev && devTierHeaderRaw) {
    const raw = Array.isArray(devTierHeaderRaw) ? devTierHeaderRaw[0] : devTierHeaderRaw;
    const v = String(raw ?? "").trim().toLowerCase();
    if (v === "free" || v === "pro" || v === "yearly" || v === "lifetime") {
      logger.metric("tier-resolve.dev-header", {
        installId, authSource, sessionEmail, tier: v,
      });
      return { tier: v as Tier, bypassQuota: true };
    }
  }

  // PRIMARY: resolve tier from the session email's licences.
  const emailTier = await resolveTierFromEmail(sessionEmail);
  if (emailTier !== "free") {
    logger.metric("tier-resolve.from-email", {
      installId, authSource, sessionEmail, tier: emailTier, isDev,
    });
    return { tier: emailTier, bypassQuota: isDev };
  }

  // FALLBACK: when the email has no licences but the install IS bound
  // to the same email, honour the install's stored tier.
  if (boundEmail === sessionEmail) {
    const legacyTier = await getUserTier(installId);
    logger.metric("tier-resolve.from-install-fallback", {
      installId, authSource, sessionEmail, tier: legacyTier, isDev,
    });
    return { tier: legacyTier, bypassQuota: isDev };
  }

  // No licence on email + no install binding → user is signed in but
  // hasn't paid for anything. Free.
  logger.metric("tier-resolve.no-license-no-binding", {
    installId, authSource, sessionEmail, tier: "free", isDev,
  });
  return { tier: "free", bypassQuota: isDev };
}

/**
 * Pick the best active tier across all licenses owned by `email`.
 * Priority: lifetime (no expiry) > yearly (active) > pro (active) > free.
 *
 * Active means either no expiresAt set OR expiresAt is in the future.
 * Lifetime licences never have an expiry; pro/yearly licences expire
 * after their respective windows.
 *
 * Same logic as /account.html resolveTier() — they walk licences and
 * pick the highest active band. Keep both copies in sync.
 */
async function resolveTierFromEmail(email: string): Promise<Tier> {
  if (!isAvailable() || !redis) return "free";
  try {
    // Lazy import to avoid pulling license module into every code path
    // that touches user.ts (some are cold paths where license lookup
    // would be wasted overhead).
    const { getLicensesByEmail } = await import("./license");
    const licenses = await getLicensesByEmail(redis, email);
    if (licenses.length === 0) return "free";

    const now = Date.now();
    let hasLifetime = false;
    let activeYearly = false;
    let activePro = false;
    for (const l of licenses) {
      if (l.tier === "lifetime") {
        hasLifetime = true;
      } else if (l.tier === "yearly") {
        if (!l.expiresAt || l.expiresAt > now) activeYearly = true;
      } else if (l.tier === "pro") {
        if (!l.expiresAt || l.expiresAt > now) activePro = true;
      }
    }
    if (hasLifetime) return "lifetime";
    if (activeYearly) return "yearly";
    if (activePro) return "pro";
    return "free";
  } catch (err) {
    logger.warn("user", "email tier resolve failed", { error: String(err), email });
    return "free";
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
  // Thin wrapper around resolveTierAndBypass so callers that don't care
  // about the dev-quota-bypass flag stay simple. Both functions share one
  // session+binding read internally.
  const { tier } = await resolveTierAndBypass(req, installId);
  return tier;
}

// ─── Tier read / write ────────────────────────────────────────────────────────

/**
 * Read the user's tier. Default Free; treats expired Pro/Lifetime as Free
 * automatically (server-side enforcement, not just client trust). Dev
 * installs listed in DEV_PRO_INSTALLS short-circuit to lifetime so the
 * dev never gets quota-locked on their own install.
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
 * Persist a tier change. Used by payment webhooks (Lemonsqueezy) to flip
 * an install_id between free/pro/lifetime as subscriptions start, renew
 * and cancel.
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
      await redis.del(TIER_KEY(installId));
      await redis.del(TIER_EXPIRES_KEY(installId));
      return;
    }
    await redis.set(TIER_KEY(installId), tier);
    if (expiresAtMs && expiresAtMs > 0) {
      await redis.set(TIER_EXPIRES_KEY(installId), String(expiresAtMs));
    } else {
      // Lifetime or perpetual Pro — clear any prior expiry
      await redis.del(TIER_EXPIRES_KEY(installId));
    }
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
    await redis.ltrim(HISTORY_KEY(installId), 0, HISTORY_HARD_CAP - 1);
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

