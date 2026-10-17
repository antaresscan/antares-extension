// api/_lib/login-guard.ts — a lock on the login of ONE ACCOUNT, whatever the address the guesses come from (audit A-11).
//
// The only limit on /api/auth/login used to be per network address (about 60 a minute): a script gets 3,600 guesses an hour on one account, and
// changing address starts again from zero. Now every password attempt counts against the e-mail it tried: 10 attempts in 15 minutes that did not
// end in a good login lock that e-mail's login for the rest of the 15 minutes (429 and Retry-After), and the first good login wipes the count.
//
// THE COUNT IS TAKEN WHEN THE ATTEMPT STARTS, not when it has failed (audit lot 4, 2026-10-17). The guard used to read the count, check the
// password (about 50 ms of scrypt), and only then count the failure: every guess sent at the same moment read the same count and went through,
// so 200 guesses fired together got 200 password checks, not 10. Now checkLoginLock adds the attempt in ONE atomic INCR before anything else:
// the 11th attempt of a window is refused whatever the others are doing, concurrent or not. A good login wipes the count (its own attempt with it).
//
//   - It counts attempts for ANY e-mail, an account that does not exist as well as one that does, and answers the same way: the lock must not
//     tell an attacker which addresses have an account.
//   - The key holds the SHA-256 of the normalised address, never the address.
//   - The window starts at the first attempt and is not extended by the following ones (a fixed 15 minutes, the key expires on its own).
//     A counter that lost its end date (a crash between INCR and EXPIRE) would lock the account for ever: when it reaches the lock it is given one.
//   - It only guards the PASSWORD forms (login, delete-account, verify-email). A session that is already signed in is not touched by a lock.
//   - If Redis does not answer the guard, the attempt goes through: the guard is a protection, not a reason for nobody to log in.
import { createHash } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { LOGIN_FAILURES_KEY } from "./keys";
import { normalizeEmail } from "./license";
import { logger } from "./logger";

/** Attempts of one e-mail (in a window, not followed by a good login) after which its login is locked. */
export const LOGIN_MAX_FAILURES = 10;
/** How long the attempts count, and how long the lock lasts at most: 15 minutes from the first attempt. */
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

/** The key of one e-mail's counter: the SHA-256 of the normalised address (an address that is not valid is keyed by what was typed, cut). */
export function loginFailuresKey(email: unknown): string {
  const typed = typeof email === "string" ? email : "";
  const norm = normalizeEmail(typed) ?? typed.trim().toLowerCase().slice(0, 320);
  return LOGIN_FAILURES_KEY(createHash("sha256").update(norm).digest("hex"));
}

export type LoginLock =
  /** The attempt may go on. `attempts` counts it, with the attempts before it in the window (0 when Redis did not answer). */
  | { locked: false; attempts: number }
  | { locked: true; retryAfterSec: number };

/**
 * Before the password is looked at: count this attempt, and say whether the login of this e-mail is locked. One atomic INCR (plus, on the first
 * attempt of a window, its EXPIRE; on a lock, the TTL that says how long is left). Call it once per password check, before the check.
 */
export async function checkLoginLock(redis: Redis, email: unknown): Promise<LoginLock> {
  const key = loginFailuresKey(email);
  try {
    const attempts = Number(await redis.incr(key)) || 0;
    if (attempts === 1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
    if (attempts <= LOGIN_MAX_FAILURES) return { locked: false, attempts };
    const ttl = Number(await redis.ttl(key));
    if (ttl === -1) {
      // A counter with no end date would never unlock: give it one (the normal case never gets here).
      await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
      return { locked: true, retryAfterSec: LOGIN_FAILURE_WINDOW_SECONDS };
    }
    return { locked: true, retryAfterSec: ttl > 0 ? ttl : LOGIN_FAILURE_WINDOW_SECONDS };
  } catch (e: unknown) {
    logger.warn("login-guard", "lock check unavailable — letting the attempt through", { error: String(e) });
    return { locked: false, attempts: 0 };
  }
}

/**
 * A login with this e-mail worked: wipe its count. `attempts` is what checkLoginLock returned for this attempt: 0 means Redis did not count it,
 * and there is nothing to wipe (no round trip).
 */
export async function clearLoginFailures(redis: Redis, email: unknown, attempts: number): Promise<void> {
  if (attempts <= 0) return;
  try {
    await redis.del(loginFailuresKey(email));
  } catch (e: unknown) {
    logger.warn("login-guard", "count not wiped", { error: String(e) });
  }
}
