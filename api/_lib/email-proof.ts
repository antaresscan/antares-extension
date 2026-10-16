// api/_lib/email-proof.ts — Does this account prove it owns its e-mail address? (audit A-01)
//
// THE FLAW: anybody could sign up with ANY e-mail address, and licences are keyed by e-mail (email:licenses:<email>). Someone who knew the
// address a customer paid with could sign up with it and see, and use, that customer's licences; with an address on DEV_LIFETIME_EMAILS /
// DEV_PRO_EMAILS they were even given a licence.
//
// THE RULE: an account only owns the licences of its e-mail once the e-mail is CONFIRMED. A confirmed account is proof enough; an account
// that is not confirmed is Free, sees no licence, and gets no dev grant, whatever it types.
//
// THE GRACE FOR EXISTING ACCOUNTS: the accounts that exist today were never asked to confirm anything. Taking their plan away on the day
// this ships would cut off paying customers who did nothing wrong. So an account CREATED BEFORE this rule existed is honoured until
// LEGACY_GRACE_ENDS_AT, and is sent the confirmation e-mail the next time it logs in. After that date it is treated like a new account.
// (An unconfirmed account made before the cut-off is exactly as exposed as it was yesterday: the grace does not add a risk, it ends one.)
//
// No I/O here: pure functions, tested alone (__tests__/email-proof.test.ts).
import type { Account } from "./account";

/**
 * Accounts created before this instant existed before the rule: they get the grace. It must be the moment this code goes LIVE: an account made
 * by the old code (which asked for no proof) has to fall before it, an account made by the new code (which asks) after it. It is written as the
 * day the work started and is MOVED to the instant of the merge when A-01 is merged (the grace end below moves with it).
 * Never in the future: an account created by a test or by the new code before this date would count as an old one.
 */
export const LEGACY_ACCOUNTS_CREATED_BEFORE = Date.UTC(2026, 9, 16);
/** The end of the grace: from this instant an unconfirmed account of any age has no licence. 2026-11-20 00:00 UTC. */
export const LEGACY_GRACE_ENDS_AT = Date.UTC(2026, 10, 20);

/** How long a confirmation link works. */
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** A NEW account that is never confirmed is deleted by Redis after this long (nothing hangs on it: no licence, no grant). */
export const PENDING_ACCOUNT_TTL_SECONDS = 48 * 60 * 60;
/** The shortest time between two confirmation e-mails to the same account. */
export const VERIFY_MAIL_COOLDOWN_MS = 60 * 1000;
/** A login of an unconfirmed account sends the link again only if the last one is older than this. */
export const VERIFY_MAIL_ON_LOGIN_COOLDOWN_MS = 10 * 60 * 1000;
/** The shortest time between two "you already have an account" e-mails to the same address. */
export const ALREADY_REGISTERED_MAIL_COOLDOWN_SECONDS = 60 * 60;

export type EmailProof =
  /** The owner clicked the link and typed the password: the e-mail is proven. */
  | "verified"
  /** Not confirmed, but the account existed before the rule: honoured until LEGACY_GRACE_ENDS_AT. */
  | "grace"
  /** Not confirmed: Free, no licence, no dev grant. */
  | "unverified";

export function emailProofOf(account: Pick<Account, "emailVerified" | "createdAt">, now: number = Date.now()): EmailProof {
  if (account.emailVerified) return "verified";
  if (account.createdAt > 0 && account.createdAt < LEGACY_ACCOUNTS_CREATED_BEFORE && now < LEGACY_GRACE_ENDS_AT) return "grace";
  return "unverified";
}

/** True when the account may use the licences of its e-mail (confirmed, or still inside the grace). */
export function isEmailProven(account: Pick<Account, "emailVerified" | "createdAt">, now: number = Date.now()): boolean {
  return emailProofOf(account, now) !== "unverified";
}
