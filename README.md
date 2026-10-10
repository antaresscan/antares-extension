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

- Reads the **mint and freeze authorities from the chain itself** (Helius `getAccountInfo`); GoPlus is the cross-check, and relays them when the chain cannot be read. An authority that could not be verified is shown as *not verified*, never as passed
- Says whether **the token itself can stop a holder from selling** (non-transferable, a freeze authority, risky Token-2022 extensions). A pool-level honeypot is not measured: no Solana source reports it, and the Sell cell shows "—" instead of a tick when a sale cannot be verified
- Checks the **LP burn/lock** (GoPlus pool data weighted by each pool's TVL, RugCheck) and reads RugCheck's own risk list (creator history of rugs, permanent delegate, mutable metadata, copycat…)
- Counts **holders** (exact from the chain up to 10,000, then GoPlus / RugCheck) and measures **concentration** (top 1 / top 10, with liquidity pools and foundation wallets left out) from Helius
- Reads market behaviour from DexScreener and GeckoTerminal: liquidity, volume, price moves, parabolic pumps, dumps, wash volume
- Cross-validates the sources and flags conflicts
- Shows the creator and the top holders' recent activity (display only: it does not feed the verdict)
- Displays a verdict — **SAFE / CAUTION / DANGER / RUG** — with a 1000-point composite score

Not claimed: that a SAFE verdict means a token cannot rug, or that the verdicts have a measured accuracy (see [How the verdicts are checked](#how-the-verdicts-are-checked)).

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
| L1 | DexScreener | 0.20 | Liquidity, volume, price changes, links the project registered, bonding-curve state |
| L2 | RugCheck | 0.20 | RugCheck's risk list (creator history, permanent delegate, unlocked LP, mutable metadata…), LP locked % |
| L3 | GoPlus | 0.20 | Mint/freeze authority (cross-check of the chain), balance-mutable / non-transferable / closable / transfer hook, LP burn per pool |
| L4 | Helius | 0.20 | Holder distribution (top 1 / top 10), creator history; the chain is also where the authorities are read |
| L5 | Solscan | 0.10 | Optional: needs a paid Solscan Pro key. Without one the layer reports nothing and is not counted as a source |
| L6 | Chart | 0.10 | OHLCV pattern analysis (pump, dump, wash, stair-step) |
| L8 | CrossValidation | — | Cross-source conflict detection (post-score multiplier) |

A layer only counts as a source when it answered **and read something**. Layers 1–6 contribute weighted trust scores to the geometric mean. Layer 8 (CrossValidation) produces flags and penalty multipliers but does not feed the geometric mean directly.

**SAFE** needs, together: no warning or critical flag on the token, at least 4 sources (5 for the plain 900+ rule), a score of 750 or more, and no hard safe-block reason (an active authority, an unlocked LP, a concentration…). A visible price-pump flag also keeps a token out of SAFE. A single critical flag makes it DANGER at best; three warnings do too.

### Cache versioning

The scan-result Redis cache is keyed by `antares:${ENGINE_VERSION}:${ca}`, where `ENGINE_VERSION` combines a manual tag with an FNV-1a fingerprint of the numeric scoring constants (`LAYER_WEIGHTS`, `XV_PENALTY_*`, `TRUST_FLOOR`, `ESTABLISHED_*`). A change to those constants flips the fingerprint by itself, so cached scores are bypassed and naturally TTL out (at most 30 minutes). **A change to the verdict *logic* (a threshold written inside `layers.ts`, a severity, the order of the pipeline) does not touch the fingerprint: bump `ENGINE_VERSION_MANUAL`.**

See `api/_lib/constants.ts` for the canonical version + fingerprint logic.

---

## How the verdicts are checked

**No accuracy figure is published, because none is measured yet.** The numbers that used to be here ("539 tokens, 100 % acceptable, 0 false negatives") came from a test that re-read verdicts stored in fixtures and never ran the engine, so it could not fail and proved nothing. It has been removed from this page.

What exists:

- **A regression replay** (`npm run replay`, part of `npm test`): the real `/api/scan` engine runs offline on the recorded upstream responses of real tokens, the clock set to the moment of the capture. A change to any schema, fetcher, layer or threshold that moves a verdict, a score or a flag is reported token by token. This proves the engine is **stable**, not that it is **right**. Method and limits: [`scripts/replay/README.md`](./scripts/replay/README.md).
- **Tests on real upstream shapes**: the fixtures of `__tests__/fixtures/upstream-real/` are real RugCheck, GoPlus and Helius answers, not invented contracts.
- **An end-to-end contract test** (`e2e/api-engine-contract.spec.ts`) that scans well-known tokens on the deployment of each pull request and checks the authorities read from the chain.

What is **not** measured yet: how many rugs are flagged *before* they happen, and how many sound tokens are flagged by mistake. That needs outcomes (what became of each scanned token days later), not labels read off a chart; until it exists, treat a verdict as a risk reading built from public data, not as a guarantee.

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
  rugs.ts                    — GET /api/rugs                    Wall of Shame: recent RUG verdicts backed by evidence
  health.ts                  — GET /api/health                  Liveness probe

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
    verdict-history.ts       — Per-CA verdict-over-time
    rugdb.ts                 — Wall of Shame index (RUG verdict + a critical flag that is evidence, 90 days)

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
- Rate limiting: Upstash Ratelimit, keyed by network (IPv6 as its /64) and install id: 60 req/60s and a burst of 20 req/10s per install, 600 req/60s per network whatever the install id, and 60 cold scans/60s per network (`api/_lib/middleware.ts`)
- Crypto checkout: NOWPayments hosted checkout (200+ cryptos, HMAC-SHA512 IPN)
- Auth: scrypt password hashing + HMAC-SHA256 JWT sessions (30-day TTL)
- Data sources: DexScreener · RugCheck · GoPlus · Helius · GeckoTerminal, and Solscan Pro when a paid key is configured (optional)
- Observability: Sentry (`@sentry/node` + `@sentry/browser`)
- AI synthesis: Google Gemini 2.5 Flash (optional, scans work without it)
- Tests: Vitest (unit tests, real upstream fixtures, regression replay) + Playwright e2e
- Security: account endpoints answer only the first-party website and the allow-listed extension IDs (CORS), rate-limited endpoints, scrubbed secret logs,
  TruffleHog secret scan in CI, Dependabot dependency updates

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

Regression replay (the real engine on recorded upstream responses, see `scripts/replay/README.md`):
```bash
npm run replay           # the recorded real scans (also part of npm test)
npm run replay:update    # after an intended change: rewrite the reference file, then review its diff
npm run replay:capture   # record real scans (needs the API keys held by the Vercel project, see the README of the replay)
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
SOLSCAN_API_KEY=...                  # Solscan Pro, OPTIONAL and paid (Layer 5); without it the layer reports nothing
GOPLUS_APP_KEY=...                   # GoPlus app key (with the secret below: authenticated, higher limits)
GOPLUS_APP_SECRET=...                # GoPlus app secret (both are needed; anonymous tier otherwise)
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
