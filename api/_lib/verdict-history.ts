// api/_lib/verdict-history.ts — per-token verdict timeline.
// Each scan pushes one entry into a Redis ZSET keyed `vh:{ca}`. Score is
// the timestamp (ms), member is JSON of the entry. Read returns the
// last N entries oldest→newest with the most recent flagged as "now".
//
// Used by the v5 Timeline tab on the token page: instead of showing a
// static bookend (NOW + token launch), the tab renders the actual
// verdict-progression captured across previous scans.
//
// The persistence path is failure-tolerant: if Redis is down, push and
// read both no-op silently — the scan still serves the current verdict,
// and the frontend falls back to its v5 mock for the timeline rows.

import type { Redis } from "@upstash/redis";
import {
  VERDICT_HISTORY_PREFIX,
  VERDICT_HISTORY_MAX_ENTRIES,
  VERDICT_HISTORY_TTL,
  VERDICT_HISTORY_RESPONSE_LIMIT,
  VERDICT_HISTORY_DEDUPE_WINDOW_MS,
} from "./constants";
import type { Verdict, ScanFlag, VerdictHistoryEntry } from "./types";

export type { VerdictHistoryEntry };

let redis: Redis | null = null;
export function initHistoryCache(r: Redis): void {
  redis = r;
}

function key(ca: string): string {
  return `${VERDICT_HISTORY_PREFIX}${ca}`;
}

// Picks a one-line "event" string for a scan from its top critical /
// warning flag. Falls back to a generic "verdict still X" when the scan
// has nothing flagged. The frontend renders this as the right column of
// each timeline row.
export function deriveEvent(verdict: Verdict, flags: ScanFlag[]): string {
  if (!Array.isArray(flags) || flags.length === 0) {
    if (verdict === "SAFE") return "Token clean — no flags raised.";
    if (verdict === "CAUTION") return "Watching — minor concerns only.";
    if (verdict === "DANGER") return "Multiple risk signals detected.";
    return "Verdict update.";
  }
  // Sort by severity priority (critical > warning > info > bonus) then
  // by impact magnitude. Pick the most impactful flag's label.
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2, bonus: 3 };
  const sorted = [...flags].sort((a, b) => {
    const sa = order[a.severity] ?? 99;
    const sb = order[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    return Math.abs(b.impact || 0) - Math.abs(a.impact || 0);
  });
  return sorted[0].label;
}

// Push the current scan into the per-token history. Skipped silently
// when Redis is unavailable, when an entry was already written within
// the dedupe window (avoids loop-refresh spam), or when the most recent
// entry has the same verdict + score (state hasn't changed).
export async function pushVerdictHistory(
  ca: string,
  entry: VerdictHistoryEntry,
): Promise<void> {
  if (!redis) return;
  const k = key(ca);
  try {
    const recent = await redis.zrange<string[]>(k, -1, -1);
    const last = recent && recent.length > 0 ? parseEntry(recent[0]) : null;
    if (last) {
      const age = entry.ts - last.ts;
      if (age >= 0 && age < VERDICT_HISTORY_DEDUPE_WINDOW_MS) return;
      if (last.verdict === entry.verdict && Math.abs(last.score - entry.score) < 5) return;
    }
    await redis.zadd(k, { score: entry.ts, member: JSON.stringify(entry) });
    // Cap retained entries — drop the oldest.
    await redis.zremrangebyrank(k, 0, -VERDICT_HISTORY_MAX_ENTRIES - 1);
    await redis.expire(k, VERDICT_HISTORY_TTL);
  } catch {
    /* non-critical — scan still returns current verdict */
  }
}

// Read the last N entries (default 6) oldest→newest. Returns [] when
// Redis is unavailable, the key doesn't exist yet, or the stored
// payload is corrupted.
export async function getVerdictHistory(
  ca: string,
  limit: number = VERDICT_HISTORY_RESPONSE_LIMIT,
): Promise<VerdictHistoryEntry[]> {
  if (!redis) return [];
  try {
    const raw = await redis.zrange<string[]>(key(ca), -limit, -1);
    if (!Array.isArray(raw)) return [];
    return raw
      .map(parseEntry)
      .filter((e): e is VerdictHistoryEntry => e !== null);
  } catch {
    return [];
  }
}

// Upstash auto-deserializes JSON members in some edge cases; handle
// both the string-of-JSON form and the already-parsed-object form.
function parseEntry(raw: unknown): VerdictHistoryEntry | null {
  try {
    const obj: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") return null;
    const e = obj as Partial<VerdictHistoryEntry>;
    if (typeof e.ts !== "number" || typeof e.score !== "number" ||
        typeof e.verdict !== "string" || typeof e.event !== "string") {
      return null;
    }
    return { ts: e.ts, verdict: e.verdict as Verdict, score: e.score, event: e.event };
  } catch {
    return null;
  }
}
