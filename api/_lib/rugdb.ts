// api/_lib/rugdb.ts — Rug Database: stores flagged tokens in Redis
import type { Redis } from "@upstash/redis";
import type { ScanFlag, Verdict } from "./types";

export interface RugEntry {
  mint: string;
  symbol: string | null;
  score: number;
  risk: Verdict;
  flags: string[];
  creator: string | null;
  flaggedAt: number;
  scanCount: number;
}

const RUG_PREFIX = "rug:";
const RUG_INDEX = "rug:index";
const RUG_TTL_SECONDS = 90 * 24 * 3600; // 90 days
const MAX_RUG_INDEX = 500; // max entries in the index

let redis: Redis | null = null;

export function initRugDb(r: Redis): void {
  redis = r;
}

/**
 * Check if a token is already flagged as a rug in the database.
 * Returns the entry if found, null otherwise.
 */
export async function getRugEntry(mint: string): Promise<RugEntry | null> {
  if (!redis) return null;
  try {
    const entry = await redis.get<RugEntry>(`${RUG_PREFIX}${mint}`);
    return entry ?? null;
  } catch {
    return null;
  }
}

/**
 * Record a token as a rug/danger in the database.
 * Called when forceRug is true or risk is RUG/DANGER.
 */
export async function recordRug(data: {
  mint: string;
  symbol: string | null;
  score: number;
  risk: Verdict;
  flags: ScanFlag[];
  creator: string | null;
}): Promise<void> {
  if (!redis) return;
  if (data.risk !== "RUG" && data.risk !== "DANGER") return;

  try {
    const existing = await redis.get<RugEntry>(`${RUG_PREFIX}${data.mint}`);
    const scanCount = (existing?.scanCount ?? 0) + 1;

    const entry: RugEntry = {
      mint: data.mint,
      symbol: data.symbol,
      score: data.score,
      risk: data.risk,
      flags: data.flags
        .filter(f => f.severity === "critical" || f.severity === "warning")
        .slice(0, 5)
        .map(f => f.label),
      creator: data.creator,
      flaggedAt: existing?.flaggedAt ?? Date.now(),
      scanCount,
    };

    await Promise.all([
      redis.set(`${RUG_PREFIX}${data.mint}`, entry, { ex: RUG_TTL_SECONDS }),
      redis.zadd(RUG_INDEX, { score: Date.now(), member: data.mint }),
    ]);

    // Trim index to prevent unbounded growth
    const count = await redis.zcard(RUG_INDEX);
    if (count > MAX_RUG_INDEX) {
      await redis.zremrangebyrank(RUG_INDEX, 0, count - MAX_RUG_INDEX - 1);
    }
  } catch {
    // Non-critical — silently fail
  }
}

/**
 * Get recent rugs from the database (for Wall of Shame endpoint).
 */
export async function getRecentRugs(limit = 50): Promise<RugEntry[]> {
  if (!redis) return [];
  try {
    const mints = await redis.zrange(RUG_INDEX, 0, limit - 1, { rev: true });
    if (!mints.length) return [];

    const pipeline = redis.pipeline();
    for (const mint of mints) {
      pipeline.get(`${RUG_PREFIX}${mint}`);
    }
    const results = await pipeline.exec();
    return (results as (RugEntry | null)[])
      .filter((r): r is RugEntry => r !== null);
  } catch {
    return [];
  }
}
