# Changelog

All notable changes to the Antares Extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
