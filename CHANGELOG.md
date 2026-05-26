# Changelog

All notable changes to the Antares Extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.2] - 2026-05-18

### Security — pre-launch hardening (5 blockers closed)

External audit (6 independent sub-agent reviews, scored 75/100 globally)
flagged 5 pre-launch security blockers. All five are closed in this
release. None are fixes to active exploits — they're defence-in-depth
gates that close paths an attacker could chain through.

- **Bridge `event.origin` allowlist** — `contents/antares-website-bridge.ts`.
  Reject `postMessage` traffic from any origin outside the 4 product
  hosts. Without this gate, an XSS landing on a wildcard-widened match
  could plant a forged session JWT into `chrome.storage.local`. +9
  happy-dom tests pin the behaviour.
- **`criticalActors.desc` XSS hole** — `js/views.js` interpolated
  `${a.desc}` straight into innerHTML, escaping the discipline used by
  every other field. New `escapeHtmlAllowBold` whitelists bare
  `<b>…</b>` (the one shape the backend documents) and escapes
  everything else — `<b onclick=…>`, `<script>`, `<img onerror=…>`, etc.
  Also applied to `exit-note`. +5 tests.
- **`OPEN_TAB` host whitelist** — `background.ts` now restricts the
  tabs handler to the 5 Antares product hosts + enforces HTTPS. A
  compromised content script can no longer use the extension's tab
  privileges to open arbitrary phishing pages under an Antares-trusted-
  looking pattern.
- **`SESSION_SECRET` fallback memoisation** — `api/_lib/account.ts`.
  The Upstash-derived bootstrap fallback now resolves once per cold
  start instead of once per request. Operators see the loud Sentry
  signal; spam drops to zero. Adds `_resetSessionSecretCacheForTests`.
- **Founder grant emails out of source** — removed the hardcoded
  founder email from `DEV_LIFETIME_EMAILS_HARDCODED` /
  `DEV_PRO_EMAILS_HARDCODED` arrays — configure exclusively via
  `DEV_LIFETIME_EMAILS` / `DEV_PRO_EMAILS` env vars. Eliminates a
  public phish/credential-stuff signal. `.env.example` updated.

### Operator action required ⚠️

Before deploying this version, set these Vercel env vars (or the
founder auto-grant and session signing stop working):

- `DEV_LIFETIME_EMAILS=<comma-separated dev emails>`
- `DEV_PRO_EMAILS=<comma-separated dev emails>`
- `SESSION_SECRET=$(openssl rand -hex 32)` (if not already explicit —
  the bootstrap fallback now logs a loud Sentry warn on every cold
  start)

### Changed

- `chore(deps)` — `@vercel/node 5.8.1 → 5.8.2` +
  `@vercel/build-utils 13.24 → 13.25` + transitive lockfile patches.
  Resolves 2/81 advisories surfaced by `npm audit`. The remaining 79
  are build-time only (Plasmo bundler / `@parcel/*` / svelte / undici
  via devDep `@vercel/node`) and do not affect the bundled extension or
  Vercel-deployed runtime. `npm audit fix --force` was explicitly
  rejected because it would regress `plasmo 0.90.5 → 0.50.1`.

### Tests

- Full suite: 1052 passing, 4 skipped, 0 failing (+14 new tests).

## [1.3.1] — unreleased

Version bumped in `package.json` mid-cycle but never tagged on GitHub.
The work that landed under this number (auth bridge for antaresscan.com,
CORS hardening, manifest description fit for CWS 132-char limit, copy
rewrite after Yellow Argon rejection, mature-pair scoring fix, perf
Redis -75% commands, API error envelope fix, input validation before
rate-limit) is rolled into [1.3.2] above.

### Changed — payment provider: Solana Pay → NOWPayments
- **Why.** Solana Pay was native-crypto-only (USDC/SOL on Solana
  wallets like Phantom). Most non-crypto-native users hit a wall:
  they had to install a Solana wallet, fund it, and sign a tx — too
  much friction. NOWPayments is a hosted-checkout aggregator that
  accepts 200+ cryptos (BTC, ETH, USDT-Tron, BNB, USDC-anything,
  SOL, etc.) on a page the user just clicks through.
- **What changed.**
  - `api/payment-intent.ts` — calls NOWPayments
    `POST /v1/invoice` instead of building a Solana Pay URL. Same
    request contract, only `payUrl` shape changes (now an
    `https://nowpayments.io/payment?iid=...` URL).
  - `api/payment-status.ts` — polls NOWPayments via
    `GET /v1/payment/{id}` instead of reading on-chain transfers via
    Helius RPC. Lazy-confirms intents in the same response.
  - `api/auth/[action].ts` — new `nowpayments-ipn` action (POST)
    receives webhook callbacks, verifies HMAC-SHA512 signature,
    flips tier + issues license. Routed through the auth dispatcher
    rather than its own file so we stay under the 12-fn Vercel cap.
  - `api/cron-check-payments.ts` — same daily safety-net role, now
    reconciles via NOWPayments `getPayment` instead of Helius RPC.
- **New libs.**
  - `api/_lib/nowpayments.ts` — REST client (createInvoice,
    getPayment, listPaymentsForInvoice) + canonical-form HMAC-SHA512
    IPN signature verifier.
  - `api/_lib/payments.ts` — provider-agnostic intent store
    (replaces `solana-pay.ts`). Keys an intent by reference, by
    NOWPayments payment_id, and by invoice_id for fast IPN lookup.
  - `api/_lib/payment-confirm.ts` — shared `confirmIntent()` helper
    invoked by polling, IPN webhook, and cron. Idempotent on the
    same reference, anti-underpay (rejects when reportedUsd is below
    99% of intent.amountUsd), single source of truth for the side
    effects (tier flip + license issuance + index update).
- **Security hardening.**
  - **HMAC-SHA512 verification** on every IPN callback — fail closed
    when `NOWPAYMENTS_IPN_SECRET` is unset or signature mismatches.
  - **Anti-underpay** — IPN, polling and cron all pass the provider-
    reported price to `confirmIntent`, which rejects below the 99%
    threshold (covers the partially-paid → finished corner case).
  - **Rate limiting** on both `/api/payment-intent` (anti-DoS on
    invoice creation, which costs us NOWPayments API quota) and
    `/api/auth/nowpayments-ipn` (anti-spam on bad-signature flood).
- **Removed.** `api/_lib/solana-pay.ts` and its 3 tests
  (`solana-pay.test.ts`, `api-payment-intent.test.ts`,
  `api-payment-status.test.ts`, `api-cron-check-payments.test.ts`)
  — replaced with `api-payment-intent.test.ts` (new contract),
  `nowpayments.test.ts` (HMAC + status mapping), and
  `api-nowpayments-ipn.test.ts` (full IPN webhook flow).
- **Required env vars** (must be set in Vercel before this deploy
  can mint invoices):
  - `NOWPAYMENTS_API_KEY` — server API key from the dashboard.
  - `NOWPAYMENTS_IPN_SECRET` — IPN secret from the dashboard.
  - `ANTARES_PUBLIC_BASE_URL` — `https://antares-extension.vercel.app`
    (used to build IPN callback + success URLs).
  - Optional: `ANTARES_PRICE_MONTHLY_USD` /
    `ANTARES_PRICE_YEARLY_USD` (defaults 24.99 / 149.99). Legacy
    `SOLANA_PRICE_*_USDC` env vars are honoured as fallback to keep
    existing Vercel deployment values working through the cutover.
- **Required dashboard config.**
  - Settings → Store settings → IPN Callback URL:
    `https://antares-extension.vercel.app/api/auth/nowpayments-ipn`
  - Settings → Store settings → IPN Secret Key (matches the env var)
  - Recommended: Settings → Auto Conversion → USDT (eliminates
    crypto volatility exposure on the merchant side)
- **Tests.** Full suite: 925+ passed (added the IPN webhook flow,
  HMAC verification, status mapping, and rewrote the payment-intent
  + cron tests for the new contract).

### Added — dev mode: real-time tier toggle without redeploys
- **Problem.** Dev was getting quota-locked on his own install during
  daily work, and there was no way to flip between Free / Pro /
  Lifetime to verify what each tier sees in the overlay without
  editing Redis between switches.
- **`DEV_PRO_INSTALLS` env var** — comma-separated list of install_ids
  that are forced to lifetime tier server-side. `getUserTier()` short-
  circuits to lifetime for these, and `checkDailyQuota()` /
  `peekDailyQuota()` skip the counter. Set on Vercel, no
  redeploy needed for adds/removes (env vars hot-reload at function
  invoke time).
- **`X-Antares-Dev-Tier` request header** — when an install is in
  `DEV_PRO_INSTALLS`, the server trusts this header (`free | pro |
  lifetime`) over the default lifetime shortcut. Lets the dev flip
  tiers in real time without editing env vars between switches.
  Other installs sending the header have it silently ignored — the
  env var is the gate, not the header.
- **`getEffectiveTier(installId, headerRaw)`** in `api/_lib/user.ts`
  is the single resolution point. Both `/api/scan` and `/api/quota`
  now call it before the quota check.
- **Options page**:
  - **"This install" section** — shows the install_id with a Copy
    button. Needed for putting the id into the
    `DEV_PRO_INSTALLS` env var.
  - **"Dev mode" section** — Force-tier select (Off / Free / Pro /
    Lifetime), stored in `chrome.storage.local`. When non-Off, the
    scanner adds the header to every scan request, with a yellow
    warning banner reminding the dev that the override is active.
- **Scanner + background.ts** — both now read the dev-tier from
  storage and attach the header when set.
- 19 new tests covering the env-var gate, header parsing
  (case-insensitive, trimmed, array-shaped), priority order
  (header > shortcut > stored tier), and quota bypass. 908/908 passing.

### Added — accounts: email + password sign up, login, session cookies
- **Real auth on the API.** The license-key-only flow worked but
  required the buyer to keep the key safe forever. Accounts are the
  proper handle: log in once, see your licenses + tier on
  /account.html without re-entering anything.
- **`api/_lib/account.ts`** — scrypt password hashing (no extra deps,
  uses `node:crypto`), HMAC-SHA256 JWT sessions (also `node:crypto`),
  Redis-backed account records (`account:<email>` HASH).
- **`api/_lib/session-cookie.ts`** — HTTP-only cookie helpers with
  `SameSite=None; Secure` so the cookie set by the API origin flows
  on cross-site fetches from the website.
- **CORS middleware** updated to send `Access-Control-Allow-Credentials:
  true` + `Vary: Origin` so cookies actually work cross-origin.
- **4 new endpoints**:
  - `POST /api/auth/signup` — `{email, password}` → 200 + Set-Cookie,
    409 already_exists, 400 invalid_email/weak_password
  - `POST /api/auth/login` — same shape, 401 on bad creds (constant-
    time + dummy-hash defence against email enumeration)
  - `POST /api/auth/logout` — clears the cookie
  - `GET  /api/auth/me` — returns `{email}` from cookie or 401
- **`/api/account-licenses` accepts a session cookie** as auth (no
  proof-key needed when logged in). Legacy email + license-key path
  still works for buyers who haven't created an account yet.
- **`/api/payment-intent` auto-fills email** from the session cookie
  when present, so logged-in buyers don't have to re-type it.
- **`SESSION_SECRET` env var** required (32+ chars, e.g. `openssl rand
  -hex 32`). Endpoints surface 503 "Auth not configured" if unset.
- 52 new tests (account module, session-cookie helpers, 4 auth
  endpoints) covering hashing, signing, CRUD, login outcomes,
  cookie attrs. 889/889 passing.

### Fixed — extension stops working when daily quota hits 25 (silent box hide)
- **Bug**: a Free user hitting the 25-scan/day cap saw the API return
  429, the scanner retry 3× through exponential back-off, then the
  catch block silently hide the overlay. To the user the extension
  just looked broken on the 26th scan with zero context.
- **New `QuotaExhaustedError`** thrown by `fetchWithRetry` when a 429
  carries quota headers showing `remaining=0` (vs a generic 429 burst
  which is recoverable via retry). Distinguishes the two cases at the
  network layer so the caller can render the right UX.
- **New `buildQuotaExhaustedNode(quota)`** in `components.ts` — renders
  a dedicated overlay with `OUT OF SCANS` headline, `25 / 25 today`
  counter, a live "Resets in Xh Ym" countdown that ticks every 30s, a
  short pitch ("Pro = unlimited scans + AI Summary + Critical Flags +
  Full Analysis"), and a primary brand-green `⚡ Get Pro — unlimited
  scans →` CTA opening `/pricing?install=<id>`.
- **`scan()` catch block** now branches on `QuotaExhaustedError` to
  render the new overlay instead of hiding the box. The box stays
  visible, the user knows exactly why, and the upgrade link is one
  click away.
- 9 new tests in `quota-exhausted-overlay.test.ts` covering headline,
  counter, reset countdown (future / past / missing), CTA target,
  Pro-unlock copy, header badge. 837/837 passing.

### Added — license-key flow: site-direct buyers + portable Pro across installs
- **Email + license-key model.** /api/payment-intent now accepts an
  `email` field (required for visitors who haven't installed the
  extension yet, optional alongside `install_id` for extension users).
  When the on-chain payment confirms, the server issues a license key
  in the format `ANT-XXXX-XXXX-XXXX-XXXX` (80 bits of entropy,
  Crockford-base32 alphabet, visually unambiguous).
- **New `api/_lib/license.ts` module** — generation, Redis-backed
  storage, idempotent `issueLicense()` (cron retries + lazy-poll
  retries don't duplicate keys per intent), `getLicensesByEmail()`,
  and `redeemLicense()` which atomically marks the license claimed +
  flips the install's tier.
- **New `POST /api/redeem`** — `{license_key, install_id}` → flips
  that install's tier. Idempotent reclaim for the same install,
  409 `already_redeemed` for a different install.
- **New `POST /api/account-licenses`** — `{email, license_key}` →
  list every license owned by that email. The license key acts as
  proof of ownership (no passwords, no sessions). Returns 403 on
  email/key mismatch so attackers can't enumerate which emails have
  ever bought.
- **Cron + lazy-poll both issue licenses** when a confirmed intent
  carries an email. The lazy-poll path also returns the license key
  in `/api/payment-status` so the pricing modal can show it as soon
  as the on-chain check lands, without waiting for the cron tick.
- **Synthetic install_ids** (`email:foo@bar.com`) when a buyer pays
  before installing. The cron skips the spurious `setUserTier()`
  write on those — the user redeems via their license key once they
  install. Real extension installs continue to get tier flipped
  immediately.
- **New "Redeem a Pro license" UI in the options page**. Paste the
  ANT-XXXX-XXXX-XXXX-XXXX key, click Redeem, watch the tier unlock.
  Friendly errors for not-found / already-redeemed / invalid format.
- 43 new tests across `license.test.ts`, `api-redeem.test.ts`,
  `api-account-licenses.test.ts` plus 5 new payment-intent tests
  for the email path. 828/828 passing.

### Changed — Pro v1 monetisation: AI Summary, Critical Flags, Full Analysis gated to paid tiers
- **The 3-button overlay footer (Critical Flags / Full Analysis / AI Summary)
  is now Pro/Lifetime only — but stays *visible* to Free users.** Free
  users still see all three buttons (so they know what they're missing —
  invisible features don't sell upgrades), but the buttons are dimmed,
  carry a small "PRO" lock-pill, and clicking any of them opens
  `/pricing?install=<id>` instead of activating the underlying feature.
- The verdict + score + the 5 stat checks (Sell / Mint / Freeze / LP / Liq)
  remain visible and fully active for Free — those are the core rug-detection
  signal and stay free forever. The deep-dive layers (the "why" behind
  the verdict, the AI explanation, the full token analysis page) move
  to paid.
- Gating in `components.ts` keys on `data._quota.tier === "free"`
  specifically. Pre-quota cached responses or anonymous requests where
  `_quota` is absent default to the unlocked footer — we don't downgrade
  paying users whose response just happens to be missing the headers.
- `attachClose` and `attachAnalysisBtn` skip the clone-and-rebind path
  when they encounter `.locked`, so the build-time upgrade redirect
  listener stays in place and clicks short-circuit to /pricing without
  ever reaching `toggleAiSummary` / `toggleCriticalFlags`.
- 7 tests in `xss-regression.test.ts` covering Free / Pro / Lifetime /
  missing-quota footers, lock-pill rendering, and panel containers
  staying addressable for both tiers. 780/780 passing.

### Changed — Free tier quota tightened (50 → 25 scans/day)
- **`FREE_TIER_DAILY_LIMIT` lowered from 50 to 25.** 50 was generous to the
  point of removing any pull toward upgrade — most active users were finishing
  their session before getting close to the cap. 25/day is still enough to
  scan a full session of new launches, but creates a real reason to convert.
- Updated quota header math, store-listing copy (EN + FR), and tests.

### Added — pay with native SOL alongside USDC
- **`/api/payment-intent` now accepts `token: "usdc" | "sol"`** (default
  `usdc`). USDC continues the existing SPL-transfer flow; SOL routes through
  a new native-transfer path with the SOL/USD rate locked at intent creation.
- **New helpers** in `api/_lib/solana-pay.ts`:
  - `getSolPriceUsd()` — Jupiter v4 price endpoint, returns 0 on any failure
    so the caller can short-circuit cleanly
  - `resolveAmount(tier, token)` — returns `{ amount, amountUsd, splTokenMint }`,
    rounds SOL up to 4 decimals (`Math.ceil`) so the user never under-pays the
    target USD price
  - `verifySolTransfer()` — pre/post lamport delta check on the recipient
    account, mirrors the USDC tolerance (≥ 99% of expected amount)
- **`checkIntentOnChain()`** dispatches on `splTokenMint` (null = native SOL,
  set = SPL token), so the cron + status polling are token-agnostic.
- **Failure mode**: when Jupiter is down at intent creation, the endpoint
  returns 502 with `error: "sol_rate_unavailable"` so the frontend can
  surface a "try USDC instead" fallback without retrying blindly.
- **Pricing unchanged**: $24.99 / 30 days, $149.99 lifetime — SOL amount is
  the USD price ÷ live SOL/USD rate, recomputed per intent.
- **Tests**: 5 new `verifySolTransfer` cases, 5 new `resolveAmount` cases, 3
  new `/api/payment-intent` integration tests (SOL path, unknown token
  rejection, sol_rate_unavailable error). 773 / 773 total passing.

### Removed — watchlist feature
- **Watchlist removed entirely.** A list of token addresses without alerts
  or notifications is just stored strings — no actionable value over the
  scan history we already keep. Better to ship nothing than ship a
  half-feature users can't actually use.
- Deleted: `api/watchlist.ts`, `contents/modules/watchlist.ts`, the watchlist
  primitives in `api/_lib/user.ts` (`addToWatchlist`, `removeFromWatchlist`,
  `getWatchlist`, `getWatchlistCount`, `watchlistMaxFor`, related types and
  storage keys), the `★ Watchlist` toggle button + panel in the overlay
  footer, the `.wl-*` CSS, mutex references in AI Summary / Critical Flags.
- Tests removed: `__tests__/api-watchlist.test.ts`, `__tests__/watch-btn.test.ts`,
  watchlist test blocks in `user.test.ts`.
- Pricing tier docs updated: 30-day Pro Pass and Lifetime no longer
  advertise a watchlist; the differentiation is on unlimited scans, scan
  history, detailed scoring breakdown, priority cache, exports, and clean
  UI (no affiliate prompts).
- 759 / 759 tests passing after removal (down from 798 — only watchlist
  tests removed, no functional regressions).

### Changed — payments switched to Solana Pay direct on-chain
- **Removed Lemonsqueezy.** The previous skeleton was never wired in
  production (no env vars set, no charges) — replacing it with a direct
  on-chain flow that has zero middleman, zero KYC, zero commission beyond
  Solana network gas (~$0.0001 per tx).
- **New direct-on-chain payment flow** using the Solana Pay protocol:
  user clicks "Subscribe" → server creates a payment intent with a fresh
  reference Pubkey → page renders the intent as a QR code + Phantom
  deep-link → user signs USDC SPL transfer → on-chain confirmation flips
  the user's tier.
- **New library** (`api/_lib/solana-pay.ts`):
  - `generateReferenceKey()` — 32 random bytes, base58-encoded (custom
    encoder, no extra dependency)
  - `buildPayUrl()` — Solana Pay-spec URL builder (`solana:` scheme)
  - `createPaymentIntent()` / `getPaymentIntent()` — Redis-backed CRUD
    with TTL, plus a pending-set index for cron iteration
  - `verifyTokenTransfer()` — pure function checking pre/post token
    balance delta on the recipient's account, with 1% rounding tolerance
  - `checkIntentOnChain()` — Helius RPC integration that pulls
    transactions involving an intent's reference key and validates them
- **3 new endpoints**:
  - `POST /api/payment-intent` — creates an intent, returns the Solana Pay URL
  - `GET  /api/payment-status?reference=<id>` — polled by the pricing
    page to detect settlement
  - `GET  /api/cron-check-payments` — Vercel cron, runs every minute,
    checks pending intents on-chain, sets tier on confirmation
- **`vercel.json`** registers the cron at `* * * * *` (every minute).
- **Pricing**: 30-day Pro Pass at $24.99 USDC, Lifetime at $149.99 USDC
  one-time. Prices are env-overridable (`SOLANA_PRICE_PRO_USDC`,
  `SOLANA_PRICE_LIFETIME_USDC`) so they can be tweaked without a redeploy.
- Crypto has no native auto-renewal, so the user pays again to extend the
  Pro pass; `user.ts` auto-downgrades after expiry.

### Configuration — env var deltas
Removed (Lemonsqueezy, never wired):
  `LEMONSQUEEZY_WEBHOOK_SECRET` `LEMONSQUEEZY_STORE_DOMAIN`
  `LEMONSQUEEZY_VARIANT_PRO`    `LEMONSQUEEZY_VARIANT_LIFETIME`

Added (Solana Pay):
  `SOLANA_RECIPIENT_WALLET`         — base58 address that receives USDC payments
  `SOLANA_PRICE_PRO_USDC`           — defaults 24.99
  `SOLANA_PRICE_LIFETIME_USDC`      — defaults 149.99
  `CRON_SECRET`                     — manual-trigger bearer for /api/cron-check-payments

Already used elsewhere, reused here:
  `HELIUS_API_KEY`                  — for the on-chain verification queries

Until `SOLANA_RECIPIENT_WALLET` is set, every gated path degrades cleanly:
  `/api/payment-intent`             → 503 + `{error:"checkout_not_configured"}`
  `/api/cron-check-payments`        → 503 helius_unavailable / storage_unavailable
  pricing.html                      → "Coming soon" + waitlist fallback

### Tests
- 62 new tests across `solana-pay.test.ts`, `api-payment-intent.test.ts`,
  `api-payment-status.test.ts`, `api-cron-check-payments.test.ts`
- 791 / 791 total passing, coverage 75.07% branches (above 73% threshold)

### Recovered
- The watchlist-panel commit lost in the squash race during PR #374 merge
  (pushed 33 minutes after the squash landed). Includes the full `★
  Watchlist` disclosure panel, mutex with AI Summary / Critical Flags,
  panel CSS, and 17 dedicated tests.

## [1.3.0] - 2026-05-02

### Added — Pro tier launch
- **Daily scan quota for Free tier (50 scans / UTC day)** with midnight reset.
  Pro and Lifetime tiers are unlimited (still subject to the 30 req/min anti-abuse
  rate limit). Quota state surfaces via `X-Antares-Quota-*` response headers;
  Redis outages fail open so the Free tier never gets locked out by transient
  upstream blips.
- **User storage primitives** (`api/_lib/user.ts`) covering tier read/write
  (with auto-downgrade after `tierExpires`), scan history (LPUSH + LTRIM 0 999,
  30-day read window), and tier-capped watchlist (ZSET with `addedAt` as score).
  Free: 5 watchlist items, 10 history entries. Pro/Lifetime: 50 / 100.
- **New API endpoints**:
  - `GET  /api/quota`        — read-only quota status (no counter increment).
  - `GET  /api/watchlist`    — list; `POST` to add; `DELETE` to remove.
                              402 Payment Required on limit_reached so the UI
                              can route to `/pricing`.
  - `GET  /api/history`      — last N scans, free 10 / pro 100, 30-day window.
  - `GET  /api/checkout`     — builds a Lemonsqueezy checkout URL with
                              `install_id` baked into custom_data.
  - `POST /api/webhook-lemonsqueezy` — verifies LS HMAC and flips user tiers
                              on subscription / order events. Fails closed
                              when `LEMONSQUEEZY_WEBHOOK_SECRET` is unset.
- **Quota status badge** in the scan overlay header — dim "12/50" by default,
  yellow at ≤ 5 remaining, red "0/50 → PRO" link when capped (click opens the
  pricing page with `install_id` baked into the query string), green "PRO" /
  "LIFE" badge for paid tiers.
- **"+ Watch" button** in the overlay footer adds the current token to the
  user's watchlist with full visible feedback for every outcome (added,
  already-present, limit-reached → upgrade link, anonymous, network failure).
- **Photon affiliate row** on SAFE tokens for Free users only — gated by
  `PLASMO_PUBLIC_PHOTON_REF` build-time env var (hidden by default until we
  sign up for the program). Pro/Lifetime users get a clean overlay with no
  affiliate prompts as part of what they paid for.
- **Pricing page checkout integration** — when the extension's quota link
  appends `?install=<id>` to `/pricing`, the page swaps "Join waitlist" for
  real "Subscribe Pro" / "Get Lifetime" buttons that hit `/api/checkout` and
  redirect to Lemonsqueezy. Graceful degradation when checkout env vars are
  unset (503 → "Coming soon").

### Configuration
The following env vars wire the payment flow at deploy time. Until they're set
the relevant code paths fall back gracefully:
- `LEMONSQUEEZY_WEBHOOK_SECRET`     — HMAC signing secret from LS dashboard
- `LEMONSQUEEZY_STORE_DOMAIN`       — e.g. `antares.lemonsqueezy.com`
- `LEMONSQUEEZY_VARIANT_PRO`        — variant ID for Pro Monthly product
- `LEMONSQUEEZY_VARIANT_LIFETIME`   — variant ID for Lifetime product
- `PLASMO_PUBLIC_PHOTON_REF`        — affiliate handle (build-time)

### Tests
- 781 / 781 tests passing across 39 files
- Coverage: 75.12% branches, 79.83% statements (above 73% / 74% thresholds)
- New test files: `quota.test.ts`, `user.test.ts`, `lemonsqueezy.test.ts`,
  `watch-btn.test.ts`, `api-checkout.test.ts`, plus integration tests for
  each new endpoint

## [1.2.1] - 2026-04-27

### Changed — token page (frontend)
- Redesigned `token.html` around foldable, click-to-collapse sections
  with a unified `▸ LABEL ─ ▾` header pattern, replacing the previous
  fixed two-column layout. Every major section (Critical Flags, AI
  Verdict, Security, Holder Concentration, Market Data, On-Chain,
  Deep Analysis, Source Breakdown) is now independently foldable.
- New **Deep Analysis** widget with two tabs wired to existing API
  data: **Score Breakdown** (SVG radar pentagon over five dimensions —
  LP Security, Holder Distribution, Trading Authenticity, Token
  Maturity, Source Consensus) and **Exit Liquidity** (AMM-derived
  slippage tiers from `liquidity` USD).
- New **Source Breakdown** accordion: 1 row per upstream source with
  derived verdict (`OK` / `Risk` / `Flagged` / `N/A`), replacing the
  previous percentage bars.
- Token logo now sits top-right of the verdict h1 via `verdict-row`
  flex layout (`justify-content:space-between`).
- Custom inline-SVG tab icons (line stroke, `currentColor`) replace
  emoji glyphs for visual consistency with the rest of the UI.
- Severity dots (3-level indicator) added per critical-flag row.
- Cache-bust query: `/js/token-app.js?v=20260427a` to force browser
  reload of the new bundle.

## [1.2.0] - 2026-04-25

### Added — scale & resilience
- Per-fetch deadline with graceful degradation when one upstream stalls;
  the scan now returns a partial verdict instead of a 504 ([#275](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/275))
- Runtime Zod validation for upstream GoPlus, RugCheck and Helius
  responses; schema drift now silently drops a layer instead of
  feeding garbage into the scoring engine ([#276](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/276))
- Structured `scan.outcome` telemetry on every completed scan and
  `scan.cache_hit` telemetry on cache-hit paths ([#277](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/277), [#279](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/279))
- Rate limiting can now key on `(ip, install)` when the extension
  sends an `X-Antares-Install` header — closes the shared-NAT quota
  starvation ([#278](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/278), client emission [#284](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/284))

### Added — listing readiness
- Comprehensive **Supported platforms** section in `README.md` with
  every adapter and its purpose ([#280](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/280))
- GDPR-compliant privacy policy at `/privacy.html` covering every
  processor (Vercel, Upstash, Gemini, Sentry, the six data sources)
  and full data-subject rights; `/api/privacy` now 301-redirects to
  the canonical document ([#282](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/282))
- Security policy switched to GitHub Private Vulnerability Reporting
  with a real intake URL and concrete SLAs ([#281](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/281))

### Added — backtest harness
- J1 scaffold: type contract for time-travel scoring, auto-label rules
  (RUG / DANGER / SAFE) with multi-oracle ground-truth confidence, and
  34 unit tests covering the labeling logic ([#296](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/296))

### Changed
- Default `fetchJson` / `fetchJsonPost` `maxRetries` lowered from 2 to 1
  to fit the Vercel 10s function budget ([#273](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/273))
- `RugCheck /report` timeout lowered from 8000 ms to 5000 ms; the four
  Helius POST helpers now opt out of the second retry explicitly so
  worst-case latency stays under budget ([#274](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/274))
- AI summary panel rendering rewritten with the DOM API
  (`createElement` + `textContent`) instead of `innerHTML` — the local
  `escapeHtml` helper is gone because `textContent` is structurally
  safe ([#283](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/283))
- SPA navigation listeners are now idempotent and provide a
  `cleanupNavListeners()` that disconnects the `MutationObserver` and
  restores the original `history.pushState` / `replaceState` on
  toggle-off ([#285](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/285))
- Overlay components now build DOM via `createElement` + `replaceChildren`
  end-to-end (skeleton + result + scanner) instead of template literal
  `innerHTML` strings — the entire scan-result pipeline is now structurally
  XSS-safe by construction ([#291](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/291), [#292](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/292), [#295](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/295))
- Cache TTL is now **asymmetric by verdict**: bad verdicts (RUG / DANGER)
  cache for 30 / 10 min, good verdicts on young tokens cache for 20 s. A
  stale-bad verdict is safe (user does not buy); a stale-good verdict is
  dangerous (user buys based on stale data). ([#298](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/298))
- All 14 `console.log` calls in the AI summary path replaced with the
  structured `logger` so production logs ship to telemetry instead of
  the browser console ([#299](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/299))

### Performance
- `getRecentRugs` now uses Redis `MGET` instead of N pipelined `GET`s,
  cutting the rug-DB round-trip from O(N) to O(1) ([#293](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/293))
- Insider-graph layer caps at 20 holders + per-wallet signature cache,
  keeping Helius parallel pressure bounded on whale-heavy tokens ([#294](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/294))
- `token.html` extracts inline scripts to external files with a 1-year
  immutable cache header — eliminates render-blocking inline JS and
  enables CDN caching ([#290](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/290))

### Fixed
- Verdict label was interpolated unescaped into `<h1>${label}</h1>`,
  making an upstream-controlled `risk` field exploitable as XSS;
  every interpolation in `buildResult` is now escaped ([#283](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/283))
- Permanent `history.pushState` / `replaceState` wrappers leaked
  across extension toggle cycles, measurably slowing host SPAs over
  time ([#285](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/285))

### Removed
- `bullx.io` and `neo.bullx.io` from `host_permissions` and the API
  CORS allowlist — they had no adapter and were dead permission
  surface ([#280](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/280))
- `security@antares.boo` from `SECURITY.md` — non-resolving address
  replaced with the GitHub Private Vulnerability Reporting flow ([#281](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/281))
- `validators.ts` and its tests — dead code superseded by the Zod
  upstream-schemas introduced in #276 ([#297](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/297))
- Legacy `index.html` from the extension repo; root path now redirects
  to the marketing site at `antares-website.vercel.app` so the two
  surfaces don't compete for SEO / canonical ([#287](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/287))
- Dead landing-page e2e tests + scope-clarifying README pass for the
  repo split ([#289](https://github.com/COMEALAMAISONGROUPE/antares-extension/pull/289))

### Dependencies
- Bumped to current minor / patch ranges: `@sentry/browser` 10.50.0,
  `@sentry/node` 10.50.0, `prettier` 3.8.3, `@types/chrome` 0.1.40,
  `@vitest/coverage-v8` 4.1.5, `trufflehog` action 3.95.2.
- Added: `zod` 3.25.x as an explicit production dependency;
  `happy-dom` as a vitest devDep so extension content scripts can be
  unit-tested.

## [1.1.0] - 2026-04-08

### Added
- OHLCV v8 rug fingerprint patterns: Post-ATH dump, Dead Cat Bounce,
  Wick Trap, Rug Staircase, Micro-window pump
- Creator reputation detection (serial deployer flagging via Helius)
- Cross-validation layer with penalty multipliers (LP burn, mint
  authority, age, holder concentration)
- `lp_unverified` classification for mature tokens with unburned LP
- Smart LP maturity context (holders, liquidity, age thresholds)
- Deceptive name detection (financial institution impersonation)
- Adaptive cache TTL based on token age
- CI/CD pipelines: `ci.yml`, `release.yml`, `secret-scan.yml`,
  `submit.yml`
- Sentry error monitoring integration
- Shadow DOM font injection for extension overlay
- Bundle percentage extraction from RugCheck reports
- XSS sanitization helpers (`sanitizeString`, `sanitizeUrl`)
- Runtime type guards for all external API responses

### Changed
- Scoring engine: geometric weighted mean with diminishing penalties
- Layer weights centralised in `constants.ts`
- Cross-validation now applied as post-score multiplier
- `ESTABLISHED_HOLDERS_THRESHOLD` hardened from 1000 to 5000
- `ESTABLISHED_BONUS_MULTIPLIER` hardened from +15% to +5%
- Helius holder resolution: token accounts resolved to owner wallets
- LP program addresses expanded (Meteora DAMM v2, DBC, PumpSwap)

### Fixed
- LP not burned / locked now correctly blocks SAFE verdict
- Extreme 24h pump tokens (+1000-5000%) no longer pass as SAFE
- Tax between 2-10% now flagged (previously invisible)
- Low holders (<15) now a hard block reason
- Deceptive names now a hard block reason
- RugCheck layer with unmatched `safeBlocked` flags now classified
  correctly

### Removed
- Layer 7 (Identity / Copycat) removed due to massive false positives
