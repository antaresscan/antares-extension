// api/_lib/keys.ts — The Redis keys that more than one module reads or writes, each defined ONCE.
//
// A key is stored data: renaming one orphans every record written under the old name, with no error and no log. So the strings live
// here, nothing else is in this file, and it imports nothing. That last point is why it exists: license.ts used to keep its own copy
// of ACCOUNT_INSTALL_KEY "to avoid the circular import account -> license -> account", and user.ts wrote the same string inline twice.
// A copy can drift; a string typed inline can be mistyped. Every module now imports the key from here (and the modules that exported
// one before still re-export it, so no caller changes).
//
// THE CATALOG
//
//   who a person is
//     account:<email>                      ACCOUNT_KEY               the account (a hash: id, e-mail, password hash, creation date, e-mail verified,
//                                                                    sessionVersion, verifyNonce, verifySentAt). The e-mail must already be
//                                                                    normalised (normalizeEmail): this builder does not lower-case it.
//     account:install:<installId>          ACCOUNT_INSTALL_KEY       which e-mail an install is bound to (value: the e-mail)
//     auth_fail:<sha256 of the e-mail>     LOGIN_FAILURES_KEY        the failed logins of one e-mail (a counter, 15 minutes: login-guard.ts)
//     account-create:<sha256 of the e-mail> ACCOUNT_CREATE_LOCK_KEY  a 20 s mutex around "look, then create" of a sign-up (account.ts)
//     signup-notice:<sha256 of the e-mail> ALREADY_REGISTERED_MAIL_KEY  "you already have an account" was e-mailed to this address: not again for an hour (A-01)
//     signup-mail:<sha256 of the e-mail>   SIGNUP_MAIL_BUDGET_KEY    e-mails the sign-up form sent to this address today (24 h): at most 5
//     signup-net:<sha256 of the network>   SIGNUP_NETWORK_KEY        sign-ups started from one network this hour (1 h): at most 20
//   what a person has
//     user:<installId>:tier                TIER_KEY                  the tier stored on the install (pro, yearly, lifetime)
//     user:<installId>:tierExpires         TIER_EXPIRES_KEY          epoch ms when that tier ends
//     user:<installId>:history             HISTORY_KEY               the scans of the install (a list)
//   licences
//     license:<key>                        LICENSE_KEY               one licence
//     email:licenses:<email>               EMAIL_LICENSES_KEY        the licences an e-mail owns
//     intent:license:<reference>           INTENT_LICENSE_KEY        the licence issued for one payment (or one dev grant): what makes
//                                                                    issuing idempotent. To re-issue by hand, delete THIS key.
//     intent:license-lock:<reference>      INTENT_LICENSE_LOCK_KEY   a 30 s mutex around "check, then issue"
//   payments
//     payment-intent:<reference>           INTENT_KEY                one checkout
//     payment-intents:pending              INTENT_INDEX_KEY          the checkouts waiting for their payment (the cron sweeps it)
//     payment-intent-by-np:<paymentId>     INTENT_BY_NP_PAYMENT_KEY  checkout found from NOWPayments' payment id
//     payment-intent-by-inv:<invoiceId>    INTENT_BY_NP_INVOICE_KEY  checkout found from NOWPayments' invoice id
//
// Keys that only ONE module touches stay next to the code that owns them (and are listed here so that the whole map is in one place):
// (<namespace> is deploymentNamespace(): empty in production, "pv:<deployment>:" on a preview, "dev:" under `vercel dev`.)
//   antares:<namespace><engineVersion>:<mint>           cache.ts            the cached scan of a token
//   antares:lock:<namespace><engineVersion>:<mint>      cache.ts            the single-flight lock of a cold scan (value: the request id)
//   antares:lastgood:<namespace><engineVersion>:<mint>  cache.ts            the verdict of the last time an issuer-backed token's market was read, used only when DexScreener cannot be (6 h)
//   antares:goplus:<namespace><mint>                    goplus-cache.ts     GoPlus' answer, reused 0 to 30 minutes depending on the token's age
//   antares:rugcheck:<namespace><mint>                  rugcheck-memory.ts  RugCheck's last answer, kept 6 h for when RugCheck is down
//   <namespace>ig:, <namespace>igsig:, <namespace>iasig:, <namespace>iact:  insider-*.ts  the insider graph and its activity
//   rug:<mint>, rug:index                               rugdb.ts            the rug database
//   condemned:<mint>                                    condemned.ts        a token that rugged (a RUG confirmed by a fact), kept for good, no expiry. To clear a mistake: delete it
//   usage:<YYYY-MM-DD>                                  usage.ts            how much each upstream was used (a hash, 40 days)
//   vh:<mint>                                           constants.ts        the verdict history (decommissioned)
//   antares_graph_day:<YYYY-MM-DD>                      graph-access.ts     the insider graphs built that day (the global daily ceiling, 2 days)
//   antares_rl, antares_burst, antares_cold, antares_net   middleware.ts    the rate limiters (@upstash/ratelimit prefixes)
//   antares_graph                                       graph-access.ts     the per-user insider-graph rate limiter
// (There is no quota counter any more: quota.ts writes nothing, every tier is unlimited.)

// ─── who a person is ──────────────────────────────────────────────────────────

export const ACCOUNT_KEY = (emailLc: string) => `account:${emailLc}`;
export const ACCOUNT_INSTALL_KEY = (installId: string) => `account:install:${installId}`;
/** The failed logins of one e-mail. The key holds the SHA-256 (hex) of the normalised address, never the address. */
export const LOGIN_FAILURES_KEY = (emailSha256Hex: string) => `auth_fail:${emailSha256Hex}`;
/** Short mutex around the creation of the account of one e-mail (two sign-ups at once must not both create it). SHA-256 of the address, never the address. */
export const ACCOUNT_CREATE_LOCK_KEY = (emailSha256Hex: string) => `account-create:${emailSha256Hex}`;
/** "You already have an account" was sent to this address (A-01): a cooldown, so that a sign-up form cannot be used to flood an inbox. SHA-256 of the address. */
export const ALREADY_REGISTERED_MAIL_KEY = (emailSha256Hex: string) => `signup-notice:${emailSha256Hex}`;
/** E-mails the sign-up form has sent to one address today (a counter, 24 h): the ceiling that stops the form from mail-bombing an inbox. SHA-256 of the address. */
export const SIGNUP_MAIL_BUDGET_KEY = (emailSha256Hex: string) => `signup-mail:${emailSha256Hex}`;
/** Sign-ups started from one network this hour (a counter, 1 h): the ceiling on how many inboxes one sender can make us write to. SHA-256 of the network. */
export const SIGNUP_NETWORK_KEY = (networkSha256Hex: string) => `signup-net:${networkSha256Hex}`;

// ─── what a person has ────────────────────────────────────────────────────────

export const TIER_KEY = (id: string) => `user:${id}:tier`;
export const TIER_EXPIRES_KEY = (id: string) => `user:${id}:tierExpires`;
export const HISTORY_KEY = (id: string) => `user:${id}:history`;

// ─── licences ─────────────────────────────────────────────────────────────────

export const LICENSE_KEY = (key: string) => `license:${key}`;
export const EMAIL_LICENSES_KEY = (email: string) => `email:licenses:${email.toLowerCase().trim()}`;
export const INTENT_LICENSE_KEY = (reference: string) => `intent:license:${reference}`;
/** Short-lived mutex around "check, then issue" for one intent: see issueLicense. */
export const INTENT_LICENSE_LOCK_KEY = (reference: string) => `intent:license-lock:${reference}`;

// ─── payments ─────────────────────────────────────────────────────────────────

export const INTENT_KEY = (reference: string) => `payment-intent:${reference}`;
export const INTENT_INDEX_KEY = "payment-intents:pending";
export const INTENT_BY_NP_PAYMENT_KEY = (paymentId: string) => `payment-intent-by-np:${paymentId}`;
export const INTENT_BY_NP_INVOICE_KEY = (invoiceId: string) => `payment-intent-by-inv:${invoiceId}`;
