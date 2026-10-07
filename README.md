# Antares — Anti-Scam Scanner for Solana

[![CI](https://github.com/antaresscan/antares-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/antaresscan/antares-extension/actions/workflows/ci.yml)

**Antares** is a Chrome extension that automatically detects the Solana token address on any page you visit and runs a real-time multi-source security scan. The verdict appears in a draggable overlay — `SAFE / CAUTION / DANGER / RUG` with a 1000-point composite score and the reasons behind it — without you ever pasting a contract address, switching tabs, or signing anything.

> **Marketing landing site lives in a separate repo:**
> [github.com/antaresscan/antares-website](https://github.com/antaresscan/antares-website) → deployed at <https://antares-website.vercel.app/>.
> This repo only ships the extension itself, the backend API at
> `antares-extension.vercel.app/api/*`, and the in-extension utility
> pages (`/privacy.html`, `/token.html`). The bare `/` here 301-redirects
> to the marketing site.

> **Supported chain: Solana only.** Ethereum and BNB chain support is on the roadmap — see [#120](https://github.com/antaresscan/antares-extension/issues/120).

---

## What it does

- Detects mint/freeze authority, honeypots, blacklists and proxy contracts (GoPlus)
- Checks LP burn/lock status, bundler activity, and holder concentration (RugCheck)
- Analyses on-chain holder distribution + creator history (Helius)
- Detects chart manipulation patterns: parabolic pumps, blow-off tops, wash trading (DexScreener OHLCV)
- Verifies on-chain age, holder count, and trading patterns (Solscan)
- Cross-validates data across sources to flag conflicts
- Surfaces top-3 critical actors (creator + cluster) and top-10 holder live activity
- Displays a verdict — **SAFE / CAUTION / DANGER / RUG** — with a 1000-point composite score

---

## Supported platforms

Antares injects a floating scanner overlay on the following trading
platforms. Each host is listed in `host_permissions` in `package.json`
solely to allow the content script to run on that origin; no user data
from those pages is collected or transmitted — only the Solana contract
address visible in the URL or page DOM.

| Host | Purpose | Adapter |
|---|---|---|
| `dexscreener.com` | Pair / token pages — extract CA from URL or fallback to Solscan links | `DexScreenerAdapter` |
| `birdeye.so` | Token pages with `/token/{CA}?chain=solana` | `BirdeyeAdapter` |
| `pump.fun` | Pump.fun token pages | `PumpAdapter` |
| `photon-sol.tinyastro.io` | Photon trading interface | `PhotonAdapter` |
| `axiom.trade` | Axiom trading interface | `AxiomAdapter` |
| `gmgn.ai` | GMGN token pages (`/sol/token/{CA}`) | `GMGNAdapter` |
| `app.telemetry.io` | Telemetry trading dashboard | `TelemetryAdapter` |
| `www.geckoterminal.com` | GeckoTerminal pool pages | `GeckoTerminalAdapter` |

The extension does **not** run on any other site. Adding a new platform
requires adding both a host to `host_permissions` and a matching adapter
in `contents/modules/adapters/`.

---

## Scoring engine

Score starts at **1000** and is reduced by weighted penalties across **6 weighted layers** plus a post-score cross-validation multiplier:

| Layer | Source | Weight | What it checks |
|---|---|---|---|
| L1 | DexScreener | 0.20 | Liquidity, volume, price changes |
| L2 | RugCheck | 0.20 | LP burn/lock, bundler activity, metadata, top holders |
| L3 | GoPlus | 0.20 | Honeypot, mint/freeze authority, tax, proxy contracts |
| L4 | Helius | 0.20 | On-chain holder distribution (top 1 / top 10), creator history |
| L5 | Solscan | 0.10 | Holder count, token age, wash trading patterns |
| L6 | Chart | 0.10 | OHLCV pattern analysis (pump, dump, wash, stair-step) |
| L8 | CrossValidation | — | Cross-source conflict detection (post-score multiplier) |

Layers 1–6 contribute weighted trust scores to the geometric mean. Layer 8 (CrossValidation) produces flags and penalty multipliers but does not feed the geometric mean directly.

A token can only reach **SAFE** (score ≥ 850) if it passes all critical gates regardless of score.

### Cache versioning

The scan-result Redis cache is keyed by `antares:${ENGINE_VERSION}:${ca}`, where `ENGINE_VERSION` combines a manual tag with an FNV-1a fingerprint of every scoring constant (`LAYER_WEIGHTS`, `XV_PENALTY_*`, `TRUST_FLOOR`, `ESTABLISHED_*`). **Any change to those constants flips the fingerprint, so all cached scores are silently bypassed and naturally TTL out.** No manual coordination needed when re-tuning the engine.

See `api/_lib/constants.ts` for the canonical version + fingerprint logic.

---

## Regression corpus

`__tests__/backtest/` keeps a corpus of about 1,500 Solana tokens: 18 picked
by hand and the rest found automatically in DexScreener, GeckoTerminal,
CoinGecko and Jupiter lists. For 504 of them a `/api/scan` response was
captured (a fixture), and CI checks that each stored verdict falls in the set
of verdicts the corpus tolerates for that token.

That is a **regression check, not a measure of accuracy**:

- It does not run the engine. A fixture is a response captured at some date, by
  whichever engine version was live then, with whatever data sources were
  working at that moment. It only changes when someone recaptures it.
- Labels of the automatically found entries come from DexScreener signals only
  (market cap, liquidity, age, 24h price change), and the tolerated verdicts
  are wide: a token labelled SAFE tolerates CAUTION, DANGER and RUG. "Every
  stored verdict is inside its band" is therefore close to true by
  construction, and says nothing about blue-chips or rugs.
- The corpus is kept by hand and has had errors: three hand-picked entries
  pointed at the wrong token until 2026-10-07, and 454 of its 1,495 distinct
  mints have no trading pair (mostly dead tokens).

Antares is a heuristic screen, not an oracle. A SAFE verdict means no layer
found a critical signal at scan time; it is not a guarantee. False negatives
happen: on 2026-10-07 an audit found a rug scoring SAFE while its holder data
was unavailable (fixed the same day).

A weekly job re-scans a rotating sample of 100 fixtures against production and
opens an issue when more than 5% moved. Numbers and method in
[BACKTEST.md](./BACKTEST.md).

---

## Pricing & accounts

Antares ships with three tiers. Free works without an account; paid tiers
need one for cross-device sync.

| Tier | Price | What you get |
|---|---|---|
| **Free** | $0 | Unlimited scans, verdict + score + Sell/Mint/Freeze/LP grid. Subject to per-minute rate limits. |
| **Pro** | $24.99 / 30 days | Everything in Free + Critical Flags panel, AI Summary, Full Analysis page (5 deep-dive tabs), Critical Actors top-3, Insider Watch, scan history, CSV/JSON export. |
| **Yearly** | $149.99 / year | Everything in Pro. Best value — pay 6 months, get 12. |

Payments are processed by **NOWPayments hosted checkout** — pay in any of
**200+ cryptocurrencies** (BTC, ETH, SOL, USDC, USDT, BNB, MATIC, DOGE…)
which auto-converts to USD on their side. We never touch a credit card,
key, or wallet directly.

### Cross-device sync

A single optional account (email + scrypt-hashed password + HMAC-SHA256
JWT session) carries your tier across every browser where you sign in.
There is **no manual license key paste** — paying with a logged-in
checkout auto-binds the license to your email, and any extension install
that authenticates with the same account inherits the tier on the next
scan.

The session sync uses two channels for resilience:
1. **Cookie** (cross-site, `SameSite=None; Secure`) for the account-host pages.
2. **JWT bridge** (`X-Antares-Session` header set by the website via a postMessage bridge into the extension) for the extension scan calls — required because Chrome 124+ phases out third-party cookies.

See `api/_lib/account.ts`, `api/_lib/session-cookie.ts`, and
`api/_lib/license.ts` for the full plumbing.

---

## Architecture

```
api/
  scan.ts                    — GET /api/scan?ca=<mint>          Main scoring pipeline
  graph.ts                   — GET /api/graph?ca=<mint>         Insider graph + activity feed
  history.ts                 — GET /api/history                 Pro-tier scan history
  quota.ts                   — GET /api/quota                   Per-install quota status
  rugs.ts                    — GET /api/rugs                    Confirmed-rug fingerprint cache
  health.ts                  — GET /api/health                  Liveness, live commit + scoring version, configured integrations

  payment-intent.ts          — POST /api/payment-intent         Create NOWPayments invoice
  payment-status.ts          — GET  /api/payment-status         Poll an in-flight payment
  cron-check-payments.ts     — Cron sweep to reconcile pending intents
  redeem.ts                  — POST /api/redeem                 Redeem a license key
  account-licenses.ts        — GET  /api/account-licenses       List a user's licenses

  auth/[action].ts           — Single dispatcher (Hobby 12-fn cap):
                                signup / login / logout / me / sync-token /
                                nowpayments-ipn (HMAC-SHA512 IPN webhook)

  _lib/
    constants.ts             — All constants: weights, penalties, ENGINE_VERSION
    types.ts                 — Shared TypeScript types
    helpers.ts               — Re-exports + utility / guard functions
    math.ts                  — Numeric helpers
    http.ts                  — Typed fetch + scrub-on-log of secret query params
    middleware.ts            — CORS (Host-validated), rate limiting, input validation
    cache.ts                 — Engine-versioned Redis scan cache
    logger.ts                — Structured leveled logger
    sentry.ts                — Idempotent Sentry init + captureError helper

    fetchers.ts              — DexScreener / RugCheck / GoPlus / Helius / Solscan
    layers.ts                — 6 analysis layer functions (pure)
    scoring.ts               — Geometric-mean scoring + cross-validation penalties
    pipeline.ts              — Post-layer flags, safe-gate, established bonus, verdict
    ai-summary.ts            — Gemini-powered 2-4 sentence verdict synthesis
    upstream-schemas.ts      — Zod-style guards for noisy upstream responses
    server-errors.ts         — Standard error responses
    known-treasuries.ts      — Foundation / DAO / LP wallet allowlists

    insider-graph.ts         — Top-holder cluster detection (Helius enhanced txns)
    insider-activity.ts      — Top-10 holder live activity feed (last 6h)
    holder-activity.ts       — Per-holder buy/sell flow
    critical-actors.ts       — Top-3 enriched actors (creator + cluster + insider)
    outcome-stats.ts         — Aggregated win/loss histogram
    verdict-history.ts       — Per-CA verdict-over-time
    rugdb.ts                 — Confirmed-rug write-once index

    account.ts               — Email/password account model (scrypt + JWT)
    session-cookie.ts        — Set/read session cookie + X-Antares-Session header
    user.ts                  — Per-install state (tier, quota counters)
    quota.ts                 — Daily quota check (Pro/Lifetime unlimited)

    license.ts               — License keys (ANT-XXXX-XXXX-XXXX-XXXX) + bind
    payments.ts              — Payment-intent persistence + indexes
    payment-confirm.ts       — Idempotent intent → license issuance + tier flip
    nowpayments.ts           — NOWPayments REST client + HMAC-SHA512 IPN verification

js/
  token-app.js               — Full Analysis page entry + render orchestrator (ES module)
  formatters.js              — Pure formatters (fmt, pct, age, escapeHtml, fmt{Usd,Tok}…)
  compute.js                 — Pure business logic (computeExitLiquidity, parsePctFromFlags)
  token-bg.js                — Animated background canvas

privacy.ts                   — GET /privacy — Privacy Policy page (CWS requirement)
token.html                   — Static Full Analysis page served at /token.html?ca=<mint>

background.ts                — Chrome extension service worker (MV3, keepalive via alarms)
popup.tsx                    — Extension popup UI (recent scans, stealth toggle, account)
options.tsx                  — Extension options page (stealth mode, auto-rescan)
contents/                    — Per-platform overlay adapters + scoring engine
```

---

## API

All endpoints are documented in code with examples. The most-used ones:

```
GET  /api/scan?ca=<mint>                Main scan, returns score / risk / flags / layers
GET  /api/graph?ca=<mint>&activity=1    Top-holder graph + 6h activity feed
GET  /api/history                       Pro-tier scan history (auth required)

POST /api/payment-intent                Create a NOWPayments invoice
GET  /api/payment-status?reference=…    Poll an in-flight payment
POST /api/redeem                        Redeem a license key against an install_id

POST /api/auth/signup                   Create an account
POST /api/auth/login                    Sign in
POST /api/auth/logout                   Sign out
GET  /api/auth/me                       Get current session
POST /api/auth/sync-token               Get JWT for the extension bridge
POST /api/auth/nowpayments-ipn          NOWPayments webhook (HMAC-SHA512 verified)
```

### Example

```bash
curl "https://antares-extension.vercel.app/api/scan?ca=So11111111111111111111111111111111111111112"
```

CORS is restricted to a whitelist of the supported trading platforms +
the marketing-site origin + `chrome-extension://*`. Same-origin requests
to the API host are admitted via the `Host` header (validated by Vercel
routing) — **not** the `Referer` header (which any non-browser client
can forge trivially with `curl -H Referer:`).

---

## Observability

- **Sentry** is wired across the entire payment + auth critical path
  (`payment-intent`, `redeem`, `auth/[action]` including `nowpayments-ipn`,
  `payment-status`, `cron-check-payments`, `account-licenses`, `scan`).
  The IPN webhook has a global try/catch wrapper so a transient Redis
  flake during license issuance doesn't silently leave a buyer
  paid-but-still-Free — Sentry captures, we return 500, NOWPayments
  retries (the confirmation logic is idempotent).
- The `http.ts` module **scrubs query-string secrets** (`api-key`,
  `token`, `secret`, `password`, …) from any URL string before it
  reaches the structured logger — Helius's `/v0/*` REST surface forces
  query-param auth (Bearer returns 401), so the leak vector existed by
  API design until this mitigation.
- Free-tier Sentry (5K events/month) covers the current production
  volume with 50× headroom at the default 10% trace sample rate.

---

## Stack

- Extension: [Plasmo](https://plasmo.com) + TypeScript (MV3)
- Backend API: Vercel Serverless (Node 22, Hobby — capped at 12 functions)
- Storage: Upstash Redis (sessions, intents, licenses, scan cache)
- Rate limiting: Upstash Ratelimit (sliding window 30 req/60s + burst 5 req/10s)
- Crypto checkout: NOWPayments hosted checkout (200+ cryptos, HMAC-SHA512 IPN)
- Auth: scrypt password hashing + HMAC-SHA256 JWT sessions (30-day TTL)
- Data sources: DexScreener · RugCheck · GoPlus · Helius · Solscan · GeckoTerminal
- Observability: Sentry (`@sentry/node` + `@sentry/browser`)
- AI synthesis: Google Gemini 2.5 Flash (optional, scans work without it)
- Tests: Vitest (1029 tests across 55 files) + Playwright e2e
- Security: CORS host-whitelist, rate-limited mutations, CodeQL weekly scans,
  Dependabot alerts, scrubbed secret logs

---

## Development

```bash
npm ci
npm run dev        # extension hot-reload
npm run build      # production build
npm run test       # run all tests (Vitest, ~17s)
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
```

E2E tests:
```bash
npm run test:e2e   # Playwright, requires CHROME_TEST_HOST=… for live runs
```

Backtest corpus management:
```bash
npm run corpus:capture   # rebuild from /api/scan against the live corpus
npm run corpus:refresh   # re-scan + diff for drift detection
npm run corpus:discover  # find new high-traffic tokens to add
npm run test:corpus      # run corpus regression suite only
```

---

## Environment variables (Vercel)

Copy `.env.example` to `.env.local` and fill in your values.

### Core (required)

```
HELIUS_API_KEY=...                   # Helius RPC + Enhanced Transactions API
UPSTASH_REDIS_REST_URL=...           # Upstash Redis URL
UPSTASH_REDIS_REST_TOKEN=...         # Upstash Redis token
ANTARES_API_KEY=...                  # Chrome extension auth (X-Antares-Key)
SESSION_SECRET=...                   # 32+ chars, openssl rand -hex 32
                                       (bootstraps from UPSTASH_REDIS_REST_TOKEN
                                        if missing — set explicitly ASAP; see
                                        the doc-block at the top of
                                        api/_lib/account.ts for the rationale)
```

### Crypto checkout (required for paid tiers)

```
NOWPAYMENTS_API_KEY=...              # NOWPayments dashboard → Settings
NOWPAYMENTS_IPN_SECRET=...           # IPN secret from same dashboard
ANTARES_PUBLIC_BASE_URL=https://antares-extension.vercel.app
                                     # API host — used to build IPN callback URL
ANTARES_WEBSITE_URL=https://antares-website.vercel.app
                                     # Marketing site host — used to build
                                       success/cancel redirects (account.html
                                       lives there, NOT on the API host)
ANTARES_PRICE_MONTHLY_USD=24.99      # Override default Pro price
ANTARES_PRICE_YEARLY_USD=149.99      # Override default Yearly price
ANTARES_SUCCESS_URL=...              # Optional, defaults to {WEBSITE}/account.html?ref=<ref>
ANTARES_CANCEL_URL=...               # Optional, defaults to {WEBSITE}/account.html?cancelled=1
```

### Optional

```
SOLSCAN_API_KEY=...                  # Solscan Pro (Layer 5 enrichment)
SENTRY_DSN=...                       # Error monitoring (free tier 5K events/mo)
GEMINI_API_KEY=...                   # AI summary synthesis
AI_MODEL=gemini-2.5-flash            # Override the Gemini model
VERCEL_TIMEOUT=9000                  # Per-fetch budget cap in ms
```

---

## Contributing

1. Clone the repo and run `npm ci`
2. Make your changes
3. `npm run test` — all 1029 tests must pass
4. `npx tsc --noEmit` — zero type errors
5. `npm run lint` — zero lint errors
6. One commit per logical block, message format: `feat(scope): description`
7. Open a PR against `master`. CI (build + e2e + secret scan + Vercel preview) must be green before merge.

---

## License

MIT
