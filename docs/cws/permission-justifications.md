# Chrome Web Store — Permission Justifications

> Each `permissions` and `host_permissions` entry in `manifest` (generated
> from `package.json`'s `manifest` field) needs a one-line justification in
> the CWS dashboard. This file is the canonical text — paste each block
> verbatim into the matching field.
>
> Reviewers reject submissions that justify permissions vaguely or with
> filler ("for functionality"). Be specific about what the permission
> *enables in code*, not why the extension exists.

---

## API permissions

### `storage`

> Keeps on the user's device (chrome.storage.local, never synced): the
> on/off switch, the automatic re-scan setting, a
> randomly generated and opaque install identifier (sent with scans so
> the API can rate-limit per installation instead of per IP, and keep
> the scan history of that installation), the last verdict seen for
> each token (to detect that it got worse), the 10 most recent scans, a
> short-lived cache of up to 60 recent scan results (so the overlay
> shows instantly on a revisited token) and, when the user is signed in,
> the session token. No content from web pages is stored.

### `notifications`

> Shows a Chrome notification when a token the user scans gets a worse
> verdict than the last one seen on this device (for example CAUTION to
> DANGER). The Options page also has a "test notification" button, so a
> reviewer can see it without waiting for a verdict to change.

### `activeTab`

> Declared in the manifest but not used by the current version of the
> extension: no code calls it. Content scripts run on the eight trading
> platforms through host permissions, not through activeTab. Remove it
> from the manifest at the next release, or keep this line truthful.

### `alarms`

> One alarm, "keepalive", every minute. It is meant to keep the
> Manifest V3 background service worker from being stopped in the middle
> of a scan. It does not scan, re-scan, clean any cache or send anything.

### `tabs`

> Chrome presents this permission as "Read your browsing history".
> Two uses, both in the background service worker:
>   1. When the user clicks "Full Analysis", chrome.tabs.query looks at
>      the addresses of the open tabs to find out whether the analysis
>      page is already open; if it is, that tab is reused instead of
>      opening a second one.
>   2. When the user switches the extension on or off, the change is
>      passed to the open tabs (only their identifiers are used).
> Addresses are compared on the device; none is stored or sent.

---

## Host permissions

The extension declares host permissions only for the trading platforms it
is *designed* to scan. It does **not** request `<all_urls>` or any wildcard.

### `https://dexscreener.com/*`

> Detects Solana contract addresses on DexScreener token / pair pages and
> overlays the verdict in-place. DexScreener is the largest aggregator
> for Solana tokens; without this host permission the extension would
> miss most of the tokens users want to scan.

### `https://pump.fun/*`

> Same address-detection + overlay role on pump.fun, the dominant Solana
> launchpad for memecoins. Without this permission users couldn't scan
> pre-graduation tokens at the moment of highest rug risk.

### `https://axiom.trade/*`

> Address detection + overlay on Axiom Trade, a Solana DEX aggregator
> popular with retail traders.

### `https://photon-sol.tinyastro.io/*`

> Address detection + overlay on Photon, the Solana trading bot platform
> heavily used by speed-trading users who need scam screening before
> firing a buy.

### `https://birdeye.so/*`

> Address detection + overlay on Birdeye, a major Solana market-data
> aggregator. Users frequently follow links to Birdeye from Twitter
> shilling threads — exactly the moment a scam check matters.

### `https://www.geckoterminal.com/*`

> Address detection + overlay on GeckoTerminal, CoinGecko's on-chain
> token explorer.

### `https://gmgn.ai/*`

> Address detection + overlay on GMGN, a Solana on-chain analytics
> platform popular for tracking smart-money flows.

### `https://app.telemetry.io/*`

> Address detection + overlay on Telemetry, a wallet-tracking platform
> users browse to vet token deployers.

### Content script on Antares' own website: `https://antaresscan.com/*`, `https://www.antaresscan.com/*`, `https://antares-website.vercel.app/*`

These three are not in `host_permissions`: they are the `matches` of a second content script (`contents/antares-website-bridge.ts`),
and the built manifest lists them under `content_scripts`, so the dashboard shows them among the sites the extension can access.

> Antares' own website (the account and pricing pages). A small bridge
> script answers the site's request for the extension's anonymous install
> identifier (so a purchase activates the plan on this installation) and
> stores, or clears, the session token when the user signs in or out on
> the site, so the overlay shows the user's plan. It only accepts messages
> from these three origins, reads nothing from the page, and is the only
> script the extension runs outside the eight trading platforms.

---

## Single-purpose justification

> Antares has a single user-facing purpose: warning users about Solana
> tokens that look like rug pulls, honeypots, or coordinated scams,
> displayed as an in-page overlay on supported trading platforms.
>
> Every permission and host permission requested above directly serves
> that purpose. The extension does not perform analytics, ad injection,
> tracking, or any unrelated function.

---

## Privacy practices summary

  • Personally identifiable information collected:        **none**
  • Health information collected:                          none
  • Financial / payment information collected:             none
  • Authentication information collected:                  none
  • Personal communications collected:                     none
  • Location data collected:                               none
  • Web history collected:                                 none
  • User activity collected:                               none
  • Website content read:                                  yes — public token addresses on supported trading sites only
  • Data sold to third parties:                            no
  • Data used or transferred for purposes unrelated to
    the extension's single purpose:                        no
  • Data used or transferred to determine creditworthiness
    or for lending purposes:                               no

Privacy policy URL: https://antaresscan.com/privacy

---

## Payment processor disclosure

Pro and Yearly upgrades are processed via **NOWPayments**, a
non-custodial cryptocurrency payment aggregator. There is no
card-payment processor, no KYC step on the user side, and no
billing data ever flows through the extension or our infrastructure.

The flow:

  1. User clicks "Subscribe" on `/pricing`
  2. Our server creates a NOWPayments invoice (`POST /v1/invoice`)
     and returns the invoice URL to the website
  3. User is redirected to the NOWPayments hosted checkout page,
     where they pick a cryptocurrency from 200+ supported options
     (BTC, ETH, USDT, USDC, SOL, BNB, etc.) and complete payment
     directly to a NOWPayments-managed deposit address
  4. NOWPayments fires a signed IPN webhook to our backend
     (`POST /api/auth/nowpayments-ipn`) with the on-chain transaction
     hash and payment status. We verify the HMAC-SHA512 signature
     against our IPN secret, sanity-check the reported amount
     matches the invoice (anti-underpay defence), and flip the
     user's tier in Redis. A daily cron (`/api/cron-check-payments`)
     reconciles any missed webhooks via NOWPayments' API.

What we receive in payment metadata:
  - NOWPayments invoice + payment IDs
  - The on-chain transaction hash (public on the chain the buyer
    chose, useful for audit / refund traceability)
  - The USD-equivalent amount NOWPayments converted (we set
    `is_fixed_rate: true` so the buyer locks in the USD price at
    checkout time)
  - Optional auto-conversion to USDT if enabled in our NOWPayments
    dashboard settings

What we **never** see or store:
  - Card numbers, banking info, billing address (no fiat rails
    involved)
  - The user's source wallet address (NOWPayments handles the
    deposit address; we only see the public on-chain tx hash)
  - Any link between the payment and the user's identity beyond
    the opaque install identifier they generated locally on first
    run, or the email they optionally provided to receive a
    redeemable license key
