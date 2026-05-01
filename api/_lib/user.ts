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
//   user:{id}:watchlist   ZSET     score = addedAt epoch-ms, value = address
//
// History uses a LIST (chronological), watchlist uses a ZSET (ordered set
// with addedAt as score so we can return items sorted without a second pass).
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

// ─── Constants ────────────────────────────────────────────────────────────────

export const HISTORY_HARD_CAP = 1000;
export const HISTORY_DAY_WINDOW = 30; // expose last 30 days on GET /api/history
export const WATCHLIST_MAX_FREE = 5;
export const WATCHLIST_MAX_PRO = 50;
export const TIER_KEY = (id: string) => `user:${id}:tier`;
export const TIER_EXPIRES_KEY = (id: string) => `user:${id}:tierExpires`;
export const HISTORY_KEY = (id: string) => `user:${id}:history`;
export const WATCHLIST_KEY = (id: string) => `user:${id}:watchlist`;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tier = "free" | "pro" | "lifetime";

export interface ScanHistoryEntry {
  ca: string;
  score: number;
  verdict: string;
  scannedAt: number; // epoch ms
  symbol?: string;
  name?: string;
}

export interface WatchlistItem {
  address: string;
  addedAt: number; // epoch ms
}

export interface AddWatchlistResult {
  added: boolean;
  count: number;
  max: number;
  reason?: "already_present" | "limit_reached";
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

// ─── Tier read / write ────────────────────────────────────────────────────────

/**
 * Read the user's tier. Default Free; treats expired Pro/Lifetime as Free
 * automatically (server-side enforcement, not just client trust).
 */
export async function getUserTier(installId: string): Promise<Tier> {
  if (!isAvailable() || !redis) return "free";
  try {
    const tier = await redis.get<string>(TIER_KEY(installId));
    if (tier !== "pro" && tier !== "lifetime") return "free";

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

// ─── Watchlist ────────────────────────────────────────────────────────────────

/** Tier-aware ceiling for the watchlist. */
export function watchlistMaxFor(tier: Tier): number {
  return tier === "free" ? WATCHLIST_MAX_FREE : WATCHLIST_MAX_PRO;
}

/**
 * Add a token to the user's watchlist if there's room under their tier cap
 * and it isn't already present. Returns the post-add count and the cap so
 * the client can render "3/5 used" without a second round-trip.
 */
export async function addToWatchlist(
  installId: string,
  address: string,
  tier: Tier,
): Promise<AddWatchlistResult> {
  const max = watchlistMaxFor(tier);

  if (!isAvailable() || !redis) {
    return { added: false, count: 0, max, reason: "limit_reached" };
  }

  try {
    const key = WATCHLIST_KEY(installId);
    const existingScore = await redis.zscore(key, address);
    if (existingScore !== null && existingScore !== undefined) {
      const count = (await redis.zcard(key)) ?? 0;
      return { added: false, count, max, reason: "already_present" };
    }

    const currentCount = (await redis.zcard(key)) ?? 0;
    if (currentCount >= max) {
      return { added: false, count: currentCount, max, reason: "limit_reached" };
    }

    await redis.zadd(key, { score: Date.now(), member: address });
    return { added: true, count: currentCount + 1, max };
  } catch (err) {
    logger.warn("user", "watchlist add failed", { error: String(err) });
    return { added: false, count: 0, max, reason: "limit_reached" };
  }
}

/** Remove a token from the watchlist. Returns true if a row was removed. */
export async function removeFromWatchlist(
  installId: string,
  address: string,
): Promise<boolean> {
  if (!isAvailable() || !redis) return false;
  try {
    const removed = await redis.zrem(WATCHLIST_KEY(installId), address);
    return (removed ?? 0) > 0;
  } catch (err) {
    logger.warn("user", "watchlist remove failed", { error: String(err) });
    return false;
  }
}

/**
 * Return the watchlist sorted by addedAt (oldest first by default —
 * matches what users expect when scrolling through "things I've been
 * watching").
 */
export async function getWatchlist(installId: string): Promise<WatchlistItem[]> {
  if (!isAvailable() || !redis) return [];
  try {
    const raw = await redis.zrange<string[]>(WATCHLIST_KEY(installId), 0, -1, {
      withScores: true,
    });
    if (!raw) return [];
    const items: WatchlistItem[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const address = raw[i];
      const score = Number(raw[i + 1]);
      if (typeof address === "string" && Number.isFinite(score)) {
        items.push({ address, addedAt: score });
      }
    }
    return items;
  } catch (err) {
    logger.warn("user", "watchlist read failed", { error: String(err) });
    return [];
  }
}

/** Cardinality only — cheaper than fetching the full list. */
export async function getWatchlistCount(installId: string): Promise<number> {
  if (!isAvailable() || !redis) return 0;
  try {
    return (await redis.zcard(WATCHLIST_KEY(installId))) ?? 0;
  } catch (err) {
    logger.warn("user", "watchlist count failed", { error: String(err) });
    return 0;
  }
}
