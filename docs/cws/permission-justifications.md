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

> Used to persist a randomly-generated, opaque install identifier across
> browser sessions so the API can rate-limit per-installation rather than
> per-IP (which would punish users behind shared NAT). Also caches scan
> results locally so the overlay shows instantly on revisited tokens.
> Never stores personal data, credentials, or content from web pages.

### `notifications`

> Reserved for the upcoming Pro v2 feature (real-time alerts when a
> watch-listed token crashes more than -30 % in the last hour or a
> dev wallet starts dumping). The permission is declared in advance so
> users grant it once at install rather than mid-session via a future
> update prompt. No notifications fire in v1.3.0.

### `activeTab`

> Lets the content script read the URL and DOM of the *currently focused
> tab on a supported trading platform* (DexScreener, pump.fun, etc.) to
> detect Solana contract addresses. Granted only on user interaction
> (extension icon click or page navigation on a host-permitted domain).
> The script does not read form fields, cookies, or credentials.

### `alarms`

> Schedules:
>   1. The 5-second forced rescan when a token drops more than 30 %/hour
>      so the overlay reflects post-crash state.
>   2. Periodic clean-up of the local scan cache to bound storage usage.
> Required because content scripts cannot use long-lived `setTimeout` in
> Manifest V3 service workers without losing the timer on idle eviction.

### `tabs`

> Required by `chrome.tabs.create` / `chrome.tabs.update` in the
> background service worker, which the "Full Analysis →" button uses to
> open `token.html?ca=<address>` and update an existing analysis tab in
> place rather than spawning a new tab on every click. Without this
> permission the deep-dive UX would leave a stack of stale analysis tabs
> behind every token the user scans.

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

Privacy policy URL: https://antares-website.vercel.app/privacy

---

## Payment processor disclosure

Pro and Lifetime upgrades are processed **directly on the Solana
blockchain** via the Solana Pay protocol. There is no third-party
payment processor, no KYC step, and no card-payment data ever flows
through the extension or our infrastructure.

The flow:

  1. User clicks "Subscribe" on `/pricing`
  2. Our server generates a unique reference key + Solana Pay URL
     (USDC SPL transfer to a fixed merchant wallet)
  3. User signs the transaction in their preferred Solana wallet
     (Phantom, Solflare, Backpack, etc.) — funds move directly from
     the user's wallet to ours, no intermediary
  4. Our cron job verifies the on-chain transaction via Helius RPC
     (recipient + token mint + amount match) and flips the user's
     tier in Redis

What we receive in payment metadata:
  - The on-chain transaction signature (public on Solana, useful for
    audit / refund traceability)
  - The amount received (in USDC, pegged to USD)

What we **never** see or store:
  - Card numbers, banking info, billing address (no fiat rails involved)
  - The user's wallet address other than as the tx sender (and only
    transiently — we don't index by it)
  - Any link between the payment and the user's identity beyond the
    opaque install identifier they generated locally on first run
