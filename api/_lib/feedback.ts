// api/_lib/feedback.ts — User-submitted "this verdict was wrong" reports.
//
// Why this exists: the scoring engine is a probabilistic classifier
// trained on heuristics. There will be false positives (SAFE tokens
// flagged DANGER) and false negatives (RUG tokens that read SAFE).
// Without a feedback loop we have no way to detect drift between the
// engine's verdict and reality at scale — the only signal today is
// people complaining on Twitter.
//
// This module persists structured feedback into Upstash Redis so we
// can:
//   1. Aggregate per-CA agreement vs disagreement counts and surface
//      "users disagree with this verdict" as a signal in the overlay
//      itself (V2).
//   2. Mine systematic biases — e.g. "100 users marked our SAFE
//      verdict as RUG within 6h of scanning" implies the engine
//      missed a flag class on that cohort.
//   3. Train future scoring tweaks against a real human-labelled
//      corpus rather than only the synthetic backtest.
//
// Privacy stance: we store the IP /24 prefix (NOT the full IP), an
// optional install_id, and an optional free-text note. No email, no
// account binding. The reporter is identified ONLY for rate-limit
// dedup — the data we keep is enough to spot spam patterns ("ten
// reports from the same /24 within 5 minutes") without identifying
// individuals.
//
// Anti-spam: a per-install + per-CA lock with 24h TTL means a single
// install can only file one report per token per day. Combined with
// the IP-level rate limit applied at the endpoint layer, this is
// enough to keep a determined bot from flooding the bucket.

import { Redis } from "@upstash/redis";

export const FEEDBACK_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const PER_CA_CAP = 100; // most-recent-N reports kept per CA
const DEDUP_TTL_SECONDS = 60 * 60 * 24; // 24h: one report per install per CA per day

export type Verdict = "SAFE" | "CAUTION" | "DANGER" | "RUG";

export interface FeedbackEntry {
  /** The /api/scan verdict the user is correcting. */
  originalVerdict: Verdict;
  /** The verdict the user thinks is correct. Must differ from
   *  originalVerdict — the endpoint rejects same-as-original reports. */
  reportedVerdict: Verdict;
  /** Optional free-text note (≤500 chars). */
  note?: string;
  /** Unix ms when the report was filed. */
  ts: number;
  /** /24 prefix of the reporter's IP, e.g. "1.2.3". `null` when the
   *  source IP was unknown (rare — proxy/socket fallback). Stored for
   *  cohort + spam-pattern analysis only, never for identification. */
  ipPrefix: string | null;
}

let redis: Redis | null = null;

export function initFeedbackStore(r: Redis | null): void {
  redis = r;
}

/** Compute the per-CA Redis list key. Versioned so a future schema
 *  change can be rolled by bumping the prefix. */
function feedbackKey(ca: string): string {
  return `feedback:v1:${ca}`;
}

/** Compute the per-install dedup lock key. */
function dedupKey(installId: string, ca: string): string {
  return `feedback:lock:v1:${installId}:${ca}`;
}

/** Reduce an IP to its /24 prefix. Returns null when the input does
 *  not look like an IPv4 address (e.g. "unknown", IPv6 — we keep
 *  IPv6 out of the bucket entirely rather than guess at a /48 boundary
 *  that would change the per-cohort math). */
export function ipToPrefix24(ip: string | null | undefined): string | null {
  if (!ip || typeof ip !== "string") return null;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export interface SubmitFeedbackOpts {
  ca: string;
  originalVerdict: Verdict;
  reportedVerdict: Verdict;
  note?: string | null;
  installId?: string | null;
  ip?: string | null;
}

export type SubmitFeedbackResult =
  | { ok: true; totalReports: number }
  | { ok: false; reason: "no_storage" | "duplicate" | "same_verdict" | "write_failed" };

/**
 * Persist a feedback entry. Performs the per-install dedup lock and
 * the LPUSH+LTRIM cap. Returns { ok: true, totalReports } on success
 * — totalReports is the resulting list length, useful for the UI to
 * say "47 users have disagreed with this verdict".
 */
export async function submitFeedback(
  opts: SubmitFeedbackOpts,
): Promise<SubmitFeedbackResult> {
  if (!redis) return { ok: false, reason: "no_storage" };
  if (opts.originalVerdict === opts.reportedVerdict) {
    return { ok: false, reason: "same_verdict" };
  }

  // Per-install dedup. SET NX = atomic compare-and-set: returns "OK"
  // when we set the key, null when it already existed. We use this as
  // the lock primitive so concurrent attempts can't both pass through.
  if (opts.installId) {
    const lockSet = await redis.set(dedupKey(opts.installId, opts.ca), "1", {
      ex: DEDUP_TTL_SECONDS,
      nx: true,
    });
    if (lockSet !== "OK") return { ok: false, reason: "duplicate" };
  }

  const entry: FeedbackEntry = {
    originalVerdict: opts.originalVerdict,
    reportedVerdict: opts.reportedVerdict,
    note: opts.note ? opts.note.slice(0, 500) : undefined,
    ts: Date.now(),
    ipPrefix: ipToPrefix24(opts.ip),
  };

  const key = feedbackKey(opts.ca);
  try {
    // LPUSH then LTRIM keeps the most recent PER_CA_CAP reports without
    // racing the count — both ops are atomic. EXPIRE refreshes the TTL
    // on every write so high-traffic CAs don't drop entries early.
    const totalReports = await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, PER_CA_CAP - 1);
    await redis.expire(key, FEEDBACK_TTL_SECONDS);
    return {
      ok: true,
      totalReports: Math.min(totalReports, PER_CA_CAP),
    };
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

export interface FeedbackSummary {
  ca: string;
  count: number;
  /** Counts of (original → reported) pairs. Index by `${original}_${reported}`. */
  pairs: Record<string, number>;
  /** Most recent N entries (capped at the per-CA list cap). */
  recent: FeedbackEntry[];
}

/**
 * Read back the feedback list for a CA and produce an aggregated
 * summary. Used for moderation tooling + future "users disagree"
 * UI signal.
 */
export async function getFeedbackSummary(ca: string): Promise<FeedbackSummary | null> {
  if (!redis) return null;
  const raw = await redis.lrange<string>(feedbackKey(ca), 0, PER_CA_CAP - 1);
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ca, count: 0, pairs: {}, recent: [] };
  }
  const recent: FeedbackEntry[] = [];
  const pairs: Record<string, number> = {};
  for (const r of raw) {
    try {
      // Upstash returns parsed objects when stored as objects; we store
      // strings via JSON.stringify, so parse defensively. Skip malformed
      // entries rather than throwing — a single corrupt write should
      // not break the whole feed.
      const parsed = typeof r === "string" ? (JSON.parse(r) as FeedbackEntry) : (r as FeedbackEntry);
      recent.push(parsed);
      const k = `${parsed.originalVerdict}_${parsed.reportedVerdict}`;
      pairs[k] = (pairs[k] ?? 0) + 1;
    } catch {
      // skip
    }
  }
  return { ca, count: recent.length, pairs, recent };
}

/**
 * Compact, UI-friendly view of the feedback bucket for a CA. Suitable
 * for embedding inside the /api/scan response so the overlay can render
 * a "{N} users have flagged this as {verdict}" banner without a second
 * round-trip.
 *
 * Returns null when:
 *   - storage isn't configured (graceful degrade — overlay just hides
 *     the banner)
 *   - the CA has fewer than `minTotal` reports (low-signal noise floor)
 *   - no single (from, to) pair represents >= `dominanceThreshold` of
 *     the total reports (mixed-signal — surfacing the largest pair
 *     would mislead users)
 *
 * The defaults (5 / 0.5) are deliberately conservative: a token needs
 * at least 5 reports AND a clear majority verdict before we say "users
 * disagree" out loud. We can tighten this later if the bucket grows.
 *
 * @param ca                Mint to summarise.
 * @param minTotal          Minimum total reports to surface anything (default 5).
 * @param dominanceThreshold Fraction of reports the primary pair must
 *                            cover to be surfaced (default 0.5).
 */
export interface DisagreementSignal {
  /** Total number of reports for this CA. */
  totalReports: number;
  /** Primary (from, to) pair — what the engine said vs what users say. */
  from: Verdict;
  to: Verdict;
  /** Number of reports backing this specific pair (subset of totalReports). */
  pairCount: number;
}

export async function getDisagreementSignal(
  ca: string,
  minTotal = 5,
  dominanceThreshold = 0.5,
): Promise<DisagreementSignal | null> {
  const summary = await getFeedbackSummary(ca);
  if (!summary || summary.count < minTotal) return null;

  // Find the (from, to) pair with the most votes.
  let topKey: string | null = null;
  let topCount = 0;
  for (const [key, n] of Object.entries(summary.pairs)) {
    if (n > topCount) {
      topCount = n;
      topKey = key;
    }
  }
  if (!topKey || topCount === 0) return null;
  if (topCount / summary.count < dominanceThreshold) return null;

  const [from, to] = topKey.split("_") as [Verdict, Verdict];
  return {
    totalReports: summary.count,
    from,
    to,
    pairCount: topCount,
  };
}
