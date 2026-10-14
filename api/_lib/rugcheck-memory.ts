// api/_lib/rugcheck-memory.ts — RugCheck's last good answer for a token, used only when RugCheck does not answer.
//
// RugCheck is the source that fails the most (2026-10-14: its report engine answered {"error":"unable to generate report"} after 12 s, or nothing, for every
// established token for hours, while brand-new tokens were answered in 0.2 s). What it tells about a token moves slowly once the token is not new: whether the
// liquidity is burned or locked, the history of the creator, the "copycat" and "holder correlation" findings. So when it does not answer, a scan reads the last
// answer it got for this token instead of going without (and, during an outage, instead of showing "Limited data" for every token that was scanned before).
//
// Rules, all of them to keep it from ever showing something wrong:
//   - it is a MEMORY, not a cache: a scan always asks RugCheck first and only reads the memory for the part that did not come back;
//   - only a complete, valid answer is kept (the summary and the report, both of the shape RugCheck really sends); an error body or a "not found" is never kept;
//   - it is kept RUGCHECK_MEMORY_TTL_S (6 h), and used only while it is young enough for the token's age: 6 h for a token of a day or more, 20 minutes for a younger
//     one or one of unknown age (an LP can be burned, or pulled, minutes after a launch: the memory must not outlive what it says);
//   - a RugCheck that answers "not found" (it does not know the token) is an answer: the memory is not read;
//   - Redis missing or failing: nothing is read or written, the scan goes on as it did (fail open); a preview deployment keeps its own entries (deployment.ts).
// Cost: one Redis command per scan (a write when RugCheck answered, a read when it did not).
import { getCacheRedis } from "./cache";
import { deploymentNamespace } from "./deployment";
import { isRugCheckReport, isValidRugCheckSummary } from "./helpers";
import { logger } from "./logger";
import type { RugCheckReport, RugCheckSummary } from "./types";

/** How long the last good answer is kept. */
export const RUGCHECK_MEMORY_TTL_S = 6 * 3600;
/** The oldest answer a token of a day or more may be given, and the oldest a younger token (or one of unknown age) may be given. */
export const RUGCHECK_MEMORY_MAX_AGE_S = { established: 6 * 3600, young: 20 * 60 } as const;

/** A preview deployment keeps its own entries (deployment.ts), like the scan cache. */
export const rugcheckMemoryKey = (mint: string): string => `antares:rugcheck:${deploymentNamespace()}${mint}`;

/** The oldest memory (seconds) a token of this age (minutes) may be given. */
export function rugcheckMemoryMaxAgeSec(tokenAgeMinutes: number | null): number {
  const established = tokenAgeMinutes !== null && Number.isFinite(tokenAgeMinutes) && tokenAgeMinutes >= 1440;
  return established ? RUGCHECK_MEMORY_MAX_AGE_S.established : RUGCHECK_MEMORY_MAX_AGE_S.young;
}

interface Memory { at: number; summary: RugCheckSummary; report: RugCheckReport }

/** RugCheck answered "not found": it does not know the token. That is an answer, not a failure. */
const isNotFound = (s: RugCheckSummary | null): boolean =>
  !!s && (s.error === "not found" || (typeof s.message === "string" && s.message.toLowerCase().includes("not found")));
/** A summary that carries an `error` is an error body, not an analysis: never kept, never read. */
const isErrorBody = (s: RugCheckSummary | null): boolean => !!s && typeof (s as { error?: unknown }).error === "string";

/** Keep a complete, valid answer. Never throws; nothing is written when Redis is missing or the answer is not complete. */
export async function rememberRugCheck(mint: string, summary: RugCheckSummary | null, report: RugCheckReport | null, now: number = Date.now()): Promise<void> {
  try {
    if (!summary || !report || isErrorBody(summary) || !isValidRugCheckSummary(summary) || !isRugCheckReport(report)) return;
    const redis = getCacheRedis();
    if (!redis) return;
    const memory: Memory = { at: now, summary, report };
    await redis.set(rugcheckMemoryKey(mint), memory, { ex: RUGCHECK_MEMORY_TTL_S });
  } catch (e: unknown) {
    logger.warn("rugcheck-memory", "not kept", { error: String(e) });
  }
}

/** The last good answer for this mint if it is young enough for the token's age, else null. Never throws. */
export async function recallRugCheck(mint: string, tokenAgeMinutes: number | null, now: number = Date.now()): Promise<Memory | null> {
  try {
    const redis = getCacheRedis();
    if (!redis) return null;
    const raw = await redis.get<Memory>(rugcheckMemoryKey(mint));
    if (!raw || typeof raw !== "object" || typeof raw.at !== "number") return null;
    if (!isValidRugCheckSummary(raw.summary) || !isRugCheckReport(raw.report) || isErrorBody(raw.summary)) return null; // a value that is not what we wrote is not read
    const ageSec = (now - raw.at) / 1000;
    if (!Number.isFinite(ageSec) || ageSec < 0 || ageSec > rugcheckMemoryMaxAgeSec(tokenAgeMinutes)) return null;
    return raw;
  } catch (e: unknown) {
    logger.warn("rugcheck-memory", "not read", { error: String(e) });
    return null;
  }
}

/**
 * What RugCheck said, completed from the memory for the part that did not come back. Both parts live: they are kept (the write is not waited for) and returned
 * as they are. A part missing: the memory fills it, when it is young enough; `fromMemory` says so. A summary that says "not found" is an answer: nothing is filled.
 */
export async function reconcileRugCheck(
  mint: string,
  live: { summary: RugCheckSummary | null; report: RugCheckReport | null },
  tokenAgeMinutes: number | null,
  now: number = Date.now(),
): Promise<{ summary: RugCheckSummary | null; report: RugCheckReport | null; fromMemory: boolean }> {
  if (live.summary && live.report) {
    void rememberRugCheck(mint, live.summary, live.report, now);
    return { ...live, fromMemory: false };
  }
  if (isNotFound(live.summary)) return { ...live, fromMemory: false };
  const memory = await recallRugCheck(mint, tokenAgeMinutes, now);
  if (!memory) return { ...live, fromMemory: false };
  return { summary: live.summary ?? memory.summary, report: live.report ?? memory.report, fromMemory: true };
}
