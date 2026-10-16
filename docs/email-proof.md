# E-mail proof (audit A-01)

An account only owns the licenses of its e-mail address once the owner has **confirmed** the address. Before this, anybody could sign up with
any address and see, and use, the licenses bought with it (and an address on `DEV_LIFETIME_EMAILS` / `DEV_PRO_EMAILS` was even given a license).

## How it works

1. `POST /api/auth/signup` creates an **unconfirmed** account (deleted by Redis after 48 h if nobody confirms it) and e-mails a link. It signs
   nobody in, and it answers `{ ok: true, status: "check_email" }` for **every** address (new, waiting for its confirmation, already an
   account), so the form tells nothing about who has an account. An address that already has an account gets an e-mail that says so (at most
   once an hour). A second sign-up never replaces the password of an existing account.
2. The e-mail links to `verify.html` on the API host, with the token in the **fragment** (`#t=...`): a fragment is never sent to a server and
   never reaches a log or a `Referer` header.
3. `verify.html` asks for the **password** and posts `{ token, password }` to `POST /api/auth/verify-email`. The link alone does not confirm,
   on purpose: someone who signs up first with somebody else's address and a password they know (the "pre-hijack") can never get the account
   confirmed, because the real owner of the mailbox does not know that password and the attacker cannot read the mailbox. The account then
   disappears after 48 h. A wrong password counts against the same lock as the login (10 failures in 15 minutes).
4. Until the e-mail is confirmed the account is Free: no plan, no license in the list, no dev grant, no install bound to it
   (`api/_lib/entitlements.ts`, row 5, "email-unverified"). It can log in, to see why and to ask for its link again
   (`POST /api/auth/resend-verification`, once a minute at most).

## The accounts that existed before the rule: a grace

Taking the plan of a paying customer away on the day this ships would be unfair, so an account **created before
`LEGACY_ACCOUNTS_CREATED_BEFORE`** is honoured until **`LEGACY_GRACE_ENDS_AT`** (both in `api/_lib/email-proof.ts`). Its next login sends it the
link (at most once every 10 minutes), and the website's account page shows a notice with the date. After that date it is treated like a new
account: confirm, or Free.

`LEGACY_ACCOUNTS_CREATED_BEFORE` was set to the instant of the merge (2026-10-16 01:40 UTC) and `LEGACY_GRACE_ENDS_AT` to 2026-11-20. The first
must never be in the future (an account created by the new code would count as an old one). An account made by the old code in the few minutes
between that instant and the deployment is not in the grace; it receives its confirmation link at its next login.

## What the deployment needs

| Variable | What | If missing |
|---|---|---|
| `RESEND_API_KEY` | Resend → API Keys. Set by the owner in Vercel. | Sign-ups answer **503** and create nothing (an account that could never be confirmed is useless). Logins and existing accounts are not affected. |
| `MAIL_FROM` | Sender, default `Antares <contact@antaresscan.com>`. | The default. |
| `VERIFY_LINK_BASE` | Where the link points, default `https://antares-extension.vercel.app`. | The default. Set it on a preview to test there. |

The sender's domain (`antaresscan.com`) must be **verified in Resend** (the SPF and DKIM DNS records Resend shows) or Resend refuses every send.

## What is never logged

No address, no link, no secret, no password, no key: only the outcome and the HTTP status (`api/_lib/mailer.ts`). `__tests__/email-proof.test.ts`
runs a whole sign-up / confirm / resend / failure flow and checks that none of them appears in a log.

## Tests

- `__tests__/email-proof.test.ts`: the rule, the token, the sign-up, the confirmation, the pre-hijack, what an unconfirmed account owns
  (nothing), the grace, the resend, the logs, and static guards on the source.
- `__tests__/entitlements.test.ts`: the new row of the table.
- `e2e/api-security.spec.ts`: the routes exist and refuse what they must on the deployment under test.
