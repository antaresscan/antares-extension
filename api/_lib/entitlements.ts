// api/_lib/entitlements.ts — Who is Free and who is Pro: ONE table, in one place.
//
// The rule of the product: the Free tier is the verdict, unlimited and fast; Pro is the explanation of the verdict (the flags behind it,
// the layers, the AI summary...), and nothing else. What the tier changes is drawn in api/_lib/pro-gate.ts; WHICH tier a caller has is
// decided here.
//
// Four things can make a caller Pro, and they used to be read in different places:
//   - a licence bought with an e-mail address (a payment, a redeemed code, a grant to a founder),
//   - the tier stored on the install (user:<install>:tier, written when a licence is redeemed on it),
//   - the dev exceptions: an install in DEV_PRO_INSTALLS, an e-mail in DEV_LIFETIME_EMAILS or DEV_PRO_EMAILS, and the
//     X-Antares-Dev-Tier header that lets those pick the tier they test with,
//   - and the session, which says whose e-mail the caller is (the licence and the stored tier only count for the owner).
//
// The decision is a function of FACTS (decideTier), listed below in the order it reads them. The facts are given as functions, so the
// ones a row does not need are never read: a Free caller without a session costs no Redis call beyond the session itself. api/_lib/user.ts
// gathers the facts (Redis, session) and logs the decision; this file has no I/O and is tested row by row.
//
// THE TABLE (first row that applies wins):
//
//   #  when                                                    tier                              reason
//   1  the install is in DEV_PRO_INSTALLS                      the tier the header names, else   dev-install
//                                                              Yearly
//   2  the storage (Redis) is not reachable                    Free                              no-storage
//   3  reading the session fails                               Free                              session-error
//   4  there is no session                                     Free                              no-session
//   5  the session's account has NOT proved its e-mail         Free (a licence, a binding, a dev   email-unverified
//      (audit A-01: see email-proof.ts)                        e-mail: none of them counts for an
//                                                              address nobody has confirmed)
//   6  the e-mail is a dev e-mail AND the header names a tier  that tier                         dev-header
//   7  the e-mail owns an active licence                       the best one: Lifetime > Yearly   license
//                                                              > Pro (a licence with an end date
//                                                              counts until that date)
//   8  the install is bound to ANOTHER e-mail                  Free (no inheriting what someone    install-bound-elsewhere
//                                                              else paid on this install)
//   9  the install is bound to THIS e-mail                     the tier stored on the install    install-stored
//                                                              (Free once its end date has passed)
//  10  none of the above (a session, no licence, no binding)   Free                              no-license-no-binding
//
// A dev e-mail (rows 6 to 10) is also marked `isDev` on the decision, which only changes what is logged. There used to be a
// "bypassQuota" column here, the dev exemption from the daily scan quota; there is no quota any more (every tier is unlimited).

export type Tier = "free" | "pro" | "yearly" | "lifetime";

const TIERS: readonly Tier[] = ["free", "pro", "yearly", "lifetime"];

/** Pro, Yearly and Lifetime see the explanation of the verdict; Free sees the verdict. */
export function isPaidTier(tier: Tier): boolean {
  return tier !== "free";
}

/** The tier a X-Antares-Dev-Tier header names ("free", "pro", "yearly" or "lifetime", whatever the case), or null when it names none. */
export function parseDevTier(raw: string | string[] | null | undefined): Tier | null {
  if (raw === null || raw === undefined) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const v = String(first ?? "").trim().toLowerCase();
  return TIERS.includes(v as Tier) ? (v as Tier) : null;
}

/** What the session says about the caller. */
export type SessionFact =
  | { kind: "none" }
  | { kind: "error"; name: string; message: string }
  /** `proven`: the account owns its e-mail (confirmed, or inside the grace of the accounts that predate the rule): email-proof.ts. */
  | { kind: "email"; email: string; proven: boolean };

/** Everything the decision reads. The functions are only called when a row needs them, in the order of the table. */
export interface TierFacts {
  /** The install is in DEV_PRO_INSTALLS. */
  devInstall: boolean;
  /** The tier the X-Antares-Dev-Tier header names; null when there is no header or it names no tier. */
  devTier: Tier | null;
  /** The storage is reachable. */
  storageAvailable: boolean;
  session: () => Promise<SessionFact>;
  /** The e-mail this install is bound to (null when none, or when it cannot be read). */
  boundEmail: () => Promise<string | null>;
  isDevEmail: (email: string) => boolean;
  /** The best active licence of this e-mail ("free" when it has none). */
  licenseTier: (email: string) => Promise<Tier>;
  /** The tier stored on the install, its end date applied ("free" when it has none or it has passed). */
  installTier: () => Promise<Tier>;
}

export type TierReason =
  | "dev-install" | "no-storage" | "session-error" | "no-session" | "email-unverified" | "dev-header" | "license"
  | "install-bound-elsewhere" | "install-stored" | "no-license-no-binding";

export interface TierDecision {
  tier: Tier;
  /** Which row of the table decided. */
  reason: TierReason;
  /** What the decision was made from, for the logs. Set when the row got that far. */
  sessionEmail?: string;
  boundEmail?: string | null;
  isDev?: boolean;
  error?: { name: string; message: string };
}

export async function decideTier(f: TierFacts): Promise<TierDecision> {
  // 1. A dev install: no storage, no session. The header picks the tier, Yearly otherwise.
  if (f.devInstall) return { tier: f.devTier ?? "yearly", reason: "dev-install" };

  // 2. Nowhere to read a licence or a session: Free, never Pro by default.
  if (!f.storageAvailable) return { tier: "free", reason: "no-storage" };

  // 3-4. The session says whose e-mail this is. Without it nothing else counts, paying customers included: "log out" means Free.
  const session = await f.session();
  if (session.kind === "error") return { tier: "free", reason: "session-error", error: { name: session.name, message: session.message } };
  if (session.kind === "none") return { tier: "free", reason: "no-session" };
  const email = session.email;

  // 5. Nobody has shown that this address is theirs (audit A-01): everything below is a claim on the address, so none of it counts.
  //    This comes BEFORE the dev e-mails and the licences: anyone can type a founder's address or a customer's at sign-up.
  if (!session.proven) return { tier: "free", reason: "email-unverified", sessionEmail: email };

  const boundEmail = await f.boundEmail();
  const isDev = f.isDevEmail(email);

  // 6. A dev e-mail can test with the tier it names.
  if (isDev && f.devTier) return { tier: f.devTier, reason: "dev-header", sessionEmail: email, boundEmail, isDev };

  // 7. A licence owned by this e-mail.
  const licenseTier = await f.licenseTier(email);
  if (licenseTier !== "free") return { tier: licenseTier, reason: "license", sessionEmail: email, boundEmail, isDev };

  // 8. This install was paid by someone else: its tier is not for this e-mail.
  if (boundEmail && boundEmail !== email) return { tier: "free", reason: "install-bound-elsewhere", sessionEmail: email, boundEmail, isDev };

  // 9. This install is bound to this e-mail: the tier stored on it (set when a licence was redeemed here).
  if (boundEmail === email) {
    const stored = await f.installTier();
    return { tier: stored, reason: "install-stored", sessionEmail: email, boundEmail, isDev };
  }

  // 10. A session, no licence, no binding: Free until a licence is redeemed or the install is linked.
  return { tier: "free", reason: "no-license-no-binding", sessionEmail: email, boundEmail, isDev };
}
