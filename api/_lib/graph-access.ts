// api/_lib/graph-access.ts — who may ask /api/graph, and how often.
//
// /api/graph is the most expensive endpoint we have: the insider graph costs ~120 Helius credits for a mint nobody has asked for
// yet, ~430 with the activity feed. It is the Pro feature "Insider Watch", so it is not open to anonymous or Free callers
// (audit A-03: before this, one IP could drain the whole Helius plan in a few hours just by changing the mint). Three guards, in
// the order the handler applies them, cheapest first:
//   1. a limiter per USER (10 a minute), keyed by the session, never by the install id the client chooses;
//   2. a ceiling per DAY for the whole service (GRAPH_GLOBAL_PER_DAY, 500 by default), whoever asks;
//   3. no Redis, no service: both guards live in Redis, and an expensive endpoint must not run unguarded (fail CLOSED, unlike the
//      cold-scan limiter which fails open because a scan is the core product).
import { createHash } from "node:crypto";
import type { VercelRequest } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import { logger } from "./logger";
import { getAccountFromRequest } from "./session-cookie";

/** Graph requests one user may make in a minute. A person opens a handful of Insider Watch tabs; this stops a script. */
export const GRAPH_PER_USER_PER_MINUTE = 10;

/** Graph requests the whole service answers in a UTC day, unless GRAPH_GLOBAL_PER_DAY says otherwise. */
export const GRAPH_GLOBAL_PER_DAY_DEFAULT = 500;

const DAY_KEY = (utcDate: string) => `antares_graph_day:${utcDate}`;
// The counter of a day is dead the next morning; two days of life leave room for clock skew and are still a self-cleaning key.
const DAY_KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

let redis: Redis | null = null;
let userLimiter: Ratelimit | null = null;

export function initGraphAccess(redisInstance: Redis): void {
  redis = redisInstance;
  userLimiter = new Ratelimit({
    redis: redisInstance,
    limiter: Ratelimit.slidingWindow(GRAPH_PER_USER_PER_MINUTE, "60 s"),
    analytics: false,
    prefix: "antares_graph",
  });
}

/** Reset state — only for tests. */
export function _resetGraphAccessForTests(): void {
  redis = null;
  userLimiter = null;
}

/** False when Redis is not configured: the handler then refuses (503) instead of running without its guards. */
export function graphAccessAvailable(): boolean {
  return redis !== null && userLimiter !== null;
}

/** The daily ceiling: GRAPH_GLOBAL_PER_DAY when it is a positive integer, else the default. */
export function graphDailyCap(): number {
  const raw = Number(process.env.GRAPH_GLOBAL_PER_DAY);
  return Number.isInteger(raw) && raw > 0 ? raw : GRAPH_GLOBAL_PER_DAY_DEFAULT;
}

/**
 * The limiter key of a caller: a hash of the signed-in e-mail, so the key is stable across installs and browsers and reveals
 * nothing. The install id is only the fallback for a caller with no session (the DEV_PRO_INSTALLS escape hatch): it is chosen by
 * the client, which is why a session is always preferred.
 */
export function graphUserKey(sessionEmail: string | null, installOrIp: string): string {
  if (sessionEmail) return `u:${createHash("sha256").update(sessionEmail.trim().toLowerCase()).digest("hex").slice(0, 32)}`;
  return `i:${installOrIp}`;
}

/** The limiter key of the caller of this request (see graphUserKey). A session that cannot be read falls back to `installOrIp`. */
export async function graphUserKeyOf(req: VercelRequest, installOrIp: string): Promise<string> {
  let email: string | null = null;
  if (redis) {
    try {
      email = (await getAccountFromRequest(req, redis))?.email ?? null;
    } catch {
      // SESSION_SECRET unset, Redis error: no session to key on.
    }
  }
  return graphUserKey(email, installOrIp);
}

/** Seconds until the next 00:00 UTC (>= 1): when the daily ceiling opens again. */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export type GraphGuard =
  | { ok: true }
  | { ok: false; reason: "limited"; retryAfterSec: number }
  | { ok: false; reason: "unavailable" };

/** The per-user limiter. Fails CLOSED: a Redis error is "unavailable", never a free pass. */
export async function checkGraphUserLimit(userKey: string): Promise<GraphGuard> {
  if (!userLimiter) return { ok: false, reason: "unavailable" };
  try {
    const { success, reset } = await userLimiter.limit(userKey);
    if (success) return { ok: true };
    const waitMs = typeof reset === "number" ? reset - Date.now() : 10_000;
    return { ok: false, reason: "limited", retryAfterSec: Math.min(60, Math.max(1, Math.ceil(waitMs / 1000))) };
  } catch (e: unknown) {
    logger.warn("graph-access", "user limiter unavailable — refusing", { error: String(e) });
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Takes one unit from today's global budget. INCR and EXPIRE travel in one pipeline, so a crash between the two cannot leave an
 * immortal counter. Requests refused here have already been counted, which only keeps the counter honest: it says how many
 * were asked, the cap says how many were answered.
 */
export async function takeGraphDailyBudget(now: Date = new Date()): Promise<GraphGuard> {
  if (!redis) return { ok: false, reason: "unavailable" };
  const key = DAY_KEY(now.toISOString().slice(0, 10));
  try {
    const pipe = redis.pipeline();
    pipe.incr(key);
    pipe.expire(key, DAY_KEY_TTL_SECONDS);
    const [used] = (await pipe.exec()) as [number, unknown];
    if (typeof used !== "number") return { ok: false, reason: "unavailable" };
    if (used > graphDailyCap()) {
      logger.warn("graph-access", "daily ceiling reached", { used, cap: graphDailyCap() });
      return { ok: false, reason: "limited", retryAfterSec: secondsUntilUtcMidnight(now) };
    }
    return { ok: true };
  } catch (e: unknown) {
    logger.warn("graph-access", "daily budget unavailable — refusing", { error: String(e) });
    return { ok: false, reason: "unavailable" };
  }
}
