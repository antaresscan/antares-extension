// api/_lib/account-erasure.ts — "Delete my account" (audit A-14b, GDPR article 17).
//
// WHAT IS ERASED, for the account asking and for every install that belongs to it:
//   account:<email>              the account: e-mail, password hash, creation date, session number (its sessions die with it)
//   account:install:<installId>  which e-mail the install is bound to
//   user:<installId>:history     the scans of the install
//   user:<installId>:tier        the plan stored on the install
//   user:<installId>:tierExpires when that plan ends
//
// WHAT IS KEPT, on purpose: the record of what was bought (license:<key>, email:licenses:<email>, intent:license:<reference>). It is the
// accounting record of a sale, which the law makes us keep; privacy.html says so. The checkout itself (payment-intent:*) already expires by
// itself after INTENT_RETENTION_SECONDS (7 days). A licence that is kept is also what gives a customer who signs up again with the same
// e-mail their plan back: nothing of what they paid for is lost by deleting the account.
//
// WHY THE STORED PLAN OF AN INSTALL GOES TOO: resolveTier (entitlements.ts, row "install-stored") gives an install the plan stored on it as
// soon as it is bound to the e-mail of the session. Once this binding is erased, the next person who signs in on that browser gets the
// install bound to THEIR e-mail by sync-token: if the old plan were still stored there, they would inherit it.
//
// WHICH INSTALLS BELONG TO AN E-MAIL: there is no list of them. The binding is a key per install whose VALUE is the e-mail, written when a
// licence is redeemed, when the website syncs the extension and when a payment is confirmed. They are found three ways:
//   1. the installs that redeemed a licence of this e-mail (license.redeemedBy);
//   2. the install that sends the request, when the caller gave one;
//   3. a walk through the `account:install:*` keys, keeping those that hold this e-mail (the only way to find the others).
// An install that is bound to ANOTHER e-mail is never touched, whichever way it was found: a shared browser keeps the other person's data.
//
// ALL OR NOTHING: if the walk does not finish in time (a very large database), nothing is deleted and the caller is told to try again; the
// account itself goes LAST, so a failure in the middle leaves it in place and the request can simply be repeated.
import type { Redis } from "@upstash/redis";
import { ACCOUNT_KEY, ACCOUNT_INSTALL_KEY, TIER_KEY, TIER_EXPIRES_KEY, HISTORY_KEY } from "./keys";
import { getLicensesByEmail, normalizeEmail } from "./license";
import { logger } from "./logger";
import { emailRef } from "./log-ref";

/** How long the walk through the install bindings may take, so that the answer still fits in a serverless call (10 s on the Hobby plan). */
export const ERASURE_SCAN_BUDGET_MS = 6000;
/** Keys looked at per round trip of the walk. */
const SCAN_PAGE = 1000;

const INSTALL_KEY_PREFIX = ACCOUNT_INSTALL_KEY("");

export type ErasureOutcome =
  | { ok: true; installsErased: number }
  | { ok: false; reason: "search_incomplete" };

/** The installs whose binding holds this e-mail, found by walking the `account:install:*` keys. `complete` is false when the time ran out first. */
async function walkBindings(redis: Redis, email: string, deadline: number): Promise<{ installs: string[]; complete: boolean }> {
  const installs: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, { match: `${INSTALL_KEY_PREFIX}*`, count: SCAN_PAGE });
    cursor = String(next);
    if (keys.length > 0) {
      const values = await redis.mget<Array<string | null>>(...keys);
      keys.forEach((key, i) => {
        if (values[i] === email) installs.push(key.slice(INSTALL_KEY_PREFIX.length));
      });
    }
    if (cursor !== "0" && Date.now() > deadline) return { installs, complete: false };
  } while (cursor !== "0");
  return { installs, complete: true };
}

/**
 * Erases the account of `email` and what hangs on it (see the top of this file). The caller has already proved who it is (a valid session
 * AND the password): this function trusts it.
 *
 * `installHint` is the install id the request came with, when there was one.
 */
export async function eraseAccount(
  redis: Redis,
  email: string,
  options: { installHint?: string | null; scanBudgetMs?: number } = {},
): Promise<ErasureOutcome> {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: false, reason: "search_incomplete" };

  // Every install that may belong to this account, from the three sources. A licence or the request only suggests an install: its binding
  // is read again below before anything is deleted.
  const candidates = new Set<string>();
  for (const license of await getLicensesByEmail(redis, norm)) {
    if (license.redeemedBy) candidates.add(license.redeemedBy);
  }
  if (options.installHint) candidates.add(options.installHint);

  const walk = await walkBindings(redis, norm, Date.now() + (options.scanBudgetMs ?? ERASURE_SCAN_BUDGET_MS));
  if (!walk.complete) {
    logger.warn("account-erasure", "search through the install bindings did not finish — nothing was deleted", { emailRef: emailRef(norm) });
    return { ok: false, reason: "search_incomplete" };
  }
  for (const id of walk.installs) candidates.add(id);

  let installsErased = 0;
  for (const installId of candidates) {
    // Read the binding NOW: an install that was bound to somebody else in the meantime is theirs, not ours.
    const bound = await redis.get<string>(ACCOUNT_INSTALL_KEY(installId));
    if (bound && bound !== norm) continue;
    await redis.del(ACCOUNT_INSTALL_KEY(installId), HISTORY_KEY(installId), TIER_KEY(installId), TIER_EXPIRES_KEY(installId));
    installsErased++;
  }

  // The account goes last: with it gone, no session of it counts any more.
  await redis.del(ACCOUNT_KEY(norm));
  logger.info("account-erasure", "account erased", { emailRef: emailRef(norm), installsErased });
  return { ok: true, installsErased };
}
