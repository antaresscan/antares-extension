// api/_lib/login-guard.ts — a lock on the login of ONE ACCOUNT, whatever the address the guesses come from (audit A-11).
//
// The only limit on /api/auth/login used to be per network address (about 60 a minute): a script gets 3,600 guesses an hour on one account, and
// changing address starts again from zero. Now every FAILED login counts against the e-mail it tried: 10 failures in 15 minutes lock that
// e-mail's login for the rest of the 15 minutes (429 and Retry-After), and the first good login wipes the count.
//
//   - It counts failures for ANY e-mail, an account that does not exist as well as one that does, and answers the same way: the lock must not
//     tell an attacker which addresses have an account.
//   - The key holds the SHA-256 of the normalised address, never the address.
//   - The window starts at the first failure and is not extended by the following ones (a fixed 15 minutes, the key expires on its own).
//     A counter that lost its end date (a crash between INCR and EXPIRE) would lock the account for ever: the next check gives it one back.
//   - It only guards the PASSWORD form. A session that is already signed in is not touched by a lock (the account's owner keeps working while
//     somebody else is guessing), and the lock ends by itself.
//   - If Redis does not answer the guard, the attempt goes through: the guard is a protection, not a reason for nobody to log in.
import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { LOGIN_FAILURES_KEY } from "./keys";
import { normalizeEmail } from "./license";
import { logger } from "./logger";

/** Failed logins of one e-mail after which its login is locked. */
export const LOGIN_MAX_FAILURES = 10;
/** How long the failures count, and how long the lock lasts at most: 15 minutes from the first failure. */
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

/** The key of one e-mail's counter: the SHA-256 of the normalised address (an address that is not valid is keyed by what was typed, cut). */
export function loginFailuresKey(email: unknown): string {
  const typed = typeof email === "string" ? email : "";
  const norm = normalizeEmail(typed) ?? typed.trim().toLowerCase().slice(0, 320);
  return LOGIN_FAILURES_KEY(createHash("sha256").update(norm).digest("hex"));
}

export type LoginLock =
  | { locked: false; failures: number }
  | { locked: true; retryAfterSec: number };

/** Before the password is looked at: is the login of this e-mail locked? One round trip (the count and its end date together). */
export async function checkLoginLock(redis: Redis, email: unknown): Promise<LoginLock> {
  const key = loginFailuresKey(email);
  try {
    const pipe = redis.pipeline();
    pipe.get(key);
    pipe.ttl(key);
    const [rawCount, rawTtl] = (await pipe.exec()) as [unknown, unknown];
    const failures = Number(rawCount ?? 0) || 0;
    const ttl = Number(rawTtl);
    // A counter with no end date would never unlock: give it one (the normal case never gets here).
    if (failures > 0 && ttl === -1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
    if (failures >= LOGIN_MAX_FAILURES) {
      return { locked: true, retryAfterSec: ttl > 0 ? ttl : LOGIN_FAILURE_WINDOW_SECONDS };
    }
    return { locked: false, failures };
  } catch (e: unknown) {
    logger.warn("login-guard", "lock check unavailable — letting the attempt through", { error: String(e) });
    return { locked: false, failures: 0 };
  }
}

/** A login with this e-mail failed (wrong password, or no such account): count it. */
export async function recordLoginFailure(redis: Redis, email: unknown): Promise<void> {
  const key = loginFailuresKey(email);
  try {
    const n = Number(await redis.incr(key));
    if (n === 1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
  } catch (e: unknown) {
    logger.warn("login-guard", "failure not counted", { error: String(e) });
  }
}

/** A login with this e-mail worked: wipe its count. `failures` is what checkLoginLock read: with none there is nothing to wipe, and no round trip. */
export async function clearLoginFailures(redis: Redis, email: unknown, failures: number): Promise<void> {
  if (failures <= 0) return;
  try {
    await redis.del(loginFailuresKey(email));
  } catch (e: unknown) {
    logger.warn("login-guard", "count not wiped", { error: String(e) });
  }
}
