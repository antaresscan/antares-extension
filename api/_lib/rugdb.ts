// api/_lib/rugdb.ts — Rug Database: stores flagged tokens in Redis
import type { Redis } from "@upstash/redis";
import type { ScanFlag, Verdict } from "./types";
import { MAX_RUG_INDEX } from "./constants";
import { logger } from "./logger";

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

let redis: Redis | null = null;

export function initRugDb(r: Redis): void {
  redis = r;
}

/**
 * What it takes to be listed publicly as a rug. The Wall of Shame is an ACCUSATION: it names a token, and its creator, to anyone who
 * calls /api/rugs, for 90 days. It used to take a DANGER verdict, which fires on weak or miscalibrated signals (links not registered
 * on DexScreener, a concentration, a duplicated flag, a liquidity that is not reported...): sound projects were listed next to real
 * rugs (audit M19). Now both are required:
 *   1. the verdict is RUG, and
 *   2. a CRITICAL flag names something that HAPPENED or a trap that is closed: liquidity removed or abandoned, a honeypot or blocked
 *      sells, a non-transferable token, a creator who rugged before, a slow rug, an exit trap.
 * An authority an issuer keeps (mint, freeze, permanent delegate) is a capability, not an event: without this distinction a stablecoin
 * or a tokenised stock that is RUG for its authorities would be listed with real rugs. A price drop alone is not evidence either.
 */
export const RUG_EVIDENCE = /abandoned pool|liquidity removed|honeypot detected|sells blocked|non-transferable|creator history of rugged|slow rug detected|exit (liquidity )?trap/i;

export function isRugEvidence(flags: ScanFlag[]): boolean {
  return flags.some((f) => f.severity === "critical" && RUG_EVIDENCE.test(f.label));
}

/**
 * Check if a token is already flagged as a rug in the database.
 * Returns the entry if found, null otherwise. Entries recorded before the rule above with a DANGER verdict are not rugs by it
 * and are not returned (they leave the database by themselves when their 90 days end).
 */
export async function getRugEntry(mint: string): Promise<RugEntry | null> {
  if (!redis) return null;
  try {
    const entry = await redis.get<RugEntry>(`${RUG_PREFIX}${mint}`);
    return entry && entry.risk === "RUG" ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Record a token as a rug in the database, when the verdict is RUG and a critical flag is evidence of a rug (see RUG_EVIDENCE).
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
  if (data.risk !== "RUG" || !isRugEvidence(data.flags)) return;

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
    if (count > MAX_RUG_INDEX * 0.8) {
      logger.warn("rugdb", "RugDB capacity warning", { count, max: MAX_RUG_INDEX });
    }
    if (count > MAX_RUG_INDEX) {
      await redis.zremrangebyrank(RUG_INDEX, 0, count - MAX_RUG_INDEX - 1);
    }
  } catch {
    // Non-critical — silently fail
  }
}

/**
 * Get recent rugs from the database (for Wall of Shame endpoint).
 *
 * Uses MGET so the N keys round-trip as a single Redis command instead
 * of N pipelined GETs. Same number of HTTP requests as the previous
 * pipeline (Upstash batches both into one), but MGET is one command
 * instead of N — fewer parser invocations server-side and the canonical
 * idiom for "fetch multiple keys at once".
 */
export async function getRecentRugs(limit = 50): Promise<RugEntry[]> {
  if (!redis) return [];
  try {
    const mints = await redis.zrange(RUG_INDEX, 0, limit - 1, { rev: true });
    if (!mints.length) return [];

    const keys = (mints as string[]).map(mint => `${RUG_PREFIX}${mint}`);
    const results = await redis.mget<RugEntry[]>(...keys);
    // RUG only: entries recorded under the old rule with a DANGER verdict are not listed (see RUG_EVIDENCE).
    return results.filter((r): r is RugEntry => r !== null && r.risk === "RUG");
  } catch {
    return [];
  }
}
