# Antares — Anti-Scam Scanner for Solana

[![CI](https://github.com/COMEALAMAISONGROUPE/antares-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/COMEALAMAISONGROUPE/antares-extension/actions/workflows/ci.yml)

**Antares** is a Chrome extension that automatically detects the Solana token address on any page you visit and runs a real-time multi-source security scan.

## What it does

- Detects mint/freeze authority, honeypots, blacklists and proxy contracts (GoPlus)
- Checks LP burn/lock status, bundler activity, and holder concentration (RugCheck)
- Analyses on-chain holder distribution (Helius)
- Detects chart manipulation patterns: parabolic pumps, blow-off tops, wash trading (DexScreener OHLCV)
- Verifies on-chain age, holder count, and trading patterns (Solscan)
- Identifies copycat / brand-imitation tokens
- Cross-validates data across sources to flag conflicts
- Displays a verdict — **SAFE / CAUTION / DANGER / RUG** — with a score out of 1000

## Scoring

Score starts at **1000** and is reduced by weighted penalties across **8 layers**:

| Layer | Source | Weight | What it checks |
|---|---|---|---|
| L1 | DexScreener | 0.18 | Liquidity, volume, price changes, social presence |
| L2 | RugCheck | 0.18 | LP burn/lock, bundler activity, metadata, top holders |
| L3 | GoPlus | 0.18 | Honeypot, mint/freeze authority, tax, proxy contracts |
| L4 | Helius | 0.18 | On-chain holder distribution (top 1 / top 10) |
| L5 | Solscan | 0.10 | Holder count, token age, wash trading patterns |
| L6 | Chart | 0.10 | OHLCV pattern analysis (pump, dump, wash, stair-step) |
| L7 | Identity | 0.08 | Copycat / brand imitation detection |
| L8 | CrossValidation | — | Cross-source conflict detection (post-score multiplier) |

Layers 1–6 contribute weighted trust scores to the geometric mean. Layer 7 (Identity) contributes with weight 0.08. Layer 8 (CrossValidation) produces flags and penalty multipliers but does not feed the geometric mean directly.

A token can only reach **SAFE** (score ≥ 850) if it passes all critical gates regardless of score.

**Scoring version:** `7.1.0`

## Architecture

```
api/
  scan.ts          — Main serverless handler (GET /api/scan?ca=<mint>)
  _lib/
    fetchers.ts    — External API data fetching (DexScreener, RugCheck, GoPlus, Helius, Solscan)
    layers.ts      — 8 analysis layer functions (pure, no side effects)
    scoring.ts     — Geometric-mean scoring engine with cross-validation penalties
    pipeline.ts    — Post-layer flags, safe-gate, established bonus, verdict
    constants.ts   — All constants: weights, brands, thresholds, API bases
    types.ts       — TypeScript type definitions
    helpers.ts     — Re-exports from math.ts and http.ts + utility/guard functions
    math.ts        — Numeric helpers: asNumber, _mean, _std, _pct
    http.ts        — Typed HTTP: fetchJson<T>, fetchJsonPost<T>, withTimeout
    middleware.ts  — CORS (origin whitelist), rate limiting, input validation
    cache.ts       — Upstash Redis caching layer
privacy.ts         — GET /privacy — Privacy Policy page (required by Chrome Web Store)
token.html         — Static Full Analysis page served at /token.html?ca=<mint>

background.ts      — Chrome extension service worker (MV3, keepalive via alarms)
popup.tsx          — Extension popup UI (recent scans, stealth toggle)
options.tsx        — Extension options page (stealth mode, auto-rescan preferences)
```

## API

```
GET /api/scan?ca=<solana_mint_address>
```

Returns JSON with `score`, `risk` (SAFE/CAUTION/DANGER/RUG), `flags`, and per-layer details.

Example:
```bash
curl "https://antares-extension.vercel.app/api/scan?ca=So11111111111111111111111111111111111111112"
```

## Stack

- Extension: [Plasmo](https://plasmo.com) + TypeScript
- Backend API: Vercel Serverless (Node 22)
- Rate limiting: Upstash Redis (sliding window 30 req/60s + burst 5 req/10s)
- Data sources: DexScreener · RugCheck · GoPlus · Helius · Solscan · GeckoTerminal
- CI: GitHub Actions (Node 22, Vitest, TypeScript strict, coverage thresholds)
- Security: CORS origin whitelist, CodeQL weekly scanning, Dependabot alerts, Sentry

## Development

```bash
npm ci
npm run dev        # extension hot-reload
npm run build      # production build
npm run test       # run all tests (Vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
```

### Environment variables (Vercel)

Copy `.env.example` to `.env.local` and fill in your values:

```
HELIUS_API_KEY=...              # Required
UPSTASH_REDIS_REST_URL=...      # Required
UPSTASH_REDIS_REST_TOKEN=...    # Required
SOLSCAN_API_KEY=...             # Optional (L5 Solscan Pro)
SENTRY_DSN=...                  # Optional (error monitoring)
```

## Contributing

1. Clone the repo and run `npm ci`
2. Make your changes
3. Run `npm run test` — all tests must pass
4. Run `npx tsc --noEmit` — zero type errors
5. Run `npm run lint` — zero lint errors
6. One commit per logical block, message format: `feat(scope): description`

## License

MIT
