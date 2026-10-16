// __tests__/_helpers/confirmed-account.ts — a sign-up no longer signs anybody in (audit A-01).
//
// A sign-up now creates an UNCONFIRMED account and sends a link; the account owns nothing until its owner opens the link and types the password.
// A test about sessions, plans or deletion is not about that: it needs an account that is already confirmed. This puts it in the state the click
// leaves it in, straight in the fake store, so the test can go on and log in. The sign-up and the confirmation themselves are tested in
// email-proof.test.ts, with the real handlers.
//
// The account is made by the REAL createAccount (same fields, same session number), then flipped to confirmed the way confirmEmail does it: the
// flag on, the confirmation secret gone, the 48 h expiry lifted.
import type { Redis } from "@upstash/redis";
import { createAccount } from "../../api/_lib/account";

export async function createConfirmedAccount(redis: Redis, store: Map<string, unknown>, email: string, password: string, ttl?: Map<string, unknown>): Promise<void> {
  const out = await createAccount(redis, { email, password });
  if (!out.ok) throw new Error(`could not create ${email}: ${out.reason}`);
  confirmInStore(store, email);
  ttl?.delete(`account:${email}`);
}

/** Flips an existing account to confirmed, as confirmEmail leaves it. */
export function confirmInStore(store: Map<string, unknown>, email: string): void {
  const key = `account:${email}`;
  const h = { ...((store.get(key) as Record<string, unknown> | undefined) ?? {}) };
  h.emailVerified = "1";
  delete h.verifyNonce;
  delete h.verifySentAt;
  store.set(key, h);
}
