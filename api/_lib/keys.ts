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
//     account:<email>                      ACCOUNT_KEY               the account (a hash: id, e-mail, password hash, creation date, e-mail verified)
//     account:install:<installId>          ACCOUNT_INSTALL_KEY       which e-mail an install is bound to (value: the e-mail)
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
//   antares:<namespace><engineVersion>:<mint>        cache.ts      the cached scan of a token (the namespace separates previews from production)
//   antares:lock:<namespace><engineVersion>:<mint>   cache.ts      the single-flight lock of a cold scan
//   ig:, igsig:, iasig:, iact:                       insider-*.ts  the insider graph and its activity
//   rug:<mint>, rug:index                            rugdb.ts      the rug database
//   condemned:<mint>                                 condemned.ts  a token that rugged (a RUG confirmed by a fact), kept for good, no expiry. To clear a mistake: delete it
//   usage:<day>                                      usage.ts      how much each upstream was used
//   quota:<key>:<day>                                quota.ts      the daily counter (kept for analytics; no tier is limited)
//   vh:<mint>                                        constants.ts  the verdict history (decommissioned)
//   antares_rl, antares_burst, antares_cold, antares_net   middleware.ts   the rate limiters

// ─── who a person is ──────────────────────────────────────────────────────────

export const ACCOUNT_KEY = (emailLc: string) => `account:${emailLc}`;
export const ACCOUNT_INSTALL_KEY = (installId: string) => `account:install:${installId}`;

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
